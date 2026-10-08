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
const MAX_DOWNLOAD_RETRIES = 6;
const RETRY_BASE_MS = 700;
const DOWNLOAD_TIMEOUT_MS = 180000;
const API_RETRIES = 5;
const API_RETRY_BASE_MS = 800;
const MODRINTH_MIN_REQUEST_INTERVAL_MS = 200;
const MODRINTH_CACHE_TTL_MS = 2 * 60 * 1000;
const API_CACHE_MAX_ENTRIES = 2000;
const MAX_UPLOAD_FILES = 999;
const CURSEFORGE_API_KEY = String(process.env.CURSEFORGE_API_KEY || "").trim();
const CURSEFORGE_API_BASE = "https://api.curseforge.com/v1";
const MODPACKS_CH_API_BASE = "https://api.modpacks.ch";
const MCIM_CURSEFORGE_API_BASE = "https://mod.mcimirror.top/curseforge";
const CURSEFORGE_PUBLIC_PROXY_BASES = [...new Set(
  String(process.env.CURSEFORGE_PUBLIC_PROXY_URLS || "https://mod.mcimirror.top/curseforge")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => value.replace(/\/+$/, "").replace(/\/v1$/i, ""))
    .filter(value => /^https:\/\//i.test(value))
)];
const CURSEFORGE_PROXY_MIN_REQUEST_INTERVAL_MS = 900;
const CURSEFORGE_GAME_ID = 432;
const CURSEFORGE_SEARCH_ALIASES = Object.freeze({
  "foamfix-for-minecraft": ["foamfix-optimization-mod", "foamfix"],
  "projecte-teams": ["projecteteams", "projecte teams"],
  "dynamictrees-biomes-o-plenty": ["dtbop", "dynamic trees biomes o plenty"],
  "the-aether-ii": ["the-aether-ii-phosphor-not-included", "aether-ii", "aether ii"],
  "voidcraft": ["voidscape"],
  "traverse-legacy": ["traverse-reforged", "traverse"],
  "forge-multipart-cbe": ["cb-multipart", "forge multipart cbe"],
  "wild-nature": ["wildnature", "wild nature"],
  "betterfps": ["better fps"],
  "phosphor-forge": ["phosphor", "phosphor forge"]
});

function curseForgeSearchTerms(slug) {
  const raw = String(slug || "").trim().toLowerCase();
  const aliases = CURSEFORGE_SEARCH_ALIASES[raw] || [];
  return [...new Set([
    raw,
    raw.replace(/[-_]+/g, " "),
    raw.replace(/[-_]+/g, ""),
    ...aliases
  ].filter(Boolean))];
}

const CURSEFORGE_PROJECT_ID_FALLBACKS = Object.freeze({
  "foamfix-for-minecraft": 278494,
  "foamfix-optimization-mod": 278494,
  "betterfps": 229876,
  "phosphor-forge": 318255,
  "baubles": 227083,
  "opencomputers": 223008,
  "thaumcraft": 223628,
  "waystones": 245755,
  "atum": 59621,
  "natura": 74120,
  "project-expanse": 377600,
  "projecte-teams": 1090134,
  "projecteteams": 1090134,
  "dynamictrees-biomes-o-plenty": 289529,
  "dtbop": 289529,
  "traverse-legacy": 267769,
  "traverse-reforged": 267769,
  "forge-multipart-cbe": 258426,
  "cb-multipart": 258426,
  "wild-nature": 320975,
  "realistic-terrain-generation": 237989,
  "the-aether-ii": 917199,
  "the-aether-ii-phosphor-not-included": 917199,
  "voidcraft": 251730,
  "voidscape": 251730
});
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_CACHE_TTL_MS = 10 * 60 * 1000;
const GITHUB_MIN_REQUEST_INTERVAL_MS = 1200;
const modrinthCache = new Map();
const curseForgeCache = new Map();
const githubCache = new Map();
let modrinthNextRequestAt = 0;
let githubNextRequestAt = 0;
let curseForgeProxyNextRequestAt = 0;
let publicProviderNextRequestAt = 0;
const publicProviderCache = new Map();
const PUBLIC_PROVIDER_CACHE_TTL_MS = 5 * 60 * 1000;
const PUBLIC_PROVIDER_MIN_REQUEST_INTERVAL_MS = 500;

const http = require("http");
const https = require("https");
const multer = require("multer");
const upload = multer({ dest: path.join(os.tmpdir(), "mikael-uploads-"), limits: { fileSize: MAX_FILE_BYTES, files: MAX_UPLOAD_FILES } });
const MAX_UPLOAD_BODY_BYTES = MAX_TOTAL_BYTES + 8 * 1024 * 1024;

function uploadBodyGuard(req, res, next) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_UPLOAD_BODY_BYTES) {
    return res.status(413).json({ error: "O upload excede o limite total de 500 MB." });
  }
  let seen = 0;
  const onData = chunk => {
    seen += chunk.length;
    if (seen > MAX_UPLOAD_BODY_BYTES) {
      req.destroy();
    }
  };
  const cleanup = () => {
    req.off("data", onData);
    req.off("end", cleanup);
    req.off("close", cleanup);
    req.off("aborted", cleanup);
  };
  req.on("data", onData);
  req.on("end", cleanup);
  req.on("close", cleanup);
  req.on("aborted", cleanup);
  next();
}

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
app.post("/api/upload-files", uploadBodyGuard, upload.array("files"), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "Nenhum arquivo foi enviado." });
  const uploadTotal = files.reduce((sum, f) => sum + Number(f.size || 0), 0);
  if (uploadTotal > MAX_TOTAL_BYTES) {
    await Promise.all(files.map(f => f.path ? fsp.rm(f.path, { force: true }).catch(() => {}) : Promise.resolve()));
    return res.status(400).json({ error: "Os arquivos selecionados ultrapassam 500 MB no total." });
  }
  const invalid = files.filter(f => !/\.(jar|zip|litemod)$/i.test(f.originalname || ""));
  if (invalid.length) {
    await Promise.all(files.map(f => f.path ? fsp.rm(f.path, { force: true }).catch(() => {}) : Promise.resolve()));
    return res.status(400).json({ error: "Envie somente arquivos .jar, .zip ou .litemod." });
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
  if (/^(?:www\.)?files\.minecraftforge\.net$/i.test(u.hostname) && /\.html?$/i.test(u.pathname)) throw new Error("Esse link é uma página HTML do Forge, não um arquivo de mod. Use o instalador .jar do Forge ou um link de mod.");
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

function parseCurseForgeFileId(parts) {
  const normalizedParts = parts.map(p => String(p).toLowerCase());
  const markerIndex = normalizedParts.findIndex((part, index) => index > -1 && (part === "download" || part === "files"));
  if (markerIndex < 0) return null;
  const raw = parts[markerIndex + 1] || "";
  return /^\d+$/.test(raw) ? Number(raw) : null;
}

function scoreCurseForgeCandidate(hit, slug) {
  const wanted = normalizeProviderText(slug);
  const hitSlug = normalizeProviderText(hit?.slug);
  const hitName = normalizeProviderText(hit?.name);
  let score = 0;
  if (hitSlug === wanted) score += 10000;
  if (hitName === wanted) score += 9000;
  if (hitSlug.replace(/-/g, "") === wanted.replace(/-/g, "")) score += 8000;
  if (hitName.replace(/-/g, "") === wanted.replace(/-/g, "")) score += 7500;
  if (hitSlug.includes(wanted) || wanted.includes(hitSlug)) score += 3000;
  if (hitName.includes(wanted) || wanted.includes(hitName)) score += 2500;
  score += Math.min(500, Math.log10(Math.max(1, Number(hit?.downloadCount || 0))) * 50);
  return score;
}

function isReleasedCurseForgeFile(file) {
  return !!file &&
    file.isAvailable !== false &&
    [4, 10].includes(Number(file.fileStatus)) &&
    file.isServerPack !== true;
}

async function resolveCurseForgeRequiredDependencies(file, context = {}) {
  if (!CURSEFORGE_API_KEY || !Array.isArray(file?.dependencies)) return [];
  const wantedVersion = String(context.minecraftVersion || "").trim();
  const loaderMap = { Forge: 1, Fabric: 4, LiteLoader: 3, Quilt: 5, NeoForge: 6 };
  const loaderType = loaderMap[String(context.modLoader || "")];
  if (!wantedVersion || !loaderType) return [];
  const required = file.dependencies.filter(dep => [3, 6].includes(Number(dep?.relationType)) && Number(dep?.modId) > 0);
  const urls = [];
  for (const dep of required.slice(0, 50)) {
    try {
      let depFiles = await curseForgeApiGet("/mods/" + Number(dep.modId) + "/files", {
        gameVersion: wantedVersion,
        modLoaderType: loaderType,
        pageSize: 50,
        sortField: 11,
        sortOrder: "desc"
      });
      let candidates = Array.isArray(depFiles)
        ? depFiles.filter(f =>
            isReleasedCurseForgeFile(f) &&
            Array.isArray(f.gameVersions) &&
            f.gameVersions.includes(wantedVersion) &&
            (!f.modLoader || Number(f.modLoader) === 0 || Number(f.modLoader) === loaderType)
          )
        : [];
      if (!candidates.length) {
        const legacy = await curseForgeApiGet("/mods/" + Number(dep.modId) + "/files", {
          gameVersion: wantedVersion,
          pageSize: 50,
          sortField: 11,
          sortOrder: "desc"
        }).catch(() => []);
        depFiles = Array.isArray(legacy) ? legacy : [];
        candidates = depFiles.filter(f =>
          isReleasedCurseForgeFile(f) &&
          Array.isArray(f.gameVersions) &&
          f.gameVersions.includes(wantedVersion) &&
          (!f.modLoader || Number(f.modLoader) === 0 || Number(f.modLoader) === loaderType)
        );
      }
      const selected = candidates.find(f => Number(f.releaseType) === 1) || candidates.find(f => Number(f.releaseType) === 2) || candidates[0];
      if (!selected) continue;
      let url = selected.downloadUrl || "";
      if (!url) url = await curseForgeApiGet("/mods/" + Number(dep.modId) + "/files/" + Number(selected.id) + "/download-url");
      if (url) urls.push(String(url));
    } catch {}
  }
  return [...new Set(urls)];
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

function publicProviderPayload(body) {
  if (body && Object.prototype.hasOwnProperty.call(body, "data")) return body.data;
  return body;
}

async function waitForPublicProviderSlot() {
  const now = Date.now();
  const slot = Math.max(now, publicProviderNextRequestAt);
  const wait = Math.max(0, slot - now);
  publicProviderNextRequestAt = slot + PUBLIC_PROVIDER_MIN_REQUEST_INTERVAL_MS;
  if (wait) await sleep(wait);
}

async function publicProviderGet(base, pathname, params = {}, cacheKey = "", label = "fonte pública") {
  const cleanBase = String(base || "").replace(/\/+$/, "");
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value ?? "")])
  ).toString();
  const key = cacheKey || cleanBase + pathname + "?" + query;
  const now = Date.now();
  if (publicProviderCache.has(key)) {
    const hit = publicProviderCache.get(key);
    if (hit.expires > now) return hit.promise ? hit.promise : hit.value;
    publicProviderCache.delete(key);
  }

  const request = (async () => {
    let lastError = null;
    for (let retry = 0; retry < API_RETRIES; retry++) {
      await waitForPublicProviderSlot();
      try {
        const response = await axios.get(cleanBase + pathname, {
          proxy: false,
          timeout: 20000,
          params,
          headers: {
            Accept: "application/json",
            "User-Agent": "Mikael-Modpack-Builder/9.0 (https://github.com/mikael8367/mikael-modpack-builder)"
          }
        });
        return publicProviderPayload(response.data);
      } catch (err) {
        lastError = err;
        const status = Number(err?.response?.status || 0);
        if (![408, 425, 429, 500, 502, 503, 504].includes(status) || retry === API_RETRIES - 1) break;
        const retryAfter = retryAfterMs(err.response?.headers || {});
        if (retryAfter > 0) await sleep(Math.min(60000, retryAfter));
        else await apiDelay(retry);
      }
    }
    const error = lastError || new Error(label + " indisponível.");
    error.publicProvider = label;
    throw error;
  })();

  publicProviderCache.set(key, {
    expires: Date.now() + PUBLIC_PROVIDER_CACHE_TTL_MS,
    promise: request
  });
  try {
    const value = await request;
    publicProviderCache.set(key, {
      expires: Date.now() + PUBLIC_PROVIDER_CACHE_TTL_MS,
      value
    });
    return value;
  } catch (err) {
    if (publicProviderCache.get(key)?.promise === request) publicProviderCache.delete(key);
    throw err;
  }
}

