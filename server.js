const express = require("express");
const axios = require("axios");
const archiver = require("archiver");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");
const fs = require("fs");
const fsp = require("fs").promises;
const os = require("os");
const { pipeline } = require("stream/promises");
const crypto = require("crypto");
const jobs = new Map();
const uploads = new Map();
let activeBuilds = 0;
const MAX_CONCURRENT_BUILDS = 2;

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;
const MAX_LINKS = 999999;
const MAX_FILE_BYTES = 150 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_UPLOAD_FILES = 999;
const CURSEFORGE_API_KEY = String(process.env.CURSEFORGE_API_KEY || "").trim();
const CURSEFORGE_API_BASE = "https://api.curseforge.com/v1";
const CURSEFORGE_GAME_ID = 432;

const http = require("http");
const https = require("https");
const multer = require("multer");
const upload = multer({ dest: path.join(os.tmpdir(), "mikael-uploads-"), limits: { fileSize: MAX_FILE_BYTES, files: MAX_UPLOAD_FILES } });
app.post("/api/upload-files", upload.array("files"), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "Nenhum arquivo foi enviado." });
  const uploadTotal = files.reduce((sum, f) => sum + Number(f.size || 0), 0);
  if (uploadTotal > MAX_TOTAL_BYTES) {
    await Promise.all(files.map(f => f.path ? fsp.rm(f.path, { force: true }).catch(() => {}) : Promise.resolve()));
    return res.status(400).json({ error: "Os arquivos selecionados ultrapassam 500 MB no total." });
  }
  const invalid = files.filter(f => !/\.(jar|zip)$/i.test(f.originalname || ""));
  if (invalid.length) {
    await Promise.all(files.map(f => f.path ? fsp.rm(f.path, { force: true }).catch(() => {}) : Promise.resolve()));
    return res.status(400).json({ error: "Envie somente arquivos .jar ou .zip." });
  }
  const id = crypto.randomUUID();
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mikael-local-"));
  const saved = [];
  const used = new Set();
  try {
    for (const f of files) {
      const safe = uniqueName(safeFileName(f.originalname, saved.length), used);
      const target = path.join(dir, safe);
      await fsp.rename(f.path, target);
      saved.push({ filename: safe, path: target });
    }
    uploads.set(id, { dir, files: saved, created: Date.now(), inUse: 0 });
    res.json({ id, files: saved.map(f => f.filename) });
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    res.status(500).json({ error: e.message || "Falha ao receber arquivos." });
  }
});



function isPrivateIp(ip) {
  let s = String(ip || "").toLowerCase().trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const v = net.isIP(s);
  if (v === 4) {
    const p = s.split(".").map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && (p[1] === 0 || p[1] === 168)) ||
      (p[0] === 198 && p[1] >= 18 && p[1] <= 19);
  }
  if (v === 6) {
    if (s === "::" || s === "::1") return true;
    if (s.startsWith("fc") || s.startsWith("fd") || /^fe[89ab]/.test(s) || s.startsWith("ff")) return true;
    if (s.startsWith("::ffff:")) {
      const mapped = s.slice(7);
      if (net.isIP(mapped) === 4) return isPrivateIp(mapped);
    }
  }
  return false;
}

async function validatePublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("URL inválida."); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("A URL precisa usar http:// ou https://.");
  if (!u.hostname) throw new Error("URL sem domínio.");
  const hostname = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (["localhost", "localhost.localdomain", "localhost6"].includes(hostname)) throw new Error("Domínio local não permitido.");
  const literalFamily = net.isIP(hostname);
  let resolved;
  if (literalFamily) {
    if (isPrivateIp(hostname)) throw new Error("IP privado/local não permitido.");
    resolved = { address: hostname, family: literalFamily };
  } else {
    const addresses = await dns.lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) throw new Error("O domínio aponta para um endereço privado/local.");
    resolved = addresses[0];
  }
  return { url: u, resolved };
}

function isCurseForgeHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "curseforge.com" || h.endsWith(".curseforge.com") || h === "forgecdn.net" || h.endsWith(".forgecdn.net");
}

async function curseForgeApiGet(pathname, params = {}) {
  if (!CURSEFORGE_API_KEY) throw new Error("CurseForge agora exige uma API Key para downloads automatizados. Configure CURSEFORGE_API_KEY no Render.");
  const response = await axios.get(CURSEFORGE_API_BASE + pathname, {
    proxy: false,
    timeout: 20000,
    params,
    headers: { Accept: "application/json", "x-api-key": CURSEFORGE_API_KEY, "User-Agent": "Mikael-Modpack-Builder/3.1" }
  });
  return response.data && response.data.data;
}

async function resolveCurseForgeUrl(rawUrl, context = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { return rawUrl; }
  if (!CURSEFORGE_API_KEY || !isCurseForgeHost(u.hostname)) return rawUrl;
  const parts = u.pathname.split("/").filter(Boolean);
  const modIndex = parts.indexOf("mc-mods");
  if (modIndex < 0 || !parts[modIndex + 1]) return rawUrl;
  const slug = parts[modIndex + 1];
  const downloadIndex = parts.indexOf("download") + 1;
  const fileId = downloadIndex > 0 && /^\d+$/.test(parts[downloadIndex]) ? Number(parts[downloadIndex]) : null;
  const mod = await curseForgeApiGet("/mods/search", { gameId: CURSEFORGE_GAME_ID, slug, pageSize: 1 });
  const found = Array.isArray(mod) ? mod[0] : null;
  if (!found || !found.id) throw new Error("Mod CurseForge não encontrado: " + slug);
  if (fileId) {
    const downloadUrl = await curseForgeApiGet("/mods/" + found.id + "/files/" + fileId + "/download-url");
    if (!downloadUrl) throw new Error("Arquivo CurseForge " + fileId + " não possui URL de download.");
    return String(downloadUrl);
  }
  const loaderMap = { Forge: 1, Fabric: 4, LiteLoader: 3, Quilt: 5, NeoForge: 6 };
  const loaderType = loaderMap[String(context.modLoader || "")];
  const files = await curseForgeApiGet("/mods/" + found.id + "/files", {
    gameVersion: String(context.minecraftVersion || ""),
    modLoaderType: loaderType,
    pageSize: 50,
    sortField: 3,
    sortOrder: "desc"
  });
  const candidates = Array.isArray(files)
    ? files.filter(f => f && f.isAvailable !== false && Array.isArray(f.gameVersions) && f.gameVersions.includes(String(context.minecraftVersion || "")))
    : [];
  const selected = candidates.find(f => Number(f.releaseType) === 1) || candidates[0];
  if (!selected) throw new Error("Nenhum arquivo compatível de " + slug + " foi encontrado para Minecraft " + (context.minecraftVersion || "selecionado") + ".");
  if (!selected.downloadUrl) throw new Error("O arquivo de " + slug + " não possui URL de download disponível.");
  return String(selected.downloadUrl);
}

