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
const DOWNLOAD_TIMEOUT_MS = 120000;
const API_RETRIES = 3;
const API_RETRY_BASE_MS = 800;
const MODRINTH_MIN_REQUEST_INTERVAL_MS = 200;
const MODRINTH_CACHE_TTL_MS = 2 * 60 * 1000;
const API_CACHE_MAX_ENTRIES = 2000;
const MAX_UPLOAD_FILES = 999;
const CURSEFORGE_API_KEY = String(process.env.CURSEFORGE_API_KEY || "").trim();
const CURSEFORGE_API_BASE = "https://api.curseforge.com/v1";
const CURSEFORGE_GAME_ID = 432;
const modrinthCache = new Map();
const curseForgeCache = new Map();
let modrinthNextRequestAt = 0;

const http = require("http");
const https = require("https");
const multer = require("multer");
const upload = multer({ dest: path.join(os.tmpdir(), "mikael-uploads-"), limits: { fileSize: MAX_FILE_BYTES, files: MAX_UPLOAD_FILES } });

async function cleanupOrphanedTempData() {
  const now = Date.now();
  const maxAge = Math.max(UPLOAD_TTL_MS, JOB_TTL_MS);
  let entries = [];
  try { entries = await fsp.readdir(os.tmpdir(), { withFileTypes: true }); } catch { return; }
  await Promise.all(entries.filter(entry => /^(mikael-(uploads-|local-|modpack-))/.test(entry.name)).map(async entry => {
    const target = path.join(os.tmpdir(), entry.name);
    try {
      const st = await fsp.stat(target);
      if (now - st.mtimeMs > maxAge) await fsp.rm(target, { recursive: entry.isDirectory(), force: true });
    } catch {}
  }));
}

