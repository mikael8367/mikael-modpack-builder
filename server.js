const express = require("express");
const axios = require("axios");
const archiver = require("archiver");
const path = require("path");
const dns = require("dns").promises;
const net = require("net");

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const MAX_LINKS = 50;
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
      if (!location) throw new Error("Redirecionamento sem destino.");
      current = new URL(location, url).toString();
      response.data.destroy();
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

  res.setHeader("Content-Type", "application/zip");
  const safeVersion = minecraftVersion.replace(/[^0-9A-Za-z._-]/g, "_");
  const zipName = `Mikael_Modpack_${safeVersion}_${Date.now()}.zip`;
  res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", e => { if (!res.headersSent) res.status(500); res.end(); });
  archive.pipe(res);

  const used = new Set();
  const manifest = {
    format: "mikael-modpack-links",
    version: 1,
    minecraft: minecraftVersion,
    modLoader,
    modLoaderVersion: loaderVersion || null,
    files: []
  };

  let total = 0;
  try {
    for (let i = 0; i < uniqueLinks.length; i++) {
      const raw = uniqueLinks[i];
      const { response, url } = await requestFile(raw);
      const disposition = String(response.headers["content-disposition"] || "");
      const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^;"]+)/i);
      const fromHeader = match ? match[1].trim() : "";
      const filename = uniqueName(safeFileName(fromHeader || url.pathname, i), used);
      const length = Number(response.headers["content-length"] || 0);
      if (length) total += length;
      if (total > MAX_TOTAL_BYTES) {
        response.data.destroy();
        throw new Error(`O pacote ultrapassa ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB.`);
      }

      await new Promise((resolve, reject) => {
        let bytes = 0;
        response.data.on("data", chunk => {
          bytes += chunk.length;
          total += length ? 0 : chunk.length;
          if (bytes > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
            response.data.destroy(new Error("Limite de tamanho excedido."));
          }
        });
        response.data.on("error", reject);
        response.data.on("end", resolve);
        archive.append(response.data, { name: `mods/${filename}` });
      });
      manifest.files.push({ file: filename, source: raw });
    }

    archive.append(JSON.stringify(manifest, null, 2), { name: "mikael-modpack.json" });
    archive.append(JSON.stringify({
      minecraft: minecraftVersion,
      modLoader,
      modLoaderVersion: loaderVersion || null,
      note: "Arquivos adicionados a partir das URLs fornecidas pelo usuário."
    }, null, 2), { name: "modpack-info.json" });
    await archive.finalize();
  } catch (e) {
    archive.abort();
    if (!res.headersSent) res.status(422).json({ error: e.message || "Não foi possível baixar um dos links." });
    else res.end();
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`Mikael Modpack Builder em ${PORT}`));