function curseForgePublicResolverState(context = {}) {
  if (!(context._curseForgePublicResolversTried instanceof Set)) {
    context._curseForgePublicResolversTried = new Set();
  }
  return context._curseForgePublicResolversTried;
}

async function waitForCurseForgeProxySlot() {
  const now = Date.now();
  const slot = Math.max(now, curseForgeProxyNextRequestAt);
  const wait = Math.max(0, slot - now);
  curseForgeProxyNextRequestAt = slot + CURSEFORGE_PROXY_MIN_REQUEST_INTERVAL_MS;
  if (wait) await sleep(wait);
}

async function curseForgePublicProxyGet(pathname, params = {}) {
  if (!CURSEFORGE_PUBLIC_PROXY_BASES.length) {
    const err = new Error("Nenhum proxy público do CurseForge foi configurado.");
    err.code = "CURSEFORGE_PROXY_NOT_CONFIGURED";
    throw err;
  }

  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value ?? "")])
  ).toString();

  let lastError = null;
  for (const base of CURSEFORGE_PUBLIC_PROXY_BASES) {
    const cacheKey = "cfproxy:" + base + pathname + "?" + query;
    const now = Date.now();
    if (curseForgeCache.has(cacheKey)) {
      const hit = curseForgeCache.get(cacheKey);
      if (hit.expires > now) return hit.promise ? hit.promise : hit.value;
      curseForgeCache.delete(cacheKey);
    }

    const request = (async () => {
      let error = null;
      for (let retry = 0; retry < API_RETRIES; retry++) {
        await waitForCurseForgeProxySlot();
        try {
          const response = await axios.get(base + "/v1" + pathname, {
            proxy: false,
            timeout: 20000,
            params,
            headers: {
              Accept: "application/json",
              "User-Agent": "Mikael-Modpack-Builder/9.0 (https://github.com/mikael8367/mikael-modpack-builder)"
            }
          });
          const payload = response.data && response.data.data;
          if (Array.isArray(payload) && response.data?.pagination) {
            Object.defineProperty(payload, "__pagination", {
              value: response.data.pagination,
              enumerable: false,
              configurable: true
            });
          }
          return payload;
        } catch (err) {
          error = err;
          const status = Number(err?.response?.status || 0);
          if (![429, 500, 502, 503, 504].includes(status) || retry === API_RETRIES - 1) break;
          const retryAfter = retryAfterMs(err.response?.headers || {});
          if (retryAfter > 0) await sleep(Math.min(60000, retryAfter));
          else await apiDelay(retry);
        }
      }
      throw error || new Error("Proxy público do CurseForge indisponível.");
    })();

    curseForgeCache.set(cacheKey, {
      expires: Date.now() + MODRINTH_CACHE_TTL_MS,
      promise: request
    });

    try {
      const value = await request;
      if (value != null) {
        curseForgeCache.set(cacheKey, {
          expires: Date.now() + MODRINTH_CACHE_TTL_MS,
          value
        });
      } else {
        curseForgeCache.delete(cacheKey);
      }
      return value;
    } catch (err) {
      lastError = err;
      if (curseForgeCache.get(cacheKey)?.promise === request) {
        curseForgeCache.delete(cacheKey);
      }
    }
  }

  const error = lastError || new Error("Nenhum proxy público do CurseForge respondeu.");
  error.code = error.code || "CURSEFORGE_PROXY_UNAVAILABLE";
  throw error;
}

async function curseForgeApiGet(pathname, params = {}) {
  if (!CURSEFORGE_API_KEY) {
    const err = new Error("A API oficial do CurseForge exige uma chave. O Builder usará fontes públicas de fallback.");
    err.code = "CURSEFORGE_KEY_MISSING";
    throw err;
  }
  const apiBase = CURSEFORGE_API_BASE;
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
        const response = await axios.get(apiBase + pathname, {
          proxy: false,
          timeout: 20000,
          params,
          headers: { Accept: "application/json", ...(CURSEFORGE_API_KEY ? { "x-api-key": CURSEFORGE_API_KEY } : {}), "User-Agent": "Mikael-Modpack-Builder/9.0" }
        });
        const payload = response.data && response.data.data;
        if (Array.isArray(payload) && response.data?.pagination) {
          Object.defineProperty(payload, "__pagination", { value: response.data.pagination, enumerable: false, configurable: true });
        }
        return payload;
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

async function githubWaitForSlot() {
  const now = Date.now();
  const slot = Math.max(now, githubNextRequestAt);
  const wait = Math.max(0, slot - now);
  githubNextRequestAt = slot + GITHUB_MIN_REQUEST_INTERVAL_MS;
  if (wait) await sleep(wait);
}

async function githubApiGet(pathname, config = {}, cacheKey = "") {
  const now = Date.now();
  if (cacheKey && githubCache.has(cacheKey)) {
    const hit = githubCache.get(cacheKey);
    if (hit.expires > now) return hit.value;
    githubCache.delete(cacheKey);
  }
  let lastError;
  for (let retry = 0; retry < API_RETRIES; retry++) {
    await githubWaitForSlot();
    try {
      const response = await axios.get(GITHUB_API_BASE + pathname, {
        proxy: false,
        timeout: 20000,
        ...config,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Mikael-Modpack-Builder/9.0 (https://github.com/mikael8367/mikael-modpack-builder)",
          ...(config.headers || {})
        }
      });
      const value = response.data;
      if (cacheKey) {
        if (githubCache.size >= 500) githubCache.delete(githubCache.keys().next().value);
        githubCache.set(cacheKey, { expires: Date.now() + GITHUB_CACHE_TTL_MS, value });
      }
      return value;
    } catch (err) {
      lastError = err;
      const status = Number(err?.response?.status || 0);
      if (![429, 500, 502, 503, 504].includes(status) || retry === API_RETRIES - 1) throw err;
      const retryAfter = retryAfterMs(err.response?.headers || {});
      if (retryAfter > 0) await sleep(Math.min(60000, retryAfter));
      else await apiDelay(retry);
    }
  }
  throw lastError || new Error("Falha na API pública do GitHub.");
}

function normalizeProviderText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function scoreModrinthCandidate(hit, slug) {
  const wanted = normalizeProviderText(slug);
  const hitSlug = normalizeProviderText(hit?.slug);
  const title = normalizeProviderText(hit?.title);
  let score = 0;
  if (hitSlug === wanted) score += 1000;
  if (title === wanted) score += 900;
  if (hitSlug.includes(wanted) || wanted.includes(hitSlug)) score += 500;
  if (title.includes(wanted) || wanted.includes(title)) score += 450;
  const wantedTokens = wanted.split(/\s+/).filter(Boolean);
  const combined = hitSlug + " " + title;
  score += wantedTokens.filter(t => t.length >= 3 && combined.includes(t)).length * 70;
  score += Number(hit?.downloads || 0) > 0 ? Math.min(40, Math.floor(Math.log10(Number(hit.downloads || 1) + 1) * 5)) : 0;
  return score;
}

function extractGithubRepoFromUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ""));
    if (!["github.com", "www.github.com"].includes(u.hostname.toLowerCase())) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0].trim();
    const repo = parts[1].replace(/\.git$/i, "").trim();
    if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