async function requestFile(rawUrl, context = {}) {
  let current = await resolveCurseForgeUrl(rawUrl, context);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const checked = await validatePublicUrl(current);
    const agentOptions = {
      keepAlive: false,
      lookup: (_hostname, options, cb) => {
        const result = { address: checked.resolved.address, family: checked.resolved.family };
        if (options && options.all) return cb(null, [result]);
        return cb(null, result.address, result.family);
      }
    };
    const headers = {
      "User-Agent": "Mozilla/5.0 (compatible; Mikael-Modpack-Builder/3.1)",
      Accept: "*/*"
    };
    if (CURSEFORGE_API_KEY && checked.url.hostname.toLowerCase().endsWith("forgecdn.net")) headers["x-api-key"] = CURSEFORGE_API_KEY;
    let response;
    try {
      response = await axios.get(checked.url.toString(), {
        proxy: false,
        responseType: "stream",
        maxRedirects: 0,
        timeout: 30000,
        headers,
        httpAgent: checked.url.protocol === "http:" ? new http.Agent(agentOptions) : undefined,
        httpsAgent: checked.url.protocol === "https:" ? new https.Agent(agentOptions) : undefined,
        validateStatus: s => (s >= 200 && s < 300) || [301,302,303,307,308].includes(s)
      });
    } catch (err) {
      const status = err && err.response && err.response.status;
      if ((status === 401 || status === 403) && isCurseForgeHost(checked.url.hostname)) {
        throw new Error("CurseForge recusou o download (HTTP " + status + "). Configure uma CURSEFORGE_API_KEY válida no Render; desde 16/07/2026 a CDN do CurseForge exige autenticação para downloads automatizados.");
      }
      throw err;
    }
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.location;
      response.data.destroy();
      if (!location) throw new Error("Redirecionamento sem destino.");
      current = new URL(location, checked.url).toString();
      continue;
    }
    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    if (contentType.includes("text/html")) {
      response.data.destroy();
      throw new Error("O link não entregou um arquivo. Para CurseForge, use uma URL de download do arquivo ou configure CURSEFORGE_API_KEY para o resolvedor automático.");
    }
    const length = Number(response.headers["content-length"] || 0);
    if (length > MAX_FILE_BYTES) {
      response.data.destroy();
      throw new Error("Arquivo maior que " + Math.round(MAX_FILE_BYTES / 1024 / 1024) + " MB.");
    }
    return { response, url: checked.url };
  }
  throw new Error("Muitos redirecionamentos.");
}

function safeFileName(name, index) {
  let n = (name || "").split("?")[0].split("#").pop().split("/").pop().trim();
  try { n = decodeURIComponent(n); } catch {}
  n = n.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 180);
  if (!n || n === "." || n === "..") n = `mod_${index + 1}.jar`;
  if (!/\.[a-z0-9]{1,8}$/i.test(n)) n += ".jar";
  return n;
}

function uniqueName(name, used) {
  const key = name.toLowerCase();
  if (!used.has(key)) { used.add(key); return name; }
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 2;
  while (used.has(`${base}_${i}${ext}`.toLowerCase())) i++;
  const out = `${base}_${i}${ext}`;
  used.add(out.toLowerCase());
  return out;
}

app.get("/api/status", (req, res) => res.json({ ok: true, maxLinks: MAX_LINKS, maxFileMB: MAX_FILE_BYTES / 1024 / 1024, maxTotalMB: MAX_TOTAL_BYTES / 1024 / 1024 }));

