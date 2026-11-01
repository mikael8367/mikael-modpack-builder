"use strict";

const express = require("express");
const { timingSafeEqual } = require("node:crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const PORT = Number(process.env.PORT || 3001);
const API_KEY = String(process.env.CURSEFORGE_API_KEY || "").trim();
const ACCESS_TOKEN = String(process.env.MCP_ACCESS_TOKEN || "").trim();
const API_BASE = "https://api.curseforge.com/v1";
const GAME_ID_MINECRAFT = 432;
const REQUEST_TIMEOUT_MS = 15000;

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

async function curseforge(path, params = {}) {
  if (!API_KEY) throw new Error("CURSEFORGE_API_KEY não configurada no servidor.");
  if (!path.startsWith("/")) throw new Error("Caminho de API inválido.");
  const url = new URL(API_BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    headers: { "x-api-key": API_KEY, "Accept": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = response.status === 403
      ? "CurseForge recusou a chave. Verifique a aprovação e a variável CURSEFORGE_API_KEY."
      : response.status === 404 ? "Projeto ou arquivo não encontrado."
      : "A API CurseForge respondeu HTTP " + response.status + ".";
    throw new Error(message);
  }
  return body.data ?? body;
}

function makeServer() {
  const server = new McpServer({ name: "mikael-curseforge", version: "1.0.0" });

  server.registerTool("curseforge_search_mods", {
    title: "Pesquisar mods no CurseForge",
    description: "Pesquisa projetos do Minecraft no CurseForge. Somente leitura.",
    inputSchema: {
      query: z.string().trim().min(1).max(100).describe("Nome ou termo de pesquisa"),
      gameVersion: z.string().trim().max(30).optional(),
      modLoaderType: z.number().int().min(0).max(7).optional(),
      categoryId: z.number().int().positive().optional(),
      index: z.number().int().min(0).max(9950).default(0),
      pageSize: z.number().int().min(1).max(50).default(20)
    }
  }, async ({ query, gameVersion, modLoaderType, categoryId, index, pageSize }) => {
    const data = await curseforge("/mods/search", {
      gameId: GAME_ID_MINECRAFT, searchFilter: query, gameVersion,
      modLoaderType, categoryId, index, pageSize
    });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  server.registerTool("curseforge_get_mod", {
    title: "Detalhes de um mod",
    description: "Obtém informações públicas de um projeto pelo ID.",
    inputSchema: { modId: z.number().int().positive() }
  }, async ({ modId }) => {
    const data = await curseforge("/mods/" + modId);
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  server.registerTool("curseforge_list_mod_files", {
    title: "Listar arquivos de um mod",
    description: "Lista versões/arquivos de um projeto, com filtros opcionais.",
    inputSchema: {
      modId: z.number().int().positive(),
      gameVersion: z.string().trim().max(30).optional(),
      modLoaderType: z.number().int().min(0).max(7).optional(),
      index: z.number().int().min(0).max(9950).default(0),
      pageSize: z.number().int().min(1).max(50).default(20)
    }
  }, async ({ modId, gameVersion, modLoaderType, index, pageSize }) => {
    const data = await curseforge("/mods/" + modId + "/files", {
      gameVersion, modLoaderType, index, pageSize
    });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  server.registerTool("curseforge_get_file", {
    title: "Detalhes de um arquivo",
    description: "Obtém metadados públicos de um arquivo de mod.",
    inputSchema: { modId: z.number().int().positive(), fileId: z.number().int().positive() }
  }, async ({ modId, fileId }) => {
    const data = await curseforge("/mods/" + modId + "/files/" + fileId);
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  server.registerTool("curseforge_get_download_url", {
    title: "Obter URL de download",
    description: "Resolve a URL oficial de download de um arquivo público.",
    inputSchema: { modId: z.number().int().positive(), fileId: z.number().int().positive() }
  }, async ({ modId, fileId }) => {
    const data = await curseforge("/mods/" + modId + "/files/" + fileId + "/download-url");
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  server.registerTool("curseforge_list_categories", {
    title: "Listar categorias do Minecraft",
    description: "Lista categorias públicas de mods do Minecraft.",
    inputSchema: {}
  }, async () => {
    const data = await curseforge("/categories", { gameId: GAME_ID_MINECRAFT, classId: 6 });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  });

  return server;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mikael-curseforge-mcp", apiKeyConfigured: Boolean(API_KEY), authConfigured: Boolean(ACCESS_TOKEN) });
});

app.all("/mcp", async (req, res) => {
  if (!ACCESS_TOKEN) return res.status(503).json({ error: "MCP_ACCESS_TOKEN não configurado." });
  const auth = String(req.headers.authorization || "");
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!supplied || !safeEqual(supplied, ACCESS_TOKEN)) {
    return res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "Não autorizado." });
  }
  if (req.method !== "POST") return res.status(405).set("Allow", "POST").end();
  const server = makeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Falha MCP:", error.message);
    if (!res.headersSent) res.status(500).json({ error: "Falha interna no servidor MCP." });
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
});

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log("Mikael CurseForge MCP ouvindo na porta " + PORT);
  });
}

module.exports = { app, makeServer, safeEqual, curseforge };