function githubAssetCompatible(asset, release, minecraftVersion, modLoader, projectLoaders = []) {
  const name = normalizeProviderText(asset?.name);
  const releaseText = normalizeProviderText((release?.name || "") + " " + (release?.tag_name || ""));
  const mc = normalizeProviderText(minecraftVersion).replace(/\s+/g, "");
  if (!/\.(jar|litemod|zip)$/i.test(String(asset?.name || ""))) return false;
  if (!mc || (!name.includes(mc) && !releaseText.includes(mc))) return false;
  const loader = normalizeProviderText(modLoader);
  if (loader && loader !== "outro") {
    const explicitLoader = name.includes(loader) || releaseText.includes(loader);
    const projectSupportsLoader = Array.isArray(projectLoaders) && projectLoaders.some(x => normalizeProviderText(x) === loader);
    if (!explicitLoader && !projectSupportsLoader) return false;
  }
  return Number(asset?.size || 0) > 0;
}

async function resolveGithubReleaseMirror(project, context = {}) {
  const repo = extractGithubRepoFromUrl(project?.source_url || project?.issues_url || "");
  if (!repo) return null;
  const releases = await githubApiGet(
    "/repos/" + encodeURIComponent(repo.owner) + "/" + encodeURIComponent(repo.repo) + "/releases?per_page=20",
    { timeout: 20000 },
    "releases:" + repo.owner + "/" + repo.repo
  );
  const minecraftVersion = String(context.minecraftVersion || "").trim();
  const modLoader = String(context.modLoader || "").trim();
  const projectLoaders = Array.isArray(project?.loaders) ? project.loaders : [];
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft || release.prerelease) continue;
    const candidates = (Array.isArray(release.assets) ? release.assets : [])
      .filter(asset => githubAssetCompatible(asset, release, minecraftVersion, modLoader, projectLoaders))
      .sort((a,b) => Number(b?.size || 0) - Number(a?.size || 0));
    const asset = candidates[0];
    if (!asset?.browser_download_url) continue;
    context.expectedHashes = null;
    context.expectedSize = Number(asset.size || 0) || null;
    context.publicApiFallback = true;
    context.resolvedFrom = "CurseForge → Modrinth público → GitHub release";
    context.fallbackProject = String(project?.title || project?.slug || repo.repo);
    return String(asset.browser_download_url);
  }
  return null;
}

async function resolveCurseForgeViaPublicProxy(rawUrl, context = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { return rawUrl; }
  if (!isCurseForgeHost(u.hostname)) return rawUrl;

  const parts = u.pathname.split("/").filter(Boolean);
  const normalizedParts = parts.map(p => p.toLowerCase());
  const modIndex = normalizedParts.indexOf("mc-mods");
  if (modIndex < 0 || !parts[modIndex + 1]) return rawUrl;

  let slug;
  try { slug = decodeURIComponent(parts[modIndex + 1]); } catch {
    throw new Error("Slug do CurseForge inválido.");
  }

  const wantedVersion = String(context.minecraftVersion || "").trim();
  const loaderMap = { Forge: 1, Fabric: 4, LiteLoader: 3, Quilt: 5, NeoForge: 6 };
  const loaderType = loaderMap[String(context.modLoader || "")];
  const fileId = parseCurseForgeFileId(parts.slice(modIndex + 1));

  let project = null;
  const fallbackProjectId = CURSEFORGE_PROJECT_ID_FALLBACKS[String(slug).toLowerCase()];
  if (fallbackProjectId) {
    try {
      const direct = await curseForgePublicProxyGet("/mods/" + fallbackProjectId, {});
      if (direct?.id && Number(direct.classId || 6) === 6) project = direct;
    } catch {}
  }
  if (!project) {
    const terms = curseForgeSearchTerms(slug);
    const allHits = [];
    for (const term of terms) {
      try {
        const search = await curseForgePublicProxyGet("/mods/search", {
          gameId: CURSEFORGE_GAME_ID,
          classId: 6,
          searchFilter: term,
          pageSize: 50,
          index: 0
        });
        const hits = Array.isArray(search) ? search : [];
        allHits.push(...hits);
        const ranked = hits
          .map(hit => ({ hit, score: scoreCurseForgeCandidate(hit, slug) }))
          .sort((a, b) => b.score - a.score);
        const best = ranked[0];
        if (best?.score >= 2500 && Number(best.hit?.classId || 6) === 6) {
          project = best.hit;
          break;
        }
      } catch {}
    }
    if (!project && allHits.length) {
      const ranked = allHits
        .map(hit => ({ hit, score: scoreCurseForgeCandidate(hit, slug) }))
        .sort((a, b) => b.score - a.score);
      project = ranked.find(x => x.score >= 2500 && Number(x.hit?.classId || 6) === 6)?.hit || null;
    }
  }

  if (!project?.id) throw new Error("Mod CurseForge não encontrado no proxy público: " + slug + ".");

  if (fileId) {
    const file = await curseForgePublicProxyGet("/mods/" + project.id + "/files/" + fileId);
    if (!file?.id) throw new Error("Arquivo CurseForge " + fileId + " não foi encontrado no proxy público.");
    if (!isReleasedCurseForgeFile(file)) throw new Error("O arquivo CurseForge " + fileId + " não está liberado.");
    if (wantedVersion && (!Array.isArray(file.gameVersions) || !file.gameVersions.includes(wantedVersion))) {
      throw new Error("O arquivo CurseForge " + fileId + " não suporta Minecraft " + wantedVersion + ".");
    }
    if (file.isServerPack === true) throw new Error("O arquivo CurseForge " + fileId + " é um server pack.");
    context.expectedHashes = file.hashes || null;
    context.expectedSize = Number(file.fileLength || 0) || null;
    context.publicProxyUsed = true;
    context.resolvedFrom = "CurseForge public proxy";
    context.fallbackProject = String(project.name || project.slug || slug);
    let downloadUrl = file.downloadUrl || "";
    if (!downloadUrl) {
      downloadUrl = await curseForgePublicProxyGet("/mods/" + project.id + "/files/" + fileId + "/download-url");
    }
    if (!downloadUrl) throw new Error("O proxy público não forneceu uma URL para o arquivo CurseForge " + fileId + ".");
    return String(downloadUrl);
  }

  if (!wantedVersion || !loaderType) {
    throw new Error("Para links de projeto do CurseForge, selecione Minecraft e um modloader conhecido.");
  }

  const files = await curseForgePublicProxyGet("/mods/" + project.id + "/files", {
    gameVersion: wantedVersion,
    modLoaderType: loaderType,
    pageSize: 50,
    sortField: 11,
    sortOrder: "desc"
  });

  let candidates = Array.isArray(files)
    ? files.filter(f =>
        isReleasedCurseForgeFile(f) &&
        Array.isArray(f.gameVersions) &&
        f.gameVersions.includes(wantedVersion) &&
        Number(f.modLoader || loaderType) === loaderType
      )
    : [];

  if (!candidates.length) {
    const legacyFiles = await curseForgePublicProxyGet("/mods/" + project.id + "/files", {
      gameVersion: wantedVersion,
      pageSize: 50,
      sortField: 11,
      sortOrder: "desc"
    }).catch(() => []);
    candidates = (Array.isArray(legacyFiles) ? legacyFiles : []).filter(f =>
      isReleasedCurseForgeFile(f) &&
      Array.isArray(f.gameVersions) &&
      f.gameVersions.includes(wantedVersion) &&
      (!f.modLoader || Number(f.modLoader) === 0 || Number(f.modLoader) === loaderType)
    );
  }

  const selected = candidates.find(f => Number(f.releaseType) === 1) || candidates.find(f => Number(f.releaseType) === 2) || candidates[0];
  if (!selected) {
    throw new Error("Nenhum arquivo compatível de " + slug + " foi encontrado no proxy público.");
  }

  context.expectedHashes = selected.hashes || null;
  context.expectedSize = Number(selected.fileLength || 0) || null;
  context.publicProxyUsed = true;
  context.resolvedFrom = "CurseForge public proxy";
  context.fallbackProject = String(project.name || project.slug || slug);

  let downloadUrl = selected.downloadUrl || "";
  if (!downloadUrl) {
    downloadUrl = await curseForgePublicProxyGet("/mods/" + project.id + "/files/" + selected.id + "/download-url");
  }
  if (!downloadUrl) throw new Error("O proxy público não forneceu uma URL para " + slug + ".");
  return String(downloadUrl);
}

function modpacksChLoader(loader) {
  return { Forge: "forge", Fabric: "fabric", NeoForge: "neoforge", Quilt: "quilt", LiteLoader: "liteloader" }[String(loader || "")] || "";
}

function scoreModpacksChCurseForgeCandidate(hit, slug) {
  const wanted = normalizeProviderText(slug);
  const fields = [hit?.curseSlug, hit?.slug, hit?.name, hit?.title].map(normalizeProviderText).filter(Boolean);
  let score = 0;
  for (const field of fields) {
    if (field === wanted) score = Math.max(score, 1200);
    else if (field.includes(wanted) || wanted.includes(field)) score = Math.max(score, 700);
  }
  if (String(hit?.provider || "").toLowerCase() === "curseforge") score += 5000;
  return score;
}

