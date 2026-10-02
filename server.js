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
const MAX_DOWNLOAD_RETRIES = 3;
const RETRY_BASE_MS = 700;
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
      (p[0] === 192 && p[1] === 0) ||
      (p[0] === 192 && p[1] === 2) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 198 && p[1] >= 18 && p[1] <= 19) ||
      (p[0] === 198 && p[1] === 51 && p[2] === 100) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113) ||
      p[0] >= 224;
  }
  if (v === 6) {
    if (s === "::" || s === "::1") return true;
    if (s.startsWith("fc") || s.startsWith("fd") || /^fe[89ab]/.test(s) || s.startsWith("ff")) return true;
    if (s.startsWith("2001:db8:")) return true;
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
    resolved = addresses.find(a => Number(a.family) === 4) || addresses[0];
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
    headers: { Accept: "application/json", "x-api-key": CURSEFORGE_API_KEY, "User-Agent": "Mikael-Modpack-Builder/4.3" }
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
    const file = await curseForgeApiGet("/mods/" + found.id + "/files/" + fileId);
    if (!file || !file.id) throw new Error("Arquivo CurseForge " + fileId + " não foi encontrado.");
    const wantedVersion = String(context.minecraftVersion || "").trim();
    if (wantedVersion && (!Array.isArray(file.gameVersions) || !file.gameVersions.includes(wantedVersion))) {
      throw new Error("Incompatível: o arquivo CurseForge " + fileId + " não suporta Minecraft " + wantedVersion + ".");
    }
    const downloadUrl = file.downloadUrl || await curseForgeApiGet("/mods/" + found.id + "/files/" + fileId + "/download-url");
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

function isModrinthHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "modrinth.com" || h === "www.modrinth.com" || h.endsWith(".modrinth.com") || h === "cdn.modrinth.com" || h.endsWith(".cdn.modrinth.com");
}

function modrinthLoader(loader) {
  const map = {
    Forge: "forge",
    Fabric: "fabric",
    NeoForge: "neoforge",
    Quilt: "quilt",
    LiteLoader: "liteloader"
  };
  return map[String(loader || "")] || "";
}

