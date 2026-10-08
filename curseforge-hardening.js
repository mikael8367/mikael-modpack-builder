/**
 * Mikael Modpack Builder — API hardening layer.
 *
 * Loaded before server.js so the official CurseForge client gets a few
 * conservative fallbacks without weakening the compatibility checks in
 * server.js. It is intentionally limited to CurseForge catalog requests.
 */
const axios = require("axios");

const originalGet = axios.get.bind(axios);

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function uniqueHits(hits) {
  const seen = new Set();
  return (Array.isArray(hits) ? hits : []).filter(hit => {
    const id = String(hit?.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function isCurseForgeModsSearch(url) {
  try {
    const u = new URL(String(url));
    return /(^|\.)api\.curseforge\.com$/i.test(u.hostname) &&
      /\/v1\/mods\/search$/i.test(u.pathname);
  } catch {
    return false;
  }
}

function isCurseForgeFiles(url) {
  try {
    const u = new URL(String(url));
    return /(^|\.)api\.curseforge\.com$/i.test(u.hostname) &&
      /\/v1\/mods\/\d+\/files$/i.test(u.pathname);
  } catch {
    return false;
  }
}

const SEARCH_ALIASES = {
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
};

function bestProjectHit(hits, wanted) {
  const w = normalize(wanted);
  return uniqueHits(hits).map(hit => {
    const slug = normalize(hit?.slug);
    const name = normalize(hit?.name);
    let score = 0;
    if (slug === w) score += 10000;
    if (name === w) score += 9000;
    if (slug.replace(/ /g, "") === w.replace(/ /g, "")) score += 8000;
    if (name.replace(/ /g, "") === w.replace(/ /g, "")) score += 7000;
    if (slug.includes(w) || w.includes(slug)) score += 2500;
    if (name.includes(w) || w.includes(name)) score += 2200;
    return { hit, score };
  }).sort((a, b) => b.score - a.score)[0]?.hit || null;
}

axios.get = async function hardenedAxiosGet(url, config = {}) {
  if (!isCurseForgeModsSearch(url)) {
    if (!isCurseForgeFiles(url)) return originalGet(url, config);

    // A loader-filtered request can occasionally return 400/empty for old
    // Minecraft files. Retry only by removing the loader filter; server.js
    // still performs the final exact loader compatibility check.
    try {
      return await originalGet(url, config);
    } catch (err) {
      const status = Number(err?.response?.status || 0);
      if (status !== 400) throw err;
      const params = { ...(config.params || {}) };
      if (!params.gameVersion) throw err;
      delete params.modLoaderType;
      try {
        return await originalGet(url, { ...config, params });
      } catch {
        throw err;
      }
    }
  }

  const baseParams = { ...(config.params || {}) };
  const wanted = String(baseParams.searchFilter || baseParams.slug || "").trim();
  const originalResponse = await originalGet(url, config);
  const originalHits = Array.isArray(originalResponse?.data?.data)
    ? originalResponse.data.data
    : [];

  if (!wanted) return originalResponse;

  // The documented API supports slug + classId as a unique project lookup.
  // Prefer that path when the free-text search did not return the exact mod.
  const exact = bestProjectHit(originalHits, wanted);
  if (exact && Number(exact.classId || 0) === 6 && normalize(exact.slug) === normalize(wanted)) return originalResponse;

  const aliasTerms = SEARCH_ALIASES[normalize(wanted)] || SEARCH_ALIASES[String(wanted).trim().toLowerCase()] || [];
  const searchTerms = [...new Set([
    wanted,
    wanted.replace(/[-_]+/g, " "),
    wanted.replace(/[-_]+/g, ""),
    ...aliasTerms
  ].filter(Boolean))];
  const attempts = [
    { ...baseParams, classId: 6, slug: wanted, searchFilter: undefined },
    ...searchTerms.map(term => ({
      ...baseParams,
      classId: 6,
      searchFilter: term
    }))
  ];

  const collected = [...originalHits];
  for (const params of attempts) {
    try {
      const response = await originalGet(url, { ...config, params });
      const hits = Array.isArray(response?.data?.data) ? response.data.data : [];
      collected.push(...hits);

      const candidate = bestProjectHit(hits, wanted);
      if (candidate && normalize(candidate.slug) === normalize(wanted)) break;
    } catch {}
  }

  const merged = uniqueHits(collected);
  if (!merged.length) return originalResponse;

  return {
    ...originalResponse,
    data: {
      ...(originalResponse.data || {}),
      data: merged.slice(0, 50)
    }
  };
};

module.exports = {};