function modpacksChVersionMatchesMinecraft(version, minecraftVersion) {
  const wanted = String(minecraftVersion || "").trim();
  if (!wanted) return true;
  const targets = Array.isArray(version?.targets) ? version.targets : [];
  return targets.some(target =>
    String(target?.type || "").toLowerCase() === "game" &&
    String(target?.name || "").toLowerCase() === "minecraft" &&
    String(target?.version || "") === wanted
  );
}

function collectPublicVersionUrls(version) {
  const urls = [];
  const add = value => {
    const candidate = String(typeof value === "string" ? value : value?.url || value?.link || value?.href || "").trim();
    if (!/^https?:\/\//i.test(candidate) || urls.includes(candidate)) return;
    urls.push(candidate);
  };
  add(version?.url);
  for (const mirror of Array.isArray(version?.mirrors) ? version.mirrors : []) add(mirror);
  return urls;
}

async function resolveCurseForgeViaModpacksCh(rawUrl, context = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { return rawUrl; }
  if (!isCurseForgeHost(u.hostname)) return rawUrl;

  const parts = u.pathname.split("/").filter(Boolean);
  const normalizedParts = parts.map(p => p.toLowerCase());
  const modIndex = normalizedParts.indexOf("mc-mods");
  if (modIndex < 0 || !parts[modIndex + 1]) return rawUrl;

  let slug;
  try { slug = decodeURIComponent(parts[modIndex + 1]); } catch {
    throw new Error("Slug do CurseForge inválido.");
  }

  const wantedVersion = String(context.minecraftVersion || "").trim();
  const loader = modpacksChLoader(context.modLoader);
  const fileId = parseCurseForgeFileId(parts.slice(modIndex + 1));
  const searchPath = wantedVersion && loader
    ? "/public/mod/search/" + encodeURIComponent(wantedVersion) + "/" + encodeURIComponent(loader) + "/50"
    : "/public/mod/search/50";

  let mods = [];
  for (const term of curseForgeSearchTerms(slug)) {
    try {
      const search = await publicProviderGet(
        MODPACKS_CH_API_BASE,
        searchPath,
        { term },
        "modpacksch:curseforge-search:" + term + ":" + wantedVersion + ":" + loader,
        "Modpacks.ch"
      );
      const foundMods = Array.isArray(search?.mods) ? search.mods : [];
      mods.push(...foundMods);
      if (foundMods.some(m => normalizeProviderText(m?.curseSlug || m?.slug) === normalizeProviderText(slug))) break;
    } catch {}
  }
  const curseMods = mods.filter(m => String(m?.provider || "").toLowerCase() === "curseforge");
  const ranked = (curseMods.length ? curseMods : mods)
    .map(hit => ({ hit, score: scoreModpacksChCurseForgeCandidate(hit, slug) }))
    .sort((a, b) => b.score - a.score);
  const project = ranked[0]?.hit || null;
  if (!project?.id) throw new Error("Modpacks.ch não encontrou o projeto CurseForge '" + slug + "'.");

  let versions = Array.isArray(project.versions) ? project.versions.slice() : [];
  if (wantedVersion && loader && (!versions.length || !versions.some(v => modpacksChVersionMatchesMinecraft(v, wantedVersion)))) {
    try {
      const versionData = await publicProviderGet(
        MODPACKS_CH_API_BASE,
        "/public/mod/" + encodeURIComponent(project.id) + "/versions/" + encodeURIComponent(wantedVersion) + "/" + encodeURIComponent(loader),
        {},
        "modpacksch:curseforge-versions:" + project.id + ":" + wantedVersion + ":" + loader,
        "Modpacks.ch"
      );
      if (Array.isArray(versionData?.versions)) versions = versionData.versions;
    } catch {}
  }

  const clientCompatible = versions.filter(v =>
    v &&
    (!wantedVersion || modpacksChVersionMatchesMinecraft(v, wantedVersion)) &&
    v.serveronly !== true
  );

  let selected = fileId ? clientCompatible.find(v => Number(v.id) === fileId) : null;
  if (!selected) {
    selected = clientCompatible.find(v => String(v.type || "").toLowerCase() === "release") || clientCompatible[0] || null;
  }
  if (!selected) throw new Error("Modpacks.ch não encontrou arquivo compatível de " + slug + " para Minecraft " + (wantedVersion || "selecionado") + ".");

  const urls = collectPublicVersionUrls(selected);
  if (!urls.length) throw new Error("Modpacks.ch encontrou o arquivo, mas não forneceu URL pública para " + slug + ".");

  context.expectedHashes = selected.sha1 ? { sha1: String(selected.sha1).toLowerCase() } : null;
  context.expectedSize = Number(selected.size || 0) || null;
  context.publicApiFallback = true;
  context.publicSourceActive = true;
  context.resolvedFrom = "Modpacks.ch público";
  context.fallbackProject = String(project.name || project.title || slug);
  context.publicAlternativeUrls = urls.slice(1);
  return urls[0];
}

async function resolveCurseForgeViaModrinth(rawUrl, context = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { return rawUrl; }
  if (!isCurseForgeHost(u.hostname)) return rawUrl;

  const parts = u.pathname.split("/").filter(Boolean);
  const normalizedParts = parts.map(p => p.toLowerCase());
  const modIndex = normalizedParts.indexOf("mc-mods");
  if (modIndex < 0 || !parts[modIndex + 1]) return rawUrl;

  let slug;
  try { slug = decodeURIComponent(parts[modIndex + 1]); } catch { throw new Error("Slug do CurseForge inválido."); }

  const wantedVersion = String(context.minecraftVersion || "").trim();
  const wantedLoader = modrinthLoader(context.modLoader);
  if (!wantedVersion || !wantedLoader) {
    throw new Error("Para o fallback público do CurseForge, selecione Minecraft e um modloader compatível.");
  }

  let project = null;
  try {
    project = await modrinthApiGet(
      "https://api.modrinth.com/v2/project/" + encodeURIComponent(slug),
      { timeout: 20000, headers: { Accept: "application/json", "User-Agent": "Mikael-Modpack-Builder/9.0 (https://github.com/mikael8367/mikael-modpack-builder)" } },
      "cf-fallback-project:" + slug
    );
  } catch (err) {
    const status = Number(err?.response?.status || 0);
    if (status !== 404) throw new Error("A API pública do Modrinth não conseguiu consultar " + slug + " (HTTP " + (status || "erro") + ").");
  }

  if (!project) {
    const allHits = [];
    for (const term of curseForgeSearchTerms(slug)) {
      try {
        const search = await modrinthApiGet(
          "https://api.modrinth.com/v2/search",
          {
            params: {
              query: term.replace(/[-_]+/g, " "),
              facets: JSON.stringify([["project_type:mod"], ["versions:" + wantedVersion], ["categories:" + wantedLoader]]),
              index: "downloads",
              offset: 0,
              limit: 20
            },
            timeout: 20000,
            headers: { Accept: "application/json", "User-Agent": "Mikael-Modpack-Builder/9.0 (https://github.com/mikael8367/mikael-modpack-builder)" }
          },
          "cf-fallback-search:" + term + ":" + wantedVersion + ":" + wantedLoader
        );
        allHits.push(...(Array.isArray(search?.hits) ? search.hits : []));
      } catch {}
    }
    const scored = allHits
      .map(hit => ({ hit, score: scoreModrinthCandidate(hit, slug) }))
      .sort((a,b) => b.score - a.score);
    project = scored[0]?.hit || null;
  }

  if (!project || !project.id) {
    throw new Error("O mod '" + slug + "' não foi encontrado em uma fonte pública compatível.");
  }

  const versions = await modrinthApiGet(
    "https://api.modrinth.com/v2/project/" + encodeURIComponent(project.id) + "/version",
    {
      params: {
        loaders: JSON.stringify([wantedLoader]),
        game_versions: JSON.stringify([wantedVersion]),
        include_changelog: false
      },
      timeout: 20000,
      headers: { Accept: "application/json", "User-Agent": "Mikael-Modpack-Builder/9.0 (https://github.com/mikael8367/mikael-modpack-builder)" }
    },
    "cf-fallback-versions:" + project.id + ":" + wantedVersion + ":" + wantedLoader
  );

  const candidates = Array.isArray(versions)
    ? versions.filter(v =>
        v &&
        v.status === "listed" &&
        Array.isArray(v.files) &&
        v.files.length &&
        Array.isArray(v.game_versions) && v.game_versions.includes(wantedVersion) &&
        Array.isArray(v.loaders) && v.loaders.includes(wantedLoader) &&
        isClientCompatibleEnvironment(v.environment)
      )
    : [];

  const selected = candidates.find(v => v.version_type === "release") || candidates[0];
  if (selected) {
    const usableFiles = selected.files.filter(f =>
      f && f.url && !["sources-jar", "dev-jar", "javadoc-jar", "signature"].includes(String(f.file_type || "").toLowerCase())
    );
    const primary = usableFiles.find(f => f.primary) || usableFiles[0];
    if (primary?.url) {
      context.expectedHashes = primary.hashes || null;
      context.expectedSize = Number(primary.size || 0) || null;
      context.publicApiFallback = true;
      context.resolvedFrom = "CurseForge → Modrinth público";
      context.fallbackProject = String(project.title || project.slug || slug);
      const fileUrl = new URL(String(primary.url));
      if (fileUrl.hostname.toLowerCase().includes("cdn.modrinth.com") && !fileUrl.searchParams.has("mr_download_reason")) {
        fileUrl.searchParams.set("mr_download_reason", "mikael-modpack-builder");
      }
      return fileUrl.toString();
    }
  }

  const githubMirror = await resolveGithubReleaseMirror(project, context).catch(() => null);
  if (githubMirror) return githubMirror;

  throw new Error("O mod '" + slug + "' foi localizado publicamente, mas não há arquivo compatível com Minecraft " + wantedVersion + " + " + context.modLoader + " em Modrinth/GitHub.");
}


async function resolveCurseForgeUrl(rawUrl, context = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { return rawUrl; }
  if (!isCurseForgeHost(u.hostname)) return rawUrl;

  // Sem chave oficial, tenta várias fontes públicas independentes.
  if (!CURSEFORGE_API_KEY) {
    const tried = curseForgePublicResolverState(context);
    const publicResolvers = [
      ["modpacksch", () => resolveCurseForgeViaModpacksCh(rawUrl, context)],
      ["mcim", () => resolveCurseForgeViaPublicProxy(rawUrl, context)],
      ["modrinth", () => resolveCurseForgeViaModrinth(rawUrl, context)]
    ];
    const errors = [];
    for (const [name, resolver] of publicResolvers) {
      if (tried.has(name)) continue;
      tried.add(name);
      try {
        const resolved = await resolver();
        if (resolved && resolved !== rawUrl) return resolved;
      } catch (err) {
        errors.push(String(err?.message || err));
      }
    }
    const fallbackParts = u.pathname.split("/").filter(Boolean).map(part => part.toLowerCase());
    if (fallbackParts.includes("download") || fallbackParts.includes("files")) {
      context.expectedHashes = null;
      context.expectedSize = null;
      context.publicSourceActive = false;
      context.resolvedFrom = "CurseForge direto (último recurso)";
      return rawUrl;
    }
    throw new Error(errors.length
      ? "Nenhuma fonte pública encontrou um arquivo utilizável para este mod CurseForge: " + errors.join(" | ")
      : "Nenhuma fonte pública foi configurada para este mod CurseForge.");
  }

  const parts = u.pathname.split("/").filter(Boolean);
  const normalizedParts = parts.map(p => p.toLowerCase());
  const modIndex = normalizedParts.indexOf("mc-mods");
  if (modIndex < 0 || !parts[modIndex + 1]) return rawUrl;
  let slug;
  try { slug = decodeURIComponent(parts[modIndex + 1]); } catch { throw new Error("Slug do CurseForge inválido."); }
  const fileId = parseCurseForgeFileId(parts.slice(modIndex + 1));

  try {
    const wantedVersion = String(context.minecraftVersion || "").trim();
    const loaderMap = { Forge: 1, Fabric: 4, LiteLoader: 3, Quilt: 5, NeoForge: 6 };
    const loaderType = loaderMap[String(context.modLoader || "")];
    let officialHits = [];
    let found = null;

    // A API documenta slug + classId como lookup único. Faça esse caminho primeiro.
    try {
      const exactResponse = await curseForgeApiGet("/mods/search", {
        gameId: CURSEFORGE_GAME_ID,
        classId: 6,
        slug,
        pageSize: 50,
        index: 0
      });
      const exactHits = Array.isArray(exactResponse) ? exactResponse : [];
      officialHits.push(...exactHits);
      found = exactHits.find(hit =>
        Number(hit?.classId || 6) === 6 &&
        normalizeProviderText(hit?.slug) === normalizeProviderText(slug)
      ) || null;
    } catch {}

    // Alguns projetos antigos têm busca por slug instável. Use o ID oficial conhecido.
    const fallbackProjectId = CURSEFORGE_PROJECT_ID_FALLBACKS[String(slug).toLowerCase()];
    if (!found && fallbackProjectId) {
      try {
        const fallbackProject = await curseForgeApiGet("/mods/" + fallbackProjectId);
        if (fallbackProject?.id && Number(fallbackProject.classId || 6) === 6) found = fallbackProject;
      } catch {}
    }

    // Último caminho: pesquisa textual com aliases/normalizações.
    if (!found) {
      for (const term of curseForgeSearchTerms(slug)) {
        try {
          const extra = await curseForgeApiGet("/mods/search", {
            gameId: CURSEFORGE_GAME_ID,
            classId: 6,
            searchFilter: term,
            gameVersion: wantedVersion || undefined,
            modLoaderType: loaderType || undefined,
            pageSize: 50,
            index: 0
          });
          const hits = Array.isArray(extra) ? extra : [];
          officialHits.push(...hits);
          const ranked = hits
            .map(hit => ({ hit, score: scoreCurseForgeCandidate(hit, slug) }))
            .filter(x => Number(x.hit?.classId || 6) === 6)
            .sort((a, b) => b.score - a.score);
          const best = ranked[0];
          if (best?.score >= 2500) {
            found = best.hit;
            break;
          }
        } catch {}
      }
    }
    if (!found || !found.id) {
      const tried = curseForgePublicResolverState(context);
      const fallbacks = [
        ["modpacksch", () => resolveCurseForgeViaModpacksCh(rawUrl, context)],
        ["mcim", () => resolveCurseForgeViaPublicProxy(rawUrl, context)],
        ["modrinth", () => resolveCurseForgeViaModrinth(rawUrl, context)]
      ];
      for (const [name, resolver] of fallbacks) {
        if (tried.has(name)) continue;
        tried.add(name);
        try {
          const resolved = await resolver();
          if (resolved && resolved !== rawUrl) return resolved;
        } catch {}
      }
      throw new Error("Mod CurseForge não encontrado: " + slug);
    }

    if (fileId) {
      const file = await curseForgeApiGet("/mods/" + found.id + "/files/" + fileId);
      if (!file || !file.id) throw new Error("Arquivo CurseForge " + fileId + " não foi encontrado.");
      if (!isReleasedCurseForgeFile(file)) throw new Error("O arquivo CurseForge " + fileId + " não está liberado para download.");
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

    if (!loaderType) throw new Error("Para links de projeto do CurseForge, selecione um modloader conhecido ou use uma URL direta do arquivo.");
    let files = await curseForgeApiGet("/mods/" + found.id + "/files", {
      gameVersion: String(context.minecraftVersion || ""),
      modLoaderType: loaderType,
      pageSize: 50,
      sortField: 11,
      sortOrder: "desc"
    });
    let candidates = Array.isArray(files)
      ? files.filter(f =>
          isReleasedCurseForgeFile(f) &&
          Array.isArray(f.gameVersions) &&
          f.gameVersions.includes(String(context.minecraftVersion || "")) &&
          Number(f.modLoader || loaderType) === loaderType
        )
      : [];

    // Old 1.12.2 CurseForge files often have no modLoader metadata. If the
    // loader-filtered endpoint returns nothing, query by Minecraft version
    // alone and apply the compatibility check locally.
    if (!candidates.length) {
      const legacyFiles = await curseForgeApiGet("/mods/" + found.id + "/files", {
        gameVersion: String(context.minecraftVersion || ""),
        pageSize: 50,
        sortField: 11,
        sortOrder: "desc"
      });
      files = Array.isArray(legacyFiles) ? legacyFiles : [];
      candidates = files.filter(f =>
        isReleasedCurseForgeFile(f) &&
        Array.isArray(f.gameVersions) &&
        f.gameVersions.includes(String(context.minecraftVersion || "")) &&
        (!f.modLoader || Number(f.modLoader) === 0 || Number(f.modLoader) === loaderType)
      );
    }
    const usable = candidates.filter(isReleasedCurseForgeFile);
    const selected = usable.find(f => Number(f.releaseType) === 1) || usable.find(f => Number(f.releaseType) === 2) || usable[0];
    if (!selected) {
      const tried = curseForgePublicResolverState(context);
      const fallbacks = [
        ["modpacksch", () => resolveCurseForgeViaModpacksCh(rawUrl, context)],
        ["mcim", () => resolveCurseForgeViaPublicProxy(rawUrl, context)],
        ["modrinth", () => resolveCurseForgeViaModrinth(rawUrl, context)]
      ];
      for (const [name, resolver] of fallbacks) {
        if (tried.has(name)) continue;
        tried.add(name);
        try {
          const resolved = await resolver();
          if (resolved && resolved !== rawUrl) return resolved;
        } catch {}
      }
      throw new Error("Nenhum arquivo de mod compatível de " + slug + " foi encontrado para Minecraft " + (context.minecraftVersion || "selecionado") + ".");
    }
    context.expectedHashes = selected.hashes || null;
    context.expectedSize = Number(selected.fileLength || 0) || null;
    let selectedDownloadUrl = selected.downloadUrl || "";
    if (!selectedDownloadUrl) {
      selectedDownloadUrl = await curseForgeApiGet("/mods/" + found.id + "/files/" + selected.id + "/download-url");
    }
    if (!selectedDownloadUrl) throw new Error("O arquivo de " + slug + " não possui URL de download disponível.");
    context.dependencyUrls = await resolveCurseForgeRequiredDependencies(selected, context);
    return String(selectedDownloadUrl);
  } catch (err) {
    const status = Number(err?.response?.status || 0);
    if (status === 401 || status === 403) {
      const tried = curseForgePublicResolverState(context);
      const publicResolvers = [
        ["modpacksch", () => resolveCurseForgeViaModpacksCh(rawUrl, context)],
        ["mcim", () => resolveCurseForgeViaPublicProxy(rawUrl, context)],
        ["modrinth", () => resolveCurseForgeViaModrinth(rawUrl, context)]
      ];
      for (const [name, resolver] of publicResolvers) {
        if (tried.has(name)) continue;
        tried.add(name);
        try {
          const resolved = await resolver();
          if (resolved) return resolved;
        } catch {}
      }
      throw err;
    }
    throw err;
  }
}

function isModrinthHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "modrinth.com" || h === "www.modrinth.com" || h.endsWith(".modrinth.com") || h === "cdn.modrinth.com" || h.endsWith(".cdn.modrinth.com");
}

function isClientCompatibleEnvironment(environment) {
  return !["server_only", "dedicated_server_only", "server_only_client_optional"].includes(String(environment || "").toLowerCase());
}

function isKnownModrinthLoader(loader) {
  return ["forge", "fabric", "neoforge", "quilt", "liteloader"].includes(String(loader || "").toLowerCase());
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
  if (selectedLoader && !isKnownModrinthLoader(loader) && !u.hostname.toLowerCase().includes("cdn.modrinth.com")) {
    throw new Error("Para o modloader " + selectedLoader + ", use uma URL direta do arquivo do Modrinth; esse loader não é reconhecido pela API.");
  }

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
        headers: { Accept: "application/json", "User-Agent": "Mikael-Modpack-Builder/9.0" }
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
        headers: { Accept: "application/json", "User-Agent": "Mikael-Modpack-Builder/9.0" }
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
        { timeout: 20000, headers: { Accept: "application/json", "User-Agent": "Mikael-Modpack-Builder/9.0" } },
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

function rewriteCurseForgeCdnMirror(rawUrl, context = {}) {
  // MCIM documents these CDN host replacements for public mirror downloads.
  // Keep the official CDN when an official key is configured and no fallback was used.
  if (CURSEFORGE_API_KEY && !context.publicSourceActive && !context.publicApiFallback && !context.publicProxyUsed) return rawUrl;
  try {
    const url = new URL(String(rawUrl || ""));
    const host = url.hostname.toLowerCase();
    if (host === "edge.forgecdn.net" || host === "mediafilez.forgecdn.net") {
      url.hostname = "mod.mcimirror.top";
      return url.toString();
    }
  } catch {}
  return rawUrl;
}

function alternateCurseForgeCdnUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ""));
    const host = u.hostname.toLowerCase();
    if (host === "edge.forgecdn.net") {
      u.hostname = "mediafilez.forgecdn.net";
      return u.toString();
    }
    if (host === "mediafilez.forgecdn.net") {
      u.hostname = "edge.forgecdn.net";
      return u.toString();
    }
    return "";
  } catch {
    return "";
  }
}