async function resolveModrinthUrl(rawUrl, context = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { return rawUrl; }
  if (!isModrinthHost(u.hostname)) return rawUrl;

  // Links diretos do CDN do Modrinth já apontam para o arquivo.
  // O parâmetro mr_download_reason é usado pelo próprio Modrinth nas páginas
  // de download e evita que o CDN trate a requisição como uma navegação HTML.
  if (u.hostname.toLowerCase().includes("cdn.modrinth.com")) {
    if (!u.searchParams.has("mr_download_reason")) {
      u.searchParams.set("mr_download_reason", "mikael-modpack-builder");
    }
    return u.toString();
  }

  const parts = u.pathname.split("/").filter(Boolean);
  const projectKinds = new Set(["mod", "plugin", "datapack", "resourcepack", "shader", "modpack"]);
  const kindIndex = parts.findIndex(p => projectKinds.has(p.toLowerCase()));
  const versionIndex = parts.findIndex(p => p.toLowerCase() === "version");

  const loader = modrinthLoader(context.modLoader);
  const selectedMinecraft = String(context.minecraftVersion || "").trim();
  const selectedLoader = String(context.modLoader || "").trim();
  let versions;
  let projectData = null;

  if (versionIndex >= 0 && parts[versionIndex + 1]) {
    const versionId = decodeURIComponent(parts[versionIndex + 1]);
    try {
      const response = await axios.get("https://api.modrinth.com/v2/version/" + encodeURIComponent(versionId), {
        proxy: false, timeout: 20000,
        headers: { Accept: "application/json", "User-Agent": "Mikael-Modpack-Builder/4.3" }
      });
      const version = response.data;
      if (!version || !version.id) throw new Error("Versão do Modrinth inválida.");
      if (version.status && version.status !== "listed") throw new Error("A versão do Modrinth " + versionId + " não está publicada/listada.");
      if (selectedMinecraft && (!Array.isArray(version.game_versions) || !version.game_versions.includes(selectedMinecraft))) {
        throw new Error("Incompatível: a versão do Modrinth " + versionId + " não suporta Minecraft " + selectedMinecraft + ".");
      }
      if (loader && (!Array.isArray(version.loaders) || !version.loaders.includes(loader))) {
        throw new Error("Incompatível: a versão do Modrinth " + versionId + " não suporta " + selectedLoader + ".");
      }
      versions = [version];
      projectData = { title: version.name || version.version_number || versionId };
    } catch (err) {
      const status = err && err.response && err.response.status;
      if (status === 404) throw new Error("Versão do Modrinth não encontrada: " + versionId);
      throw new Error("Não foi possível consultar a versão do Modrinth: HTTP " + (status || "erro"));
    }
  } else {
    if (kindIndex < 0 || !parts[kindIndex + 1]) return rawUrl;
    const slug = decodeURIComponent(parts[kindIndex + 1]);
    try {
      const project = await axios.get("https://api.modrinth.com/v2/project/" + encodeURIComponent(slug), {
        proxy: false, timeout: 20000,
        headers: { Accept: "application/json", "User-Agent": "Mikael-Modpack-Builder/4.3" }
      });
      projectData = project.data;
    } catch (err) {
      const status = err && err.response && err.response.status;
      if (status === 404) throw new Error("Projeto Modrinth não encontrado: " + slug);
      throw new Error("Não foi possível consultar o projeto Modrinth: HTTP " + (status || "erro"));
    }
    if (!projectData || !projectData.id) throw new Error("Projeto Modrinth não encontrado: " + slug);

    const supportedVersions = Array.isArray(projectData.game_versions) ? projectData.game_versions.map(String) : [];
    const supportedLoaders = Array.isArray(projectData.loaders) ? projectData.loaders.map(String) : [];
    const minecraftOk = !selectedMinecraft || supportedVersions.includes(selectedMinecraft);
    const loaderOk = !loader || supportedLoaders.includes(loader);
    if (!minecraftOk || !loaderOk) {
      const reasons = [];
      if (!minecraftOk) reasons.push("Minecraft " + selectedMinecraft + " não é suportado");
      if (!loaderOk) reasons.push(selectedLoader + " não é suportado");
      const details = [];
      if (!minecraftOk && supportedVersions.length) details.push("versões disponíveis: " + supportedVersions.slice(0, 12).join(", ") + (supportedVersions.length > 12 ? "..." : ""));
      if (!loaderOk && supportedLoaders.length) details.push("loaders disponíveis: " + supportedLoaders.join(", "));
      throw new Error("Incompatível: " + String(projectData.title || slug) + " — " + reasons.join(" e ") + (details.length ? ". " + details.join("; ") : "."));
    }

    const params = new URLSearchParams();
    if (selectedMinecraft) params.set("game_versions", JSON.stringify([selectedMinecraft]));
    if (loader) params.set("loaders", JSON.stringify([loader]));
    params.set("include_changelog", "false");
    try {
      const response = await axios.get("https://api.modrinth.com/v2/project/" + encodeURIComponent(projectData.id) + "/version?" + params.toString(), {
        proxy: false, timeout: 20000,
        headers: { Accept: "application/json", "User-Agent": "Mikael-Modpack-Builder/4.3" }
      });
      versions = response.data;
    } catch (err) {
      const status = err && err.response && err.response.status;
      throw new Error("Não foi possível consultar as versões do Modrinth: HTTP " + (status || "erro"));
    }
  }

  const candidates = Array.isArray(versions) ? versions.filter(v => v && v.status === "listed" && Array.isArray(v.files) && v.files.length) : [];
  if (!candidates.length) {
    throw new Error("Incompatível: " + (projectData?.title || "este projeto") + " não possui uma versão publicada/listada para Minecraft " +
      (selectedMinecraft || "selecionado") + (loader ? " + " + selectedLoader : "") + ".");
  }
  const selected = candidates.find(v => (!selectedMinecraft || v.game_versions?.includes(selectedMinecraft)) && (!loader || v.loaders?.includes(loader)))
    || candidates.find(v => v.version_type === "release")
    || candidates[0];

  const primary = selected.files.find(f => f.primary) || selected.files[0];
  if (!primary || !primary.url) throw new Error("O projeto Modrinth não possui um arquivo para download.");
  const selectedFilename = String(primary.filename || "").trim();
  if (selectedFilename && !/\.(jar|zip)$/i.test(selectedFilename)) {
    throw new Error("O arquivo principal do Modrinth (" + selectedFilename + ") não é um JAR/ZIP de mod.");
  }
  try {
    const fileUrl = new URL(String(primary.url));
    if (fileUrl.hostname.toLowerCase().includes("cdn.modrinth.com") && !fileUrl.searchParams.has("mr_download_reason")) {
      fileUrl.searchParams.set("mr_download_reason", "mikael-modpack-builder");
    }
    return fileUrl.toString();
  } catch {
    return String(primary.url);
  }
}