cleanupOrphanedTempData().catch(() => {});
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
    uploads.set(id, { dir, files: saved, created: Date.now(), lastAccess: Date.now(), inUse: 0 });
    res.json({ id, files: saved.map(f => f.filename) });
  } catch (e) {
    await Promise.all(files.map(f => f && f.path ? fsp.rm(f.path, { force: true }).catch(() => {}) : Promise.resolve()));
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
  if (u.username || u.password) throw new Error("URLs com usuário ou senha embutidos não são permitidas.");
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

async function apiDelay(retry) {
  await sleep(API_RETRY_BASE_MS * Math.pow(2, retry));
}

function retryAfterMs(headers) {
  const raw = headers?.["retry-after"];
  if (raw == null) return 0;
  const value = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Math.max(0, Math.round(Number(value) * 1000));
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

async function waitForModrinthSlot() {
  const now = Date.now();
  const slot = Math.max(now, modrinthNextRequestAt);
  const wait = Math.max(0, slot - now);
  modrinthNextRequestAt = slot + MODRINTH_MIN_REQUEST_INTERVAL_MS;
  if (wait) await sleep(wait);
}

async function modrinthApiGet(url, config = {}, cacheKey = "") {
  const now = Date.now();
  if (cacheKey && modrinthCache.has(cacheKey)) {
    const hit = modrinthCache.get(cacheKey);
    if (hit.expires > now) return hit.promise ? hit.promise : hit.value;
    modrinthCache.delete(cacheKey);
  }
  const request = (async () => {
    let lastError;
    for (let retry = 0; retry < API_RETRIES; retry++) {
      await waitForModrinthSlot();
      try {
        const response = await axios.get(url, {
          proxy: false,
          timeout: 20000,
          ...config,
          headers: { Accept: "application/json", ...(config.headers || {}) }
        });
        return response.data;
      } catch (err) {
        lastError = err;
        const status = Number(err && err.response && err.response.status || 0);
        if (![429, 500, 502, 503, 504].includes(status) || retry === API_RETRIES - 1) throw err;
        const retryAfter = retryAfterMs(err.response?.headers || {});
        if (retryAfter > 0) await sleep(Math.min(60000, retryAfter));
        else await apiDelay(retry);
      }
    }
    throw lastError || new Error("Falha na API do Modrinth.");
  })();
  if (cacheKey) {
    if (modrinthCache.size >= API_CACHE_MAX_ENTRIES) modrinthCache.delete(modrinthCache.keys().next().value);
    const entry = { expires: Date.now() + MODRINTH_CACHE_TTL_MS, promise: request };
    modrinthCache.set(cacheKey, entry);
    try {
      const value = await request;
      if (value != null) modrinthCache.set(cacheKey, { expires: Date.now() + MODRINTH_CACHE_TTL_MS, value });
      return value;
    } catch (err) {
      if (modrinthCache.get(cacheKey)?.promise === request) modrinthCache.delete(cacheKey);
      throw err;
    }
  }
  return request;
}

async function curseForgeApiGet(pathname, params = {}) {
  if (!CURSEFORGE_API_KEY) throw new Error("CurseForge agora exige uma API Key para downloads automatizados. Configure CURSEFORGE_API_KEY no Render.");
  const cacheKey = pathname + "?" + new URLSearchParams(Object.entries(params).map(([k,v]) => [k, String(v ?? "")])).toString();
  const now = Date.now();
  if (curseForgeCache.has(cacheKey)) {
    const hit = curseForgeCache.get(cacheKey);
    if (hit.expires > now) return hit.promise ? hit.promise : hit.value;
    curseForgeCache.delete(cacheKey);
  }
  const request = (async () => {
    let lastError;
    for (let retry = 0; retry < API_RETRIES; retry++) {
      try {
        const response = await axios.get(CURSEFORGE_API_BASE + pathname, {
          proxy: false,
          timeout: 20000,
          params,
          headers: { Accept: "application/json", "x-api-key": CURSEFORGE_API_KEY, "User-Agent": "Mikael-Modpack-Builder/6.1" }
        });
        return response.data && response.data.data;
      } catch (err) {
        lastError = err;
        const status = Number(err && err.response && err.response.status || 0);
        if (![429, 500, 502, 503, 504].includes(status) || retry === API_RETRIES - 1) throw err;
        const retryAfter = retryAfterMs(err.response?.headers || {});
        if (retryAfter > 0) await sleep(Math.min(60000, retryAfter));
        else await apiDelay(retry);
      }
    }
    throw lastError || new Error("Falha na API do CurseForge.");
  })();
  curseForgeCache.set(cacheKey, { expires: Date.now() + MODRINTH_CACHE_TTL_MS, promise: request });
  try {
    const value = await request;
    if (value != null) curseForgeCache.set(cacheKey, { expires: Date.now() + MODRINTH_CACHE_TTL_MS, value });
    else curseForgeCache.delete(cacheKey);
    return value;
  } catch (err) {
    if (curseForgeCache.get(cacheKey)?.promise === request) curseForgeCache.delete(cacheKey);
    throw err;
  }
}

async function resolveCurseForgeUrl(rawUrl, context = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { return rawUrl; }
  if (!CURSEFORGE_API_KEY || !isCurseForgeHost(u.hostname)) return rawUrl;
  const parts = u.pathname.split("/").filter(Boolean);
  const normalizedParts = parts.map(p => p.toLowerCase());
  const modIndex = normalizedParts.indexOf("mc-mods");
  if (modIndex < 0 || !parts[modIndex + 1]) return rawUrl;
  let slug;
  try { slug = decodeURIComponent(parts[modIndex + 1]); } catch { throw new Error("Slug do CurseForge inválido."); }
  const downloadIndex = normalizedParts.indexOf("download", modIndex) + 1;
  const fileId = downloadIndex > 0 && /^\d+$/.test(parts[downloadIndex]) ? Number(parts[downloadIndex]) : null;
  const mod = await curseForgeApiGet("/mods/search", { gameId: CURSEFORGE_GAME_ID, slug, pageSize: 1 });
  const found = Array.isArray(mod) ? mod[0] : null;
  if (!found || !found.id) throw new Error("Mod CurseForge não encontrado: " + slug);
  if (fileId) {
    const file = await curseForgeApiGet("/mods/" + found.id + "/files/" + fileId);
    if (!file || !file.id) throw new Error("Arquivo CurseForge " + fileId + " não foi encontrado.");
    if (file.isAvailable === false || [7, 8, 9].includes(Number(file.fileStatus))) throw new Error("O arquivo CurseForge " + fileId + " não está disponível para download.");
    const wantedVersion = String(context.minecraftVersion || "").trim();
    if (wantedVersion && (!Array.isArray(file.gameVersions) || !file.gameVersions.includes(wantedVersion))) {
      throw new Error("Incompatível: o arquivo CurseForge " + fileId + " não suporta Minecraft " + wantedVersion + ".");
    }
    if (file.isServerPack === true) throw new Error("O arquivo CurseForge " + fileId + " é um server pack e não será colocado em mods/.");
    context.expectedHashes = file.hashes || null;
    context.expectedSize = Number(file.fileLength || 0) || null;
    const downloadUrl = file.downloadUrl || await curseForgeApiGet("/mods/" + found.id + "/files/" + fileId + "/download-url");
    if (!downloadUrl) throw new Error("Arquivo CurseForge " + fileId + " não possui URL de download.");
    return String(downloadUrl);
  }
  const loaderMap = { Forge: 1, Fabric: 4, LiteLoader: 3, Quilt: 5, NeoForge: 6 };
  const loaderType = loaderMap[String(context.modLoader || "")];
  if (!loaderType) throw new Error("Para links de projeto do CurseForge, selecione um modloader conhecido ou use uma URL direta do arquivo.");
  const files = await curseForgeApiGet("/mods/" + found.id + "/files", {
    gameVersion: String(context.minecraftVersion || ""),
    modLoaderType: loaderType,
    pageSize: 50,
    sortField: 11,
    sortOrder: "desc"
  });
  const candidates = Array.isArray(files)
    ? files.filter(f => f && f.isAvailable !== false && ![7, 8, 9].includes(Number(f.fileStatus)) && Array.isArray(f.gameVersions) && f.gameVersions.includes(String(context.minecraftVersion || "")))
    : [];
  const usable = candidates.filter(f => f && f.isServerPack !== true);
  const selected = usable.find(f => Number(f.releaseType) === 1) || usable[0];
  if (!selected) throw new Error("Nenhum arquivo de mod compatível de " + slug + " foi encontrado para Minecraft " + (context.minecraftVersion || "selecionado") + ".");
  context.expectedHashes = selected.hashes || null;
  context.expectedSize = Number(selected.fileLength || 0) || null;
  if (!selected.downloadUrl) throw new Error("O arquivo de " + slug + " não possui URL de download disponível.");
  return String(selected.downloadUrl);
}

function isModrinthHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "modrinth.com" || h === "www.modrinth.com" || h.endsWith(".modrinth.com") || h === "cdn.modrinth.com" || h.endsWith(".cdn.modrinth.com");
}

function isClientCompatibleEnvironment(environment) {
  return !["server_only", "dedicated_server_only", "server_only_client_optional"].includes(String(environment || "").toLowerCase());
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

  const loader = modrinthLoader(context.modLoader);
  const selectedMinecraft = String(context.minecraftVersion || "").trim();
  const selectedLoader = String(context.modLoader || "").trim();

  // Links diretos do CDN do Modrinth já apontam para o arquivo.
  // O parâmetro mr_download_reason é usado pelo próprio Modrinth nas páginas
  // de download e evita que o CDN trate a requisição como uma navegação HTML.
  if (u.hostname.toLowerCase().includes("cdn.modrinth.com")) {
    const directParts = u.pathname.split("/").filter(Boolean);
    const versionsAt = directParts.findIndex(p => p.toLowerCase() === "versions");
    if (versionsAt >= 0 && directParts[versionsAt + 1]) {
      let directVersionId;
      try { directVersionId = decodeURIComponent(directParts[versionsAt + 1]); } catch { throw new Error("ID de versão do Modrinth inválido."); }
      const version = await modrinthApiGet("https://api.modrinth.com/v2/version/" + encodeURIComponent(directVersionId), { timeout: 20000 }, "version:" + directVersionId);
      if (selectedMinecraft && (!Array.isArray(version.game_versions) || !version.game_versions.includes(selectedMinecraft))) {
        throw new Error("Incompatível: o arquivo do Modrinth não suporta Minecraft " + selectedMinecraft + ".");
      }
      if (loader && (!Array.isArray(version.loaders) || !version.loaders.includes(loader))) {
        throw new Error("Incompatível: o arquivo do Modrinth não suporta " + selectedLoader + ".");
      }
      if (!isClientCompatibleEnvironment(version.environment)) throw new Error("Incompatível: a versão do Modrinth é destinada ao servidor.");
      const files = Array.isArray(version.files) ? version.files : [];
      let urlFileName = "";
      try { urlFileName = decodeURIComponent(directParts[directParts.length - 1] || ""); } catch { throw new Error("Nome de arquivo do Modrinth inválido."); }
      const matchedFile = files.find(f => {
        if (!f || !f.url) return false;
        try { return decodeURIComponent(new URL(String(f.url)).pathname.split("/").pop() || "") === urlFileName; } catch { return false; }
      });
      const directFile = matchedFile || files.find(f => f && f.primary) || files[0];
      if (directFile && ["sources-jar", "dev-jar", "javadoc-jar", "signature"].includes(String(directFile.file_type || "").toLowerCase())) {
        throw new Error("O arquivo direto do Modrinth é um arquivo auxiliar e não será colocado em mods/.");
      }
      if (directFile) {
        context.expectedHashes = directFile.hashes || null;
        context.expectedSize = Number(directFile.size || 0) || null;
      }
    }
    if (!u.searchParams.has("mr_download_reason")) {
      u.searchParams.set("mr_download_reason", "mikael-modpack-builder");
    }
    return u.toString();
  }

  const parts = u.pathname.split("/").filter(Boolean);
  const projectKinds = new Set(["mod", "plugin", "datapack", "resourcepack", "shader", "modpack"]);
  const kindIndex = parts.findIndex(p => projectKinds.has(p.toLowerCase()));
  const versionIndex = parts.findIndex(p => p.toLowerCase() === "version");

  let versions;
  let projectData = null;

  if (versionIndex >= 0 && parts[versionIndex + 1]) {
    const versionId = decodeURIComponent(parts[versionIndex + 1]);
    try {
      const response = await modrinthApiGet("https://api.modrinth.com/v2/version/" + encodeURIComponent(versionId), {
        proxy: false, timeout: 20000,
        headers: { Accept: "application/json", "User-Agent": "Mikael-Modpack-Builder/6.1" }
      }, "version:" + versionId);
      const version = response;
      if (!version || !version.id) throw new Error("Versão do Modrinth inválida.");
      if (version.status && version.status !== "listed") throw new Error("A versão do Modrinth " + versionId + " não está publicada/listada.");
      if (selectedMinecraft && (!Array.isArray(version.game_versions) || !version.game_versions.includes(selectedMinecraft))) {
        throw new Error("Incompatível: a versão do Modrinth " + versionId + " não suporta Minecraft " + selectedMinecraft + ".");
      }
      if (loader && (!Array.isArray(version.loaders) || !version.loaders.includes(loader))) {
        throw new Error("Incompatível: a versão do Modrinth " + versionId + " não suporta " + selectedLoader + ".");
      }
      versions = [version];
      const versionFiles = Array.isArray(version.files) ? version.files : [];
      const versionPrimary = versionFiles.find(f => f && f.primary) || versionFiles[0];
      if (versionPrimary && versionPrimary.hashes) context.expectedHashes = versionPrimary.hashes;
      if (versionPrimary && versionPrimary.size) context.expectedSize = Number(versionPrimary.size) || null;
      projectData = { title: version.name || version.version_number || versionId };
    } catch (err) {
      const status = err && err.response && err.response.status;
      if (status === 404) throw new Error("Versão do Modrinth não encontrada: " + versionId);
      throw new Error("Não foi possível consultar a versão do Modrinth: HTTP " + (status || "erro"));
    }
  } else {
    if (kindIndex < 0 || !parts[kindIndex + 1]) return rawUrl;
    const kind = parts[kindIndex].toLowerCase();
    if (kind !== "mod") throw new Error("O link do projeto Modrinth é do tipo " + kind + ". Use o link direto do arquivo para adicioná-lo ao diretório mods.");
    let slug;
    try { slug = decodeURIComponent(parts[kindIndex + 1]); } catch { throw new Error("Slug do Modrinth inválido."); }
    try {
      const project = await modrinthApiGet("https://api.modrinth.com/v2/project/" + encodeURIComponent(slug), {
        proxy: false, timeout: 20000,
        headers: { Accept: "application/json", "User-Agent": "Mikael-Modpack-Builder/6.1" }
      }, "project:" + slug);
      projectData = project;
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
      const response = await modrinthApiGet(
        "https://api.modrinth.com/v2/project/" + encodeURIComponent(projectData.id) + "/version?" + params.toString(),
        { timeout: 20000, headers: { Accept: "application/json", "User-Agent": "Mikael-Modpack-Builder/6.1" } },
        "versions:" + projectData.id + ":" + selectedMinecraft + ":" + loader
      );
      versions = response;
    } catch (err) {
      const status = err && err.response && err.response.status;
      throw new Error("Não foi possível consultar as versões do Modrinth: HTTP " + (status || "erro"));
    }
  }

  const candidates = Array.isArray(versions) ? versions.filter(v => v && v.status === "listed" && Array.isArray(v.files) && v.files.length) : [];
  const clientCandidates = candidates.filter(v => isClientCompatibleEnvironment(v.environment));
  if (!clientCandidates.length) throw new Error("Incompatível: o projeto Modrinth não possui uma versão para uso no cliente.");
  if (!candidates.length) {
    throw new Error("Incompatível: " + (projectData?.title || "este projeto") + " não possui uma versão publicada/listada para Minecraft " +
      (selectedMinecraft || "selecionado") + (loader ? " + " + selectedLoader : "") + ".");
  }
  const compatibleCandidates = clientCandidates.filter(v =>
    (!selectedMinecraft || (Array.isArray(v.game_versions) && v.game_versions.includes(selectedMinecraft))) &&
    (!loader || (Array.isArray(v.loaders) && v.loaders.includes(loader)))
  );
  if (!compatibleCandidates.length) {
    throw new Error("Incompatível: nenhuma versão do Modrinth corresponde exatamente a Minecraft " +
      (selectedMinecraft || "selecionado") + (loader ? " + " + selectedLoader : "") + ".");
  }
  const selected = compatibleCandidates.find(v => v.version_type === "release") || compatibleCandidates[0];

  const usableFiles = selected.files.filter(f => f && !["sources-jar", "dev-jar", "javadoc-jar", "signature"].includes(String(f.file_type || "").toLowerCase()));
  const primary = usableFiles.find(f => f.primary) || usableFiles[0];
  if (!primary || !primary.url) throw new Error("O projeto Modrinth não possui um arquivo principal para download.");
  context.expectedHashes = primary.hashes || null;
  context.expectedSize = Number(primary.size || 0) || null;
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
      "User-Agent": "Mikael-Modpack-Builder/6.1 (https://github.com/mikael8367/mikael-modpack-builder)",
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
        timeout: DOWNLOAD_TIMEOUT_MS,
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
  n = n.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[ .]+$/g, "").slice(0, 180);
  if (!n || n === "." || n === "..") n = `mod_${index + 1}.jar`;
  const dot = n.indexOf(".");
  const stem = dot >= 0 ? n.slice(0, dot) : n;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) n = "_" + n;
  if (!/\.(jar|zip|litemod)$/i.test(n)) n += ".jar";
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
  return ["ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED", "ENETRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE", "EINTEGRITY"].includes(code);
}