async function requestFile(rawUrl, context = {}) {
  let current = await resolveCurseForgeUrl(rawUrl, context);
  current = await resolveModrinthUrl(current, context);
  current = rewriteCurseForgeCdnMirror(current, context);
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
      "User-Agent": "Mikael-Modpack-Builder/9.0 (https://github.com/mikael8367/mikael-modpack-builder)",
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
      if ([401, 403, 404, 408, 425, 429, 500, 502, 503, 504].includes(status) &&
          (isCurseForgeHost(checked.url.hostname) ||
           checked.url.hostname.toLowerCase().endsWith("forgecdn.net") ||
           checked.url.hostname.toLowerCase().endsWith("mod.mcimirror.top") ||
           context.publicSourceActive)) {
        if (checked.url.hostname.toLowerCase().endsWith("forgecdn.net")) {
          const alt = alternateCurseForgeCdnUrl(checked.url.toString());
          const triedCdn = context._curseForgeCdnUrlsTried instanceof Set
            ? context._curseForgeCdnUrlsTried
            : (context._curseForgeCdnUrlsTried = new Set());
          if (alt && !triedCdn.has(alt)) {
            triedCdn.add(alt);
            current = alt;
            continue;
          }
        }
        const tried = curseForgePublicResolverState(context);
        const publicResolvers = [
          ["modpacksch", () => resolveCurseForgeViaModpacksCh(rawUrl, context)],
          ["mcim", () => resolveCurseForgeViaPublicProxy(rawUrl, context)],
          ["modrinth", () => resolveCurseForgeViaModrinth(rawUrl, context)]
        ];
        let switched = false;
        for (const [name, resolver] of publicResolvers) {
          if (tried.has(name)) continue;
          tried.add(name);
          try {
            const fallbackUrl = await resolver();
            if (fallbackUrl && fallbackUrl !== current) {
              current = await resolveModrinthUrl(fallbackUrl, context);
              switched = true;
              break;
            }
          } catch {}
        }
        if (switched) continue;
        context.expectedHashes = null;
        context.expectedSize = null;
        throw new Error("As fontes públicas do CurseForge recusaram ou não entregaram o arquivo (HTTP " + status + "). O Builder tentou Modpacks.ch, MCIM, Modrinth e GitHub.");
      }
      throw err;
    }
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.location;
      response.data.destroy();
      if (!location) throw new Error("Redirecionamento sem destino.");
      current = rewriteCurseForgeCdnMirror(new URL(location, checked.url).toString(), context);
      continue;
    }
    const contentType = String(response.headers["content-type"] || "").toLowerCase();
    if (contentType.includes("text/html")) {
      response.data.destroy();
      if (isModrinthDownload) {
        throw new Error("O CDN do Modrinth respondeu uma página HTML em vez do arquivo. O resolvedor foi atualizado; tente novamente com o link do projeto Modrinth.");
      }
      if (isCurseForgeHost(checked.url.hostname)) throw new Error("O link do CurseForge não entregou um arquivo. As fontes públicas também não encontraram um arquivo utilizável.");
      throw new Error("O link não entregou um arquivo. O servidor esperava um .jar/.zip, mas recebeu HTML.");
    }
    const length = Number(response.headers["content-length"] || 0);
    if (length > MAX_FILE_BYTES) {
      response.data.destroy();
      throw new Error("Arquivo maior que " + Math.round(MAX_FILE_BYTES / 1024 / 1024) + " MB.");
    }
    return { response, url: checked.url };
  }

  const attempted = context._curseForgeCdnAlternatesTried instanceof Set
    ? context._curseForgeCdnAlternatesTried
    : (context._curseForgeCdnAlternatesTried = new Set());

  const tryUrl = async candidate => {
    const value = String(candidate || "").trim();
    if (!/^https?:\/\//i.test(value) || attempted.has(value)) return null;
    attempted.add(value);
    try {
      return await requestFile(value, context);
    } catch {}
    return null;
  };

  const officialAlt = alternateCurseForgeCdnUrl(current);
  const switchedOfficial = await tryUrl(officialAlt);
  if (switchedOfficial) return switchedOfficial;

  for (const alternative of Array.isArray(context.publicAlternativeUrls) ? context.publicAlternativeUrls : []) {
    const switched = await tryUrl(alternative);
    if (switched) return switched;
  }

  const providers = [
    ["modpacksch", () => resolveCurseForgeViaModpacksCh(rawUrl, context)],
    ["mcim", () => resolveCurseForgeViaPublicProxy(rawUrl, context)],
    ["modrinth", () => resolveCurseForgeViaModrinth(rawUrl, context)]
  ];
  const tried = curseForgePublicResolverState(context);
  for (const [name, resolver] of providers) {
    if (tried.has(name)) continue;
    tried.add(name);
    try {
      const fallbackUrl = await resolver();
      if (!fallbackUrl) continue;
      const switched = await tryUrl(fallbackUrl);
      if (switched) return switched;
    } catch {}
  }

  throw new Error("Muitos redirecionamentos no download do CurseForge. Foram tentadas URLs CDN alternativas e fontes públicas.");
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
    const headSig = head.readUInt32LE(0);
    const localFileSig = 0x04034b50;
    const emptyOrEocdSig = 0x06054b50;
    const zip64RecordSig = 0x06064b50;
    if (![localFileSig, emptyOrEocdSig].includes(headSig) && headSig !== zip64RecordSig) return false;
    const tailSize = Math.min(stat.size, 22 + 65535);
    const tail = Buffer.alloc(tailSize);
    const tailRead = await handle.read(tail, 0, tailSize, stat.size - tailSize);
    if (tailRead.bytesRead < 22) return false;
    const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
    const eocdPos = tail.lastIndexOf(eocd);
    if (eocdPos >= 0) {
      if (eocdPos + 22 > tail.length) return false;
      const totalEntries = tail.readUInt16LE(eocdPos + 10);
      return totalEntries > 0;
    }
    return tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])) >= 0 && stat.size >= 56;
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