const cleanupTimer = setInterval(async () => {
  const now = Date.now();
  for (const [id, item] of uploads) {
    if (!item.inUse && now - item.created > UPLOAD_TTL_MS) {
      uploads.delete(id);
      await fsp.rm(item.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  for (const [id, job] of jobs) {
    if (now - job.created > JOB_TTL_MS) {
      jobs.delete(id);
      await fsp.rm(job.tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}, 5 * 60 * 1000);
cleanupTimer.unref();

app.get("/api/build/:id/events", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const send = () => res.write(`data: ${JSON.stringify(job.progress)}\n\n`);
  job.clients.add(res);
  send();
  const timer = setInterval(send, 500);
  req.on("close", () => { clearInterval(timer); job.clients.delete(res); });
});

function updateJob(job, data) {
  job.progress = { ...job.progress, ...data };
  for (const client of job.clients) {
    try { client.write(`data: ${JSON.stringify(job.progress)}\n\n`); } catch {}
  }
}

app.get("/api/build/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done" || !job.zipPath) return res.status(404).json({ error: "ZIP ainda não está pronto." });
  res.download(job.zipPath, job.zipName, async () => {
    if (job.clients.size === 0) {
      await fsp.rm(job.tempDir, { recursive: true, force: true }).catch(() => {});
      jobs.delete(req.params.id);
    }
  });
});

app.post("/api/build", async (req, res) => {
  const minecraftVersion = String(req.body.minecraftVersion || "").trim();
  const modLoader = String(req.body.modLoader || "").trim();
  const loaderVersion = String(req.body.loaderVersion || "").trim();
  const links = Array.isArray(req.body.links) ? req.body.links : [];
  const uploadId = String(req.body.uploadId || "").trim();
  if (!minecraftVersion) return res.status(400).json({ error: "Escolha a versão do Minecraft." });
  if (!modLoader) return res.status(400).json({ error: "Escolha o modloader." });
  if (activeBuilds >= MAX_CONCURRENT_BUILDS) return res.status(429).json({ error: "O servidor já está processando 2 modpacks. Aguarde um terminar e tente novamente." });
  if (!links.length && !uploadId) return res.status(400).json({ error: "Adicione pelo menos um link ou arquivo." });
  if (links.length > MAX_LINKS) return res.status(400).json({ error: `Máximo de ${MAX_LINKS} links por ZIP.` });
  const cleanLinks = links.map(x => String(x || "").trim()).filter(Boolean);
  const uniqueLinks = [...new Set(cleanLinks)];
  if (uniqueLinks.length !== cleanLinks.length) return res.status(400).json({ error: "Há links repetidos na lista." });

  let localUpload = null;
  let tempDir;
  const id = crypto.randomUUID();

  try {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mikael-modpack-"));
    const job = {
      tempDir, zipPath: null, zipName: null, status: "running", created: Date.now(), clients: new Set(),
      progress: { status: "starting", current: 0, total: uniqueLinks.length, percent: 0, filename: "", message: "Iniciando..." }
    };
    jobs.set(id, job);
    localUpload = uploadId ? uploads.get(uploadId) : null;
    if (uploadId && !localUpload) {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      jobs.delete(id);
      return res.status(400).json({ error: "Arquivos locais expiraram. Adicione-os novamente." });
    }
    if (localUpload) localUpload.inUse = (localUpload.inUse || 0) + 1;
    activeBuilds += 1;
    res.json({ id });

    (async () => {
      const files = [];
      let total = 0;
      try {
        if (localUpload) {
          job.progress.total = uniqueLinks.length + localUpload.files.length;
          for (const f of localUpload.files) {
            const target = path.join(tempDir, f.filename);
            await fsp.copyFile(f.path, target);
            const st = await fsp.stat(target);
            total += st.size;
            if (total > MAX_TOTAL_BYTES) throw new Error("O pacote ultrapassa 500 MB.");
            files.push({ filename: f.filename, target, source: "arquivo local" });
            const current = files.length;
            updateJob(job, {
              current, filename: f.filename,
              percent: Math.min(85, Math.round(current / Math.max(1, job.progress.total) * 85)),
              message: `✓ ${f.filename} adicionado`
            });
          }
        }

        for (let i = 0; i < uniqueLinks.length; i++) {
          const raw = uniqueLinks[i];
          const current = files.length + 1;
          updateJob(job, {
            status: "downloading", current, filename: `Mod ${i + 1}`,
            percent: Math.round((current - 1) / Math.max(1, job.progress.total) * 85),
            message: `Baixando mod ${i + 1} de ${uniqueLinks.length}...`
          });
          const { response, url } = await requestFile(raw, { minecraftVersion, modLoader });
          const disposition = String(response.headers["content-disposition"] || "");
          const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^;"]+)/i);
          const fromHeader = match ? match[1].trim() : "";
          const used = new Set(files.map(f => f.filename.toLowerCase()));
          const filename = uniqueName(safeFileName(fromHeader || url.pathname, i), used);
          const target = path.join(tempDir, `${i}-${filename}`);
          let bytes = 0;
          const expected = Number(response.headers["content-length"] || 0);
          response.data.on("data", chunk => {
            bytes += chunk.length;
            total += chunk.length;
            const filePercent = expected ? bytes / expected : 0;
            const percent = Math.min(85, Math.round(((current - 1 + filePercent) / Math.max(1, job.progress.total)) * 85));
            updateJob(job, { filename, percent, message: `Baixando ${filename} • ${i + 1}/${uniqueLinks.length}` });
            if (bytes > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) response.data.destroy(new Error("Limite de tamanho excedido."));
          });
          await pipeline(response.data, fs.createWriteStream(target));
          if (bytes > MAX_FILE_BYTES) throw new Error(`O arquivo ${filename} ultrapassa 150 MB.`);
          if (total > MAX_TOTAL_BYTES) throw new Error("O pacote ultrapassa 500 MB.");
          files.push({ filename, target, source: raw });
          updateJob(job, {
            current: files.length,
            percent: Math.min(85, Math.round(files.length / Math.max(1, job.progress.total) * 85)),
            message: `✓ ${filename} instalado`
          });
        }

        updateJob(job, { status: "zipping", percent: 90, message: "📦 Criando o ZIP..." });
        const safeVersion = minecraftVersion.replace(/[^0-9A-Za-z._-]/g, "_");
        const zipName = `Mikael_Modpack_${safeVersion}.zip`;
        const zipPath = path.join(tempDir, zipName);
        const output = fs.createWriteStream(zipPath);
        const archive = archiver("zip", { zlib: { level: 6 } });
        const manifest = {
          format: "mikael-modpack-links", version: 1, minecraft: minecraftVersion,
          modLoader, modLoaderVersion: loaderVersion || null,
          files: files.map(f => ({ file: f.filename, source: f.source }))
        };
        for (const file of files) archive.file(file.target, { name: `mods/${file.filename}` });
        archive.append(JSON.stringify(manifest, null, 2), { name: "mikael-modpack.json" });
        archive.append(JSON.stringify({
          minecraft: minecraftVersion, modLoader, modLoaderVersion: loaderVersion || null,
          note: "Arquivos adicionados a partir das URLs fornecidas pelo usuário."
        }, null, 2), { name: "modpack-info.json" });
        await new Promise((resolve, reject) => {
          output.on("close", resolve);
          output.on("error", reject);
          archive.on("error", reject);
          archive.pipe(output);
          archive.finalize();
        });
        job.zipPath = zipPath;
        job.zipName = zipName;
        job.status = "done";
        updateJob(job, { status: "done", percent: 100, current: job.progress.total, message: "✅ Todos os mods foram instalados e o ZIP está pronto!" });
      } catch (e) {
        job.status = "error";
        updateJob(job, { status: "error", message: "❌ " + (e.message || "Não foi possível gerar o ZIP."), percent: 0 });
        await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      } finally {
        activeBuilds = Math.max(0, activeBuilds - 1);
        if (localUpload) {
          localUpload.inUse = Math.max(0, (localUpload.inUse || 1) - 1);
          if (!localUpload.inUse) {
            uploads.delete(uploadId);
            await fsp.rm(localUpload.dir, { recursive: true, force: true }).catch(() => {});
          }
        }
      }
    })();
  } catch (e) {
    jobs.delete(id);
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return res.status(500).json({ error: e.message || "Não foi possível iniciar a geração." });
  }
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: "Um dos arquivos ultrapassa 150 MB.",
      LIMIT_FILE_COUNT: `Você pode enviar no máximo ${MAX_UPLOAD_FILES} arquivos por vez.`,
      LIMIT_UNEXPECTED_FILE: "Campo de upload inválido."
    };
    return res.status(400).json({ error: messages[err.code] || "Falha no upload." });
  }
  return res.status(400).json({ error: err.message || "Falha na requisição." });
});

app.listen(PORT, "0.0.0.0", () => console.log(`Mikael Modpack Builder em ${PORT}`));