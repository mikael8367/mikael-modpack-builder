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

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const MAX_LINKS = 999999;
const MAX_FILE_BYTES = 150 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const p = ip.split(".").map(Number);
    return p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || p[0] === 0;
  }
  if (net.isIP(ip) === 6) {
    const s = ip.toLowerCase();
    return s === "::1" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe80:");
  }
  return false;
}

async function validatePublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("URL inválida."); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("A URL precisa usar http:// ou https://.");
  if (!u.hostname) throw new Error("URL sem domínio.");
  if (["localhost", "localhost.localdomain"].includes(u.hostname.toLowerCase())) throw new Error("Domínio local não permitido.");
  if (net.isIP(u.hostname)) {
    if (isPrivateIp(u.hostname)) throw new Error("IP privado/local não permitido.");
  } else {
    const addresses = await dns.lookup(u.hostname, { all: true });
    if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) throw new Error("O domínio aponta para um endereço privado/local.");
  }
  return u;
}

async function requestFile(rawUrl) {
  let current = rawUrl;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const url = await validatePublicUrl(current);
    const response = await axios.get(url.toString(), {
      responseType: "stream",
      maxRedirects: 0,
      timeout: 30000,
      validateStatus: s => (s >= 200 && s < 300) || [301,302,303,307,308].includes(s)
    });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.location;
      response.data.destroy();
      if (!location) throw new Error("Redirecionamento sem destino.");
      current = new URL(location, url).toString();
      continue;
    }
    const length = Number(response.headers["content-length"] || 0);
    if (length > MAX_FILE_BYTES) {
      response.data.destroy();
      throw new Error(`Arquivo maior que ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`);
    }
    return { response, url };
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
  if (!minecraftVersion) return res.status(400).json({ error: "Escolha a versão do Minecraft." });
  if (!modLoader) return res.status(400).json({ error: "Escolha o modloader." });
  if (!links.length) return res.status(400).json({ error: "Adicione pelo menos um link." });
  if (links.length > MAX_LINKS) return res.status(400).json({ error: `Máximo de ${MAX_LINKS} links por ZIP.` });
  const cleanLinks = links.map(x => String(x || "").trim()).filter(Boolean);
  const uniqueLinks = [...new Set(cleanLinks)];
  if (uniqueLinks.length !== cleanLinks.length) return res.status(400).json({ error: "Há links repetidos na lista." });

  const id = crypto.randomUUID();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mikael-modpack-"));
  const job = {
    tempDir, zipPath: null, zipName: null, status: "running", clients: new Set(),
    progress: { status: "starting", current: 0, total: uniqueLinks.length, percent: 0, filename: "", message: "Iniciando..." }
  };
  jobs.set(id, job);
  res.json({ id });

  (async () => {
    const files = [];
    let total = 0;
    try {
      for (let i = 0; i < uniqueLinks.length; i++) {
        const raw = uniqueLinks[i];
        updateJob(job, { status: "downloading", current: i + 1, filename: `Mod ${i + 1}`, percent: Math.round(i / uniqueLinks.length * 100), message: `Baixando mod ${i + 1} de ${uniqueLinks.length}...` });
        const { response, url } = await requestFile(raw);
        const disposition = String(response.headers["content-disposition"] || "");
        const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^;"]+)/i);
        const fromHeader = match ? match[1].trim() : "";
        const filename = uniqueName(safeFileName(fromHeader || url.pathname, i), new Set(files.map(f => f.filename.toLowerCase())));
        const target = path.join(tempDir, `${i}-${filename}`);
        let bytes = 0;
        const expected = Number(response.headers["content-length"] || 0);
        response.data.on("data", chunk => {
          bytes += chunk.length; total += chunk.length;
          const filePercent = expected ? bytes / expected : 0;
          const percent = Math.min(99, Math.round(((i + filePercent) / uniqueLinks.length) * 100));
          updateJob(job, { filename, percent, message: `Baixando ${filename} • ${i + 1}/${uniqueLinks.length}` });
          if (bytes > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) response.data.destroy(new Error("Limite de tamanho excedido."));
        });
        await pipeline(response.data, fs.createWriteStream(target));
        if (bytes > MAX_FILE_BYTES) throw new Error(`O arquivo ${filename} ultrapassa 150 MB.`);
        if (total > MAX_TOTAL_BYTES) throw new Error("O pacote ultrapassa 500 MB.");
        files.push({ filename, target, source: raw });
        updateJob(job, { current: i + 1, percent: Math.round(((i + 1) / uniqueLinks.length) * 85), message: `✓ ${filename} instalado` });
      }

      updateJob(job, { status: "zipping", percent: 90, message: "📦 Criando o ZIP..." });
      const safeVersion = minecraftVersion.replace(/[^0-9A-Za-z._-]/g, "_");
      const zipName = `Mikael_Modpack_${safeVersion}.zip`;
      const zipPath = path.join(tempDir, zipName);
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 6 } });
      const manifest = { format:"mikael-modpack-links", version:1, minecraft:minecraftVersion, modLoader, modLoaderVersion:loaderVersion || null, files:files.map(f=>({file:f.filename,source:f.source})) };
      for (const file of files) archive.file(file.target, { name: `mods/${file.filename}` });
      archive.append(JSON.stringify(manifest,null,2), { name:"mikael-modpack.json" });
      archive.append(JSON.stringify({minecraft:minecraftVersion,modLoader,modLoaderVersion:loaderVersion||null,note:"Arquivos adicionados a partir das URLs fornecidas pelo usuário."},null,2), { name:"modpack-info.json" });
      await new Promise((resolve,reject) => { output.on("close",resolve); archive.on("error",reject); archive.pipe(output); archive.finalize(); });
      job.zipPath = zipPath; job.zipName = zipName; job.status = "done";
      updateJob(job, { status:"done", percent:100, message:"✅ Todos os mods foram instalados e o ZIP está pronto!" });
    } catch (e) {
      job.status = "error";
      updateJob(job, { status:"error", message:"❌ " + (e.message || "Não foi possível gerar o ZIP."), percent:0 });
      await fsp.rm(tempDir, { recursive:true, force:true }).catch(()=>{});
    }
  })();
});
app.listen(PORT, "0.0.0.0", () => console.log(`Mikael Modpack Builder em ${PORT}`));