function curseForgeLoaderType(loader) {
  return { Forge: 1, LiteLoader: 3, Fabric: 4, Quilt: 5, NeoForge: 6 }[String(loader || "")] || 0;
}

function modrinthSearchFacets(minecraftVersion, modLoader) {
  const loader = modrinthLoader(modLoader);
  const facets = [["project_type:mod"], ["versions:" + minecraftVersion]];
  if (loader) facets.push(["categories:" + loader]);
  return JSON.stringify(facets);
}

async function getModrinthSearchPage(q, minecraftVersion, modLoader, page) {
  const loader = modrinthLoader(modLoader);
  const facets = [["project_type:mod"]];
  if (minecraftVersion) facets.push(["versions:" + minecraftVersion]);
  if (loader) facets.push(["categories:" + loader]);
  const limit = 20;
  const offset = Math.max(0, Number(page || 0)) * limit;
  const data = await modrinthApiGet(
    "https://api.modrinth.com/v2/search",
    {
      params: { query: String(q || ""), facets: JSON.stringify(facets), index: "downloads", offset, limit },
      timeout: 20000,
      headers: { Accept: "application/json", "User-Agent": "Mikael-Modpack-Builder/9.0 (https://github.com/mikael8367/mikael-modpack-builder)" }
    },
    "mod-search-public:" + String(q || "") + ":" + minecraftVersion + ":" + loader + ":" + page
  );
  const hits = Array.isArray(data?.hits) ? data.hits : [];
  return {
    results: hits.map(x => ({
      id: x.project_id || x.id,
      title: x.title || x.slug || "Mod",
      description: x.description || "",
      icon: x.icon_url || "",
      downloads: Number(x.downloads || 0),
      source: "modrinth"
    })).filter(x => x.id),
    total: Number(data?.total_hits || hits.length)
  };
}