async function requestFile(rawUrl, context = {}) {
  let current = await resolveCurseForgeUrl(rawUrl, context);
  current = await resolveModrinthUrl(current, context);
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
    const isModrinthDownload = checked.url.hostname.toLowerCase() === "cdn.modrinth.com" || checked.url.hostname.toLowerCase().endsWith(".cdn.modrinth.com");
    const headers = {
      "User-Agent": "Mikael-Modpack-Builder/4.3 (https://github.com/mikael8367/mikael-modpack-builder)",
      Accept: isModrinthDownload ? "application/java-archive, application/zip, application/octet-stream, */*" : "*/*"
    };
    if (isModrinthDownload) headers["Referer"] = "https://modrinth.com/";
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
      if (err && err.response && err.response.data && typeof err.response.data.destroy === "function") {
        err.response.data.destroy();
      }
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
      if (isModrinthDownload) {
        throw new Error("O CDN do Modrinth respondeu uma página HTML em vez do arquivo. O resolvedor foi atualizado; tente novamente com o link do projeto Modrinth.");
      }
      if (isCurseForgeHost(checked.url.hostname)) throw new Error("O link do CurseForge não entregou um arquivo. Use uma URL de download do arquivo ou configure CURSEFORGE_API_KEY.");
      throw new Error("O link não entregou um arquivo. O servidor esperava um .jar/.zip, mas recebeu HTML.");
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

async function isZipArchive(filePath) {
  let handle;
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile() || stat.size < 22) return false;
    handle = await fsp.open(filePath, "r");
    const head = Buffer.alloc(4);
    const headRead = await handle.read(head, 0, 4, 0);
    if (headRead.bytesRead < 4) return false;
    const hasZipStart = head[0] === 0x50 && head[1] === 0x4b &&
      ((head[2] === 0x03 && head[3] === 0x04) ||
       (head[2] === 0x05 && head[3] === 0x06) ||
       (head[2] === 0x07 && head[3] === 0x08));
    if (!hasZipStart) return false;
    const tailSize = Math.min(stat.size, 22 + 65535);
    const tail = Buffer.alloc(tailSize);
    const tailRead = await handle.read(tail, 0, tailSize, stat.size - tailSize);
    if (tailRead.bytesRead < 22) return false;
    const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const zip64eocd = Buffer.from([0x50, 0x4b, 0x06, 0x06]);
    return tail.lastIndexOf(eocd) >= 0 || tail.lastIndexOf(zip64eocd) >= 0;
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function validateArchiveFile(filePath, filename) {
  if (!(await isZipArchive(filePath))) {
    throw new Error("O arquivo " + (filename || "baixado") + " não parece ser um JAR/ZIP válido.");
  }
}

function parseContentDispositionFilename(value) {
  const disposition = String(value || "");
  const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (encoded) {
    try { return decodeURIComponent(encoded[1].trim().replace(/^"(.*)"$/, "$1")); } catch {}
  }
  const quoted = disposition.match(/filename\s*=\s*"([^"]+)"/i);
  if (quoted) return quoted[1].trim();
  const bare = disposition.match(/filename\s*=\s*([^;]+)/i);
  return bare ? bare[1].trim() : "";
}

function isRetryableDownloadError(err) {
  const status = Number(err && err.response && err.response.status || err && err.status || 0);
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const code = String(err && err.code || "").toUpperCase();
  return ["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"].includes(code);
}

function canReserveDownloadBytes(committedBytes, reservedBytes, expectedBytes) {
  const expected = Number(expectedBytes || 0);
  if (expected < 0 || expected > MAX_FILE_BYTES) return false;
  return Number(committedBytes || 0) + Number(reservedBytes || 0) + expected <= MAX_TOTAL_BYTES;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


app.post("/api/validate-links", async (req, res) => {
  const minecraftVersion = String(req.body.minecraftVersion || "").trim();
  const modLoader = String(req.body.modLoader || "").trim();
  const links = Array.isArray(req.body.links) ? [...new Set(req.body.links.map(x => String(x || "").trim()).filter(Boolean))] : [];
  if (!minecraftVersion || !modLoader) return res.status(400).json({ error: "Informe Minecraft e modloader." });
  if (links.length > MAX_LINKS) return res.status(400).json({ error: `Máximo de ${MAX_LINKS} links.` });
  const results = [];
  for (const raw of links) {
    const item = { url: raw, name: raw, ok: false, message: "" };
    try {
      const resolved = await resolveCurseForgeUrl(raw, { minecraftVersion, modLoader });
      const finalUrl = await resolveModrinthUrl(resolved, { minecraftVersion, modLoader });
      const checked = await validatePublicUrl(finalUrl);
      item.name = checked.url.pathname.split("/").pop() || checked.url.hostname;
      item.ok = true;
      item.message = `Disponível • ${checked.url.hostname}`;
    } catch (e) {
      item.message = e.message || "Link não pôde ser verificado.";
    }
    results.push(item);
  }
  res.json({ minecraftVersion, modLoader, results });
});

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
    if (job.status === "running" || job.status === "zipping" || job.downloads) continue;
    const lastTouch = Math.max(job.created, Number(job.lastAccess || 0));
    if (now - lastTouch > JOB_TTL_MS) {
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
  res.setHeader("X-Accel-Buffering", "no");
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
  job.lastAccess = Date.now();
  job.downloads = Number(job.downloads || 0) + 1;
  let released = false;
  const release = err => {
    if (released) return;
    released = true;
    job.downloads = Math.max(0, Number(job.downloads || 1) - 1);
    job.lastAccess = Date.now();
    if (err) job.lastDownloadError = String(err.message || err);
  };
  res.on("finish", () => release());
  res.on("close", () => { if (!res.writableFinished) release(new Error("Download interrompido pelo cliente.")); });
  res.download(job.zipPath, job.zipName, release);
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
      tempDir, zipPath: null, zipName: null, status: "running", created: Date.now(), lastAccess: Date.now(), downloads: 0, clients: new Set(),
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
      const reservedNames = new Set();
      let reservedBytes = 0;
      const localCount = localUpload ? localUpload.files.length : 0;
      try {
        if (localUpload) {
          job.progress.total = uniqueLinks.length + localUpload.files.length;
          for (const f of localUpload.files) {
            await validateArchiveFile(f.path, f.filename);
            const target = path.join(tempDir, f.filename);
            await fsp.copyFile(f.path, target);
            const st = await fsp.stat(target);
            total += st.size;
            if (total > MAX_TOTAL_BYTES) throw new Error("O pacote ultrapassa 500 MB.");
            reservedNames.add(f.filename.toLowerCase());
            files.push({ filename: f.filename, target, source: "arquivo local", size: st.size });
            const current = files.length;
            updateJob(job, {
              current, filename: f.filename,
              percent: Math.min(85, Math.round(current / Math.max(1, job.progress.total) * 85)),
              message: `✓ ${f.filename} adicionado`
            });
          }
        }

        const failures = [];
        let nextIndex = 0;
        let completedLinks = 0;
        let completed = localCount;
        const totalCount = Math.max(1, job.progress.total);

        const downloadOne = async (i) => {
          const raw = uniqueLinks[i];
          let filename = "";
          let target = "";
          let success = false;
          let lastError = null;
          let reservedForThis = 0;

          for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES && !success; attempt++) {
            let response = null;
            let bytes = 0;
            try {
              const result = await requestFile(raw, { minecraftVersion, modLoader });
              response = result.response;
              const url = result.url;

              if (!filename) {
                const fromHeader = parseContentDispositionFilename(response.headers["content-disposition"]);
                const candidate = safeFileName(fromHeader || url.pathname, i);
                filename = uniqueName(candidate, reservedNames);
                target = path.join(tempDir, i + "-" + filename);
              }

              const expected = Number(response.headers["content-length"] || 0);
              if (expected > MAX_FILE_BYTES) throw new Error("O arquivo " + filename + " ultrapassa 150 MB.");
              if (expected > 0) {
                if (!canReserveDownloadBytes(total, reservedBytes, expected)) {
                  throw new Error("O pacote não tem espaço suficiente para baixar " + filename + " sem ultrapassar 500 MB.");
                }
                reservedForThis = expected;
                reservedBytes += expected;
              }

              response.data.on("data", chunk => {
                bytes += chunk.length;
                total += chunk.length;
                if (reservedForThis > 0) {
                  const releasedReservation = Math.min(reservedForThis, chunk.length);
                  reservedForThis -= releasedReservation;
                  reservedBytes = Math.max(0, reservedBytes - releasedReservation);
                }
                const filePercent = expected ? Math.min(1, bytes / expected) : 0;
                const progress = Math.min(85, Math.round(((completed + filePercent) / totalCount) * 85));
                const elapsed = Math.max(0.1, (Date.now() - job.created) / 1000);
                updateJob(job, {
                  current: completed,
                  filename,
                  percent: progress,
                  message: "Baixando " + filename + " • " + completed + "/" + totalCount,
                  bytesPerSecond: Math.round(total / elapsed)
                });
                if (bytes > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
                  response.data.destroy(new Error("Limite de tamanho excedido."));
                }
              });

              await pipeline(response.data, fs.createWriteStream(target));
              if (bytes <= 0) throw new Error("O servidor retornou um arquivo vazio.");
              if (bytes > MAX_FILE_BYTES) throw new Error("O arquivo " + filename + " ultrapassa 150 MB.");
              if (total > MAX_TOTAL_BYTES) throw new Error("O pacote ultrapassa 500 MB.");
              await validateArchiveFile(target, filename);

              files.push({ filename, target, source: raw, size: bytes });
              success = true;
              updateJob(job, {
                current: completed + 1,
                filename,
                percent: Math.min(85, Math.round(((completed + 1) / totalCount) * 85)),
                message: "✓ " + filename + " baixado",
                bytesPerSecond: Math.round(total / Math.max(0.1, (Date.now() - job.created) / 1000))
              });
            } catch (e) {
              lastError = e;
              total = Math.max(0, total - bytes);
              if (reservedForThis > 0) {
                reservedBytes = Math.max(0, reservedBytes - reservedForThis);
                reservedForThis = 0;
              }
              if (target) await fsp.rm(target, { force: true }).catch(() => {});
              if (response && response.data) response.data.destroy();
              if (attempt < MAX_DOWNLOAD_RETRIES && isRetryableDownloadError(e)) {
                await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
              } else {
                break;
              }
            }
          }

          if (!success) failures.push({ url: raw, error: lastError && lastError.message ? lastError.message : "Falha no download." });
          completedLinks += 1;
          completed += 1;
          updateJob(job, {
            current: completed,
            percent: Math.min(85, Math.round((completed / totalCount) * 85)),
            message: failures.length
              ? "Processando • " + completedLinks + "/" + uniqueLinks.length + " links • " + failures.length + " erro(s)"
              : "Processando • " + completedLinks + "/" + uniqueLinks.length + " links",
            bytesPerSecond: Math.round(total / Math.max(0.1, (Date.now() - job.created) / 1000))
          });
        };

        const workers = Array.from({ length: Math.min(3, Math.max(1, uniqueLinks.length)) }, async () => {
          while (true) {
            const i = nextIndex++;
            if (i >= uniqueLinks.length) return;
            await downloadOne(i);
          }
        });
        await Promise.all(workers);

        if (!files.length) throw new Error("Nenhum arquivo válido pôde ser incluído no ZIP.");
        updateJob(job, { status: "zipping", percent: 90, message: "📦 Criando o ZIP..." });
        const safeVersion = minecraftVersion.replace(/[^0-9A-Za-z._-]/g, "_");
        const zipName = `Mikael_Modpack_${safeVersion}.zip`;
        const zipPath = path.join(tempDir, zipName);
        const output = fs.createWriteStream(zipPath);
        const archive = archiver("zip", { zlib: { level: 6 } });
        const manifest = {
          format: "mikael-modpack-links", version: 1, minecraft: minecraftVersion,
          modLoader, modLoaderVersion: loaderVersion || null,
          files: files.map(f => ({ file: f.filename, source: f.source, size: f.size || null })),
          failed: failures
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
        const zipStat = await fsp.stat(zipPath);
        if (!zipStat.size) throw new Error("O ZIP gerado ficou vazio.");
        job.zipPath = zipPath;
        job.zipName = zipName;
        job.status = "done";
        job.lastAccess = Date.now();
        updateJob(job, { status: "done", percent: 100, current: job.progress.total, message: failures.length ? `⚠️ ZIP pronto: ${files.length} baixados, ${failures.length} com erro.` : "✅ Todos os mods foram instalados e o ZIP está pronto!", failures });
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

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => console.log(`Mikael Modpack Builder em ${PORT}`));
}

module.exports = {
  app,
  isPrivateIp,
  validatePublicUrl,
  safeFileName,
  uniqueName,
  isZipArchive,
  validateArchiveFile,
  parseContentDispositionFilename,
  isRetryableDownloadError,
  canReserveDownloadBytes,
  jobs
};