function canReserveDownloadBytes(committedBytes, reservedBytes, expectedBytes) {
  const expected = Number(expectedBytes || 0);
  if (expected < 0 || expected > MAX_FILE_BYTES) return false;
  return Number(committedBytes || 0) + Number(reservedBytes || 0) + expected <= MAX_TOTAL_BYTES;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function redactUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    return u.origin + u.pathname;
  } catch {
    return String(rawUrl || "").slice(0, 500);
  }
}

async function verifyFileIntegrity(filePath, hashes, filename) {
  if (!hashes) return;
  const expected = {};
  if (Array.isArray(hashes)) {
    for (const item of hashes) {
      if (!item || !item.value) continue;
      if (Number(item.algo) === 1) expected.sha1 = String(item.value).toLowerCase();
      if (Number(item.algo) === 2) expected.md5 = String(item.value).toLowerCase();
    }
  } else if (typeof hashes === "object") {
    if (hashes.sha1) expected.sha1 = String(hashes.sha1).toLowerCase();
    if (hashes.sha512) expected.sha512 = String(hashes.sha512).toLowerCase();
    if (hashes.md5) expected.md5 = String(hashes.md5).toLowerCase();
  }
  const algorithms = Object.keys(expected);
  if (!algorithms.length) return;
  const hashers = Object.fromEntries(algorithms.map(algo => [algo, crypto.createHash(algo)]));
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => {
      for (const hasher of Object.values(hashers)) hasher.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  for (const algo of algorithms) {
    const actual = hashers[algo].digest("hex").toLowerCase();
    if (actual !== expected[algo]) {
      const err = new Error("Integridade inválida: o hash " + algo + " de " + (filename || "arquivo") + " não corresponde ao publicado.");
      err.code = "EINTEGRITY";
      throw err;
    }
  }
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
    const lastTouch = Math.max(item.created, Number(item.lastAccess || 0));
    if (!item.inUse && now - lastTouch > UPLOAD_TTL_MS) {
      uploads.delete(id);
      await fsp.rm(item.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  for (const [id, job] of jobs) {
    if (job.status === "running" || job.status === "zipping" || job.downloads || job.clients.size) continue;
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
  const previous = job.progress || {};
  const merged = { ...previous, ...data };
  if (data.status !== "error") {
    if (Number.isFinite(Number(previous.percent))) merged.percent = Math.max(Number(previous.percent), Number(merged.percent || 0));
    if (Number.isFinite(Number(previous.current))) merged.current = Math.max(Number(previous.current), Number(merged.current || 0));
    if (Number.isFinite(Number(previous.total))) merged.total = Math.max(Number(previous.total), Number(merged.total || 0));
  }
  job.progress = merged;
  const terminal = merged.status === "done" || merged.status === "error";
  for (const client of [...job.clients]) {
    try {
      client.write(`data: ${JSON.stringify(job.progress)}\n\n`);
      if (terminal) client.end();
    } catch {}
    if (terminal) job.clients.delete(client);
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

app.get("/api/build/:id/status", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Build não encontrado ou expirado." });
  job.lastAccess = Date.now();
  res.json({
    id: req.params.id,
    status: job.status,
    progress: job.progress,
    failures: Array.isArray(job.progress?.failures) ? job.progress.failures : [],
    zipName: job.zipName || null,
    downloadUrl: job.status === "done" && job.zipPath ? "/api/build/" + encodeURIComponent(req.params.id) + "/download" : null
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
          let lastProgressAt = 0;

          const context = { minecraftVersion, modLoader };
          for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES && !success; attempt++) {
            let response = null;
            let bytes = 0;
            try {
              const result = await requestFile(raw, context);
              response = result.response;
              const url = result.url;

              if (!filename) {
                const fromHeader = parseContentDispositionFilename(response.headers["content-disposition"]);
                const candidate = safeFileName(fromHeader || url.pathname, i);
                filename = uniqueName(candidate, reservedNames);
                target = path.join(tempDir, i + "-" + filename);
              }

              const headerLength = Number(response.headers["content-length"] || 0);
              const expected = headerLength > 0 ? headerLength : Number(context.expectedSize || 0);
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
                const now = Date.now();
                const elapsed = Math.max(0.1, (now - job.created) / 1000);
                if (now - lastProgressAt >= 250 || bytes <= 0) {
                  lastProgressAt = now;
                  updateJob(job, {
                    current: completed,
                    filename,
                    percent: progress,
                    message: "Baixando " + filename + " • " + completed + "/" + totalCount,
                    bytesPerSecond: Math.round(total / elapsed)
                  });
                }
                if (bytes > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
                  response.data.destroy(new Error("Limite de tamanho excedido."));
                }
              });

              await pipeline(response.data, fs.createWriteStream(target));
              if (bytes <= 0) throw new Error("O servidor retornou um arquivo vazio.");
              if (bytes > MAX_FILE_BYTES) throw new Error("O arquivo " + filename + " ultrapassa 150 MB.");
              if (reservedForThis > 0) {
                reservedBytes = Math.max(0, reservedBytes - reservedForThis);
                reservedForThis = 0;
              }
              if (context.expectedSize && bytes !== context.expectedSize) {
                throw new Error("O tamanho baixado de " + filename + " não corresponde ao tamanho publicado.");
              }
              if (total > MAX_TOTAL_BYTES) throw new Error("O pacote ultrapassa 500 MB.");
              await validateArchiveFile(target, filename);
              await verifyFileIntegrity(target, context.expectedHashes, filename);

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
        const orderedFiles = [...files].sort((a, b) => String(a.filename).localeCompare(String(b.filename), "en", { sensitivity: "base" }) || String(a.source).localeCompare(String(b.source), "en"));
        updateJob(job, { status: "zipping", percent: 90, message: "📦 Criando o ZIP..." });
        const safeVersion = minecraftVersion.replace(/[^0-9A-Za-z._-]/g, "_");
        const zipName = `Mikael_Modpack_${safeVersion}.zip`;
        const zipPath = path.join(tempDir, zipName);
        const output = fs.createWriteStream(zipPath);
        const archive = archiver("zip", { zlib: { level: 6 } });
        const manifest = {
          format: "mikael-modpack-links", version: 1, minecraft: minecraftVersion,
          modLoader, modLoaderVersion: loaderVersion || null,
          files: orderedFiles.map(f => ({ file: f.filename, source: redactUrl(f.source), size: f.size || null })),
          failed: failures.map(f => ({ ...f, url: redactUrl(f.url) }))
        };
        for (const file of orderedFiles) archive.file(file.target, { name: `mods/${file.filename}`, store: true });
        archive.append(JSON.stringify(manifest, null, 2), { name: "mikael-modpack.json" });
        archive.append(JSON.stringify({
          minecraft: minecraftVersion, modLoader, modLoaderVersion: loaderVersion || null,
          note: "Arquivos adicionados a partir das URLs fornecidas pelo usuário."
        }, null, 2), { name: "modpack-info.json" });
        await new Promise((resolve, reject) => {
          output.on("close", resolve);
          output.on("error", reject);
          archive.on("error", reject);
          archive.on("warning", reject);
          archive.pipe(output);
          Promise.resolve(archive.finalize()).catch(reject);
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
          localUpload.lastAccess = Date.now();
        }
      }
    })();
  } catch (e) {
    jobs.delete(id);
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return res.status(500).json({ error: e.message || "Não foi possível iniciar a geração." });
  }
});

app.use(async (err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const partialFiles = Array.isArray(req.files) ? req.files : [];
    await Promise.all(partialFiles.map(f => f && f.path ? fsp.rm(f.path, { force: true }).catch(() => {}) : Promise.resolve()));
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
  verifyFileIntegrity,
  retryAfterMs,
  isClientCompatibleEnvironment,
  redactUrl,
  jobs,
  modrinthCache,
  curseForgeCache
};