app.get("/api/mod-search", async (req, res) => {
  const source = String(req.query.source || "modrinth").toLowerCase();
  const q = String(req.query.q || "").trim();
  const minecraftVersion = String(req.query.minecraftVersion || "").trim();
  const modLoader = String(req.query.modLoader || "").trim();
  const page = Math.max(0, Math.min(499, Number(req.query.page || 0) || 0));
  if (!minecraftVersion || !modLoader) return res.status(400).json({ error: "Escolha Minecraft e modloader antes de pesquisar." });

  try {
    if (source === "curseforge" && CURSEFORGE_API_KEY) {
      const loaderType = curseForgeLoaderType(modLoader);
      if (!loaderType) return res.status(400).json({ error: "Modloader incompatível com a API do CurseForge." });
      const data = await curseForgeApiGet("/mods/search", {
        gameId: CURSEFORGE_GAME_ID, classId: 6, searchFilter: q, gameVersion: minecraftVersion,
        modLoaderType: loaderType, sortField: 2, sortOrder: "desc", index: page * 20, pageSize: 20
      });
      const results = Array.isArray(data) ? data.map(x => ({
        id: x.id, title: x.name || "Mod", description: x.summary || "", icon: x.logo?.url || "",
        downloads: Number(x.downloadCount || 0), source: "curseforge"
      })) : [];
      return res.json({ results, total: Number(data?.__pagination?.totalCount || results.length), publicFallback: false });
    }
    const fallback = await getModrinthSearchPage(q, minecraftVersion, modLoader, page);
    return res.json({
      ...fallback,
      publicFallback: source === "curseforge",
      message: source === "curseforge" ? "Sem chave CurseForge: mostrando resultados públicos equivalentes do Modrinth." : undefined
    });
  } catch (e) {
    const status = Number(e?.response?.status || 0);
    res.status(status === 429 ? 429 : 502).json({ error: e.message || "Falha ao pesquisar mods." });
  }
});

app.get("/api/mod-versions", async (req, res) => {
  const source = String(req.query.source || "modrinth").toLowerCase();
  const projectId = String(req.query.projectId || "").trim();
  const minecraftVersion = String(req.query.minecraftVersion || "").trim();
  const modLoader = String(req.query.modLoader || "").trim();
  if (!projectId || !minecraftVersion || !modLoader) return res.status(400).json({ error: "Dados insuficientes para listar versões." });

  try {
    if (source === "curseforge" && CURSEFORGE_API_KEY) {
      const loaderType = curseForgeLoaderType(modLoader);
      if (!loaderType) return res.status(400).json({ error: "Modloader incompatível com a API do CurseForge." });
      const data = await curseForgeApiGet("/mods/" + encodeURIComponent(projectId) + "/files", {
        gameVersion: minecraftVersion, modLoaderType: loaderType, pageSize: 50, sortField: 11, sortOrder: "desc"
      });
      const files = Array.isArray(data) ? data.filter(f =>
        isReleasedCurseForgeFile(f) && Array.isArray(f.gameVersions) && f.gameVersions.includes(minecraftVersion) && f.downloadUrl
      ) : [];
      return res.json({
        versions: files.map(f => ({
          id: f.id, name: f.displayName || f.fileName || String(f.id), versionNumber: f.gameVersions?.[0] || "",
          type: Number(f.releaseType) === 1 ? "release" : Number(f.releaseType) === 2 ? "beta" : "alpha",
          filename: f.fileName || "", downloadUrl: f.downloadUrl
        })),
        publicFallback: false
      });
    }
    const loader = modrinthLoader(modLoader);
    if (!loader) return res.status(400).json({ error: "Modloader não suportado pela API pública do Modrinth." });
    const versions = await modrinthApiGet(
      "https://api.modrinth.com/v2/project/" + encodeURIComponent(projectId) + "/version",
      {
        params: { loaders: JSON.stringify([loader]), game_versions: JSON.stringify([minecraftVersion]), include_changelog: false },
        timeout: 20000,
        headers: { Accept: "application/json", "User-Agent": "Mikael-Modpack-Builder/9.0 (https://github.com/mikael8367/mikael-modpack-builder)" }
      },
      "mod-versions-public:" + projectId + ":" + minecraftVersion + ":" + loader
    );
    const out = (Array.isArray(versions) ? versions : []).filter(v =>
      v && v.status === "listed" && Array.isArray(v.files) && v.files.length &&
      Array.isArray(v.game_versions) && v.game_versions.includes(minecraftVersion) &&
      Array.isArray(v.loaders) && v.loaders.includes(loader) && isClientCompatibleEnvironment(v.environment)
    );
    return res.json({
      versions: out.map(v => {
        const usable = v.files.filter(f => f && f.url && !["sources-jar","dev-jar","javadoc-jar","signature"].includes(String(f.file_type || "").toLowerCase()));
        const primary = usable.find(f => f.primary) || usable[0];
        return {
          id: v.id, name: v.name || v.version_number || v.id, versionNumber: v.version_number || v.id,
          type: v.version_type || "release", filename: primary?.filename || "", downloadUrl: primary?.url || ""
        };
      }).filter(v => v.downloadUrl),
      publicFallback: source === "curseforge"
    });
  } catch (e) {
    const status = Number(e?.response?.status || 0);
    res.status(status === 429 ? 429 : 502).json({ error: e.message || "Falha ao listar versões." });
  }
});

app.get("/api/curseforge-status", async (req, res) => {
  const providers = [];

  try {
    await publicProviderGet(MODPACKS_CH_API_BASE, "/health", {}, "public-api-status:modpacksch-health", "Modpacks.ch");
    providers.push({ name: "Modpacks.ch público", ok: true, status: 200, code: "OK" });
  } catch (e) {
    providers.push({ name: "Modpacks.ch público", ok: false, status: Number(e?.response?.status || 0), code: "UNAVAILABLE" });
  }

  if (CURSEFORGE_API_KEY) {
    try {
      await curseForgeApiGet("/mods/search", {
        gameId: CURSEFORGE_GAME_ID,
        classId: 6,
        pageSize: 1,
        index: 0
      });
      providers.push({ name: "CurseForge oficial", ok: true, status: 200, code: "OK" });
    } catch (e) {
      providers.push({
        name: "CurseForge oficial",
        ok: false,
        status: Number(e?.response?.status || 0),
        code: Number(e?.response?.status || 0) === 403 ? "FORBIDDEN" : "ERROR"
      });
    }
  } else {
    providers.push({ name: "CurseForge oficial", ok: false, status: 0, code: "NO_KEY" });
  }

  for (const base of CURSEFORGE_PUBLIC_PROXY_BASES) {
    try {
      await curseForgePublicProxyGet("/mods/search", {
        gameId: CURSEFORGE_GAME_ID,
        classId: 6,
        pageSize: 1,
        index: 0
      });
      providers.push({ name: base.includes("mcimirror.top") ? "MCIM público" : "Proxy público CurseForge", ok: true, status: 200, code: "OK", endpoint: base });
    } catch (e) {
      providers.push({
        name: "CurseForge public proxy",
        ok: false,
        status: Number(e?.response?.status || 0),
        code: "UNAVAILABLE",
        endpoint: base
      });
    }
  }

  try {
    await modrinthApiGet(
      "https://api.modrinth.com/v2/search",
      {
        params: {
          query: "journeymap",
          facets: JSON.stringify([["project_type:mod"], ["versions:1.12.2"], ["categories:forge"]]),
          limit: 1,
          offset: 0
        },
        timeout: 15000,
        headers: {
          Accept: "application/json",
          "User-Agent": "Mikael-Modpack-Builder/9.0 (https://github.com/mikael8367/mikael-modpack-builder)"
        }
      },
      "public-api-status:1.12.2:forge"
    );
    providers.push({ name: "Modrinth público", ok: true, status: 200, code: "OK" });
  } catch (e) {
    providers.push({
      name: "Modrinth público",
      ok: false,
      status: Number(e?.response?.status || 0),
      code: "UNAVAILABLE"
    });
  }

  try {
    await githubApiGet("/rate_limit", {}, "public-github-status");
    providers.push({ name: "GitHub público", ok: true, status: 200, code: "OK" });
  } catch (e) {
    providers.push({
      name: "GitHub público",
      ok: false,
      status: Number(e?.response?.status || 0),
      code: "UNAVAILABLE"
    });
  }

  const usable = providers.filter(p => p.ok);
  const publicUsable = providers.filter(p => p.ok && p.name !== "CurseForge oficial");

  return res.status(usable.length ? 200 : 502).json({
    ok: usable.length > 0,
    publicApi: publicUsable.length > 0,
    status: usable.length ? 200 : 502,
    providers,
    message: usable.length
      ? "Fontes de download disponíveis: " + usable.map(p => p.name).join(", ") + "."
      : "Nenhuma fonte pública respondeu."
  });
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

function addJobLog(job, level, message, details = {}) {
  if (!job) return;
  if (!Array.isArray(job.logs)) job.logs = [];
  const safeDetails = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (value == null || typeof value === "number" || typeof value === "boolean") safeDetails[key] = value;
    else if (typeof value === "string") safeDetails[key] = /url/i.test(key) ? redactUrl(value) : value.slice(0, 1200);
    else safeDetails[key] = JSON.stringify(value).slice(0, 1200);
  }
  job.logs.push({ time: new Date().toISOString(), level: String(level || "info"), message: String(message || "Evento"), details: safeDetails });
  if (job.logs.length > 4000) job.logs.splice(0, job.logs.length - 4000);
}

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
    logs: Array.isArray(job.logs) ? job.logs : [],
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
      progress: { status: "starting", current: 0, total: uniqueLinks.length, originalLinksTotal: uniqueLinks.length, dependencyLinksTotal: 0, percent: 0, filename: "", message: "Iniciando..." },
      logs: []
    };
    addJobLog(job, "info", "Build iniciado", { minecraftVersion, modLoader, loaderVersion: loaderVersion || "não informado", links: uniqueLinks.length, localFiles: uploadId ? (uploads.get(uploadId)?.files?.length || 0) : 0, officialCurseForgeKeyConfigured: Boolean(CURSEFORGE_API_KEY), publicResolvers: CURSEFORGE_PUBLIC_PROXY_BASES.map(x => new URL(x).hostname) });
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
        const getTotalCount = () => Math.max(1, Number(job.progress.total || uniqueLinks.length + localCount));

        const downloadOne = async (i) => {
          const raw = uniqueLinks[i];
          let filename = "";
          let target = "";
          let success = false;
          let lastError = null;
          let reservedForThis = 0;
          let lastProgressAt = 0;

          const context = { minecraftVersion, modLoader };
          addJobLog(job, "info", "Download iniciado", { index: i + 1, originalUrl: raw, minecraftVersion, modLoader });
          for (let attempt = 1; attempt <= MAX_DOWNLOAD_RETRIES && !success; attempt++) {
            addJobLog(job, "info", "Tentativa de download", { index: i + 1, attempt, maxAttempts: MAX_DOWNLOAD_RETRIES, originalUrl: raw });
            let response = null;
            let bytes = 0;
            try {
              const result = await requestFile(raw, context);
              response = result.response;
              const url = result.url;
              addJobLog(job, "info", "URL resolvida; iniciando transferência", { index: i + 1, attempt, originalUrl: raw, resolvedUrl: url.toString(), resolvedFrom: context.resolvedFrom || (context.publicApiFallback ? "fonte pública alternativa" : "URL direta"), fallbackProject: context.fallbackProject || "", publicApiFallback: Boolean(context.publicApiFallback), publicProxyUsed: Boolean(context.publicProxyUsed), expectedSize: context.expectedSize || null, expectedHashes: context.expectedHashes || null, httpStatus: response.status, contentType: response.headers["content-type"] || "não informado", contentLength: response.headers["content-length"] || "não informado" });

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
                const progress = Math.min(85, Math.round(((completed + filePercent) / getTotalCount()) * 85));
                const now = Date.now();
                const elapsed = Math.max(0.1, (now - job.created) / 1000);
                if (now - lastProgressAt >= 250 || bytes <= 0) {
                  lastProgressAt = now;
                  updateJob(job, {
                    current: completed,
                    filename,
                    percent: progress,
                    message: "Baixando " + filename + " • " + completed + "/" + getTotalCount(),
                    bytesPerSecond: Math.round(total / elapsed)
                  });
                }
                if (bytes > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES || (expected > 0 && bytes > expected)) {
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
              addJobLog(job, "success", "Arquivo reconhecido como JAR/ZIP válido", { index: i + 1, filename, bytes });
              await verifyFileIntegrity(target, context.expectedHashes, filename);
              addJobLog(job, "success", "Integridade do arquivo verificada", { index: i + 1, filename, bytes, hashVerification: context.expectedHashes ? "hashes publicados verificados" : "nenhum hash publicado disponível" });

              files.push({ filename, target, source: raw, size: bytes, resolvedFrom: context.resolvedFrom || null });
              if (Array.isArray(context.dependencyUrls) && context.dependencyUrls.length) {
                let dependenciesAdded = 0;
                for (const dependencyUrl of context.dependencyUrls) {
                  if (!uniqueLinks.includes(dependencyUrl)) {
                    uniqueLinks.push(dependencyUrl);
                    dependenciesAdded += 1;
                  }
                }
                if (dependenciesAdded > 0) {
                  job.progress.dependencyLinksTotal = Number(job.progress.dependencyLinksTotal || 0) + dependenciesAdded;
                  job.progress.total = uniqueLinks.length + localCount;
                  addJobLog(job, "info", "Dependências obrigatórias adicionadas", {
                    index: i + 1,
                    originalUrl: raw,
                    dependenciesAdded
                  });
                }
              }
              addJobLog(job, "success", "Download concluído", { index: i + 1, filename, bytes, originalUrl: raw, resolvedFrom: context.resolvedFrom || (context.publicApiFallback ? "fonte pública alternativa" : "URL direta"), publicApiFallback: Boolean(context.publicApiFallback), publicProxyUsed: Boolean(context.publicProxyUsed) });
              success = true;
              updateJob(job, {
                current: completed + 1,
                filename,
                percent: Math.min(85, Math.round(((completed + 1) / getTotalCount()) * 85)),
                message: "✓ " + filename + " baixado",
                bytesPerSecond: Math.round(total / Math.max(0.1, (Date.now() - job.created) / 1000))
              });
            } catch (e) {
              lastError = e;
              const retryable = isRetryableDownloadError(e);
              addJobLog(job, attempt < MAX_DOWNLOAD_RETRIES && retryable ? "warn" : "error", "Tentativa de download falhou", { index: i + 1, attempt, maxAttempts: MAX_DOWNLOAD_RETRIES, originalUrl: raw, filename: filename || "ainda não identificado", error: e.message || String(e), code: e.code || "", httpStatus: Number(e?.response?.status || e?.status || 0) || null, retryable, bytesReceived: bytes });
              total = Math.max(0, total - bytes);
              if (reservedForThis > 0) {
                reservedBytes = Math.max(0, reservedBytes - reservedForThis);
                reservedForThis = 0;
              }
              if (target) await fsp.rm(target, { force: true }).catch(() => {});
              if (response && response.data) response.data.destroy();
              if (attempt < MAX_DOWNLOAD_RETRIES && retryable) {
                const retryDelay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
                addJobLog(job, "warn", "Aguardando antes de repetir download", { index: i + 1, nextAttempt: attempt + 1, delayMs: retryDelay });
                await sleep(retryDelay);
              } else {
                break;
              }
            }
          }

          if (!success) {
            const failure = { url: raw, name: filename || undefined, filename: filename || undefined, error: lastError && lastError.message ? lastError.message : "Falha no download." };
            failures.push(failure);
            addJobLog(job, "error", "Download encerrado", {
              index: i + 1,
              originalUrl: raw,
              filename: filename || "não identificado",
              attempts: lastError ? (isRetryableDownloadError(lastError) ? MAX_DOWNLOAD_RETRIES : 1) : 0,
              finalError: failure.error,
              code: lastError?.code || "",
              httpStatus: Number(lastError?.response?.status || lastError?.status || 0) || null
            });
          }
          completedLinks += 1;
          completed += 1;
          updateJob(job, {
            current: completed,
            percent: Math.min(85, Math.round((completed / getTotalCount()) * 85)),
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

        addJobLog(job, failures.length ? "warn" : "success", "Downloads finalizados", {
          requestedLinks: uniqueLinks.length,
          originalLinks: Number(job.progress.originalLinksTotal || uniqueLinks.length),
          dependencyLinks: Number(job.progress.dependencyLinksTotal || 0),
          downloadedFiles: files.length,
          failedLinks: failures.length,
          downloadedBytes: total,
          failed: failures.map(f => ({ url: redactUrl(f.url), error: f.error }))
        });
        updateJob(job, {
          originalLinksTotal: Number(job.progress.originalLinksTotal || uniqueLinks.length),
          dependencyLinksTotal: Number(job.progress.dependencyLinksTotal || 0),
          downloadedFiles: files.length,
          failedLinks: failures.length
        });
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
          files: orderedFiles.map(f => ({ file: f.filename, source: redactUrl(f.source), resolvedFrom: f.resolvedFrom || null, size: f.size || null })),
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
          archive.on("warning", err => {
            if (err && err.code === "ENOENT") {
              addJobLog(job, "warn", "Aviso não fatal do ZIP", { error: err.message || String(err) });
              return;
            }
            reject(err);
          });
          archive.pipe(output);
          Promise.resolve(archive.finalize()).catch(reject);
        });
        const zipStat = await fsp.stat(zipPath);
        if (!zipStat.size) throw new Error("O ZIP gerado ficou vazio.");
        addJobLog(job, "success", "ZIP criado e validado", { zipName, zipBytes: zipStat.size, filesInZip: orderedFiles.length, manifest: "mikael-modpack.json", failedLinks: failures.length });
        job.zipPath = zipPath;
        job.zipName = zipName;
        job.status = "done";
        job.lastAccess = Date.now();
        updateJob(job, {
          status: "done",
          percent: 100,
          current: job.progress.total,
          originalLinksTotal: Number(job.progress.originalLinksTotal || uniqueLinks.length),
          dependencyLinksTotal: Number(job.progress.dependencyLinksTotal || 0),
          downloadedFiles: files.length,
          failedLinks: failures.length,
          message: failures.length ? `⚠️ ZIP pronto: ${files.length} baixados, ${failures.length} com erro.` : "✅ Todos os mods foram instalados e o ZIP está pronto!",
          failures
        });
      } catch (e) {
        job.status = "error";
        addJobLog(job, "error", "Build falhou", { error: e.message || "Não foi possível gerar o ZIP.", code: e.code || "", httpStatus: Number(e?.response?.status || e?.status || 0) || null, stack: String(e.stack || "").slice(0, 3000) });
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
  MAX_UPLOAD_BODY_BYTES,
  app,
  isPrivateIp,
  parseCurseForgeFileId,
  isReleasedCurseForgeFile,
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
  isKnownModrinthLoader,
  redactUrl,
  jobs,
  uploads,
  modrinthCache,
  curseForgeCache,
  CURSEFORGE_PUBLIC_PROXY_BASES
};