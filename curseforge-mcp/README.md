# Mikael CurseForge MCP

Servidor MCP remoto, somente leitura, para pesquisar mods e consultar arquivos públicos do Minecraft no CurseForge.

## Ferramentas
- `curseforge_search_mods`
- `curseforge_get_mod`
- `curseforge_list_mod_files`
- `curseforge_get_file`
- `curseforge_get_download_url`
- `curseforge_list_categories`

## Segurança
- A chave oficial CurseForge fica somente em `CURSEFORGE_API_KEY`, no ambiente do servidor.
- Todas as chamadas MCP exigem `Authorization: Bearer <MCP_ACCESS_TOKEN>`.
- O servidor não recebe senha, cookie nem sessão da conta CurseForge.
- Não publica, edita nem apaga projetos; nenhuma ferramenta de escrita está exposta.
- Não registre chaves ou tokens em commits, issues ou mensagens.

## Render
Crie um Web Service apontando para este repositório:
- Root Directory: `curseforge-mcp`
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`

Configure as variáveis secretas `CURSEFORGE_API_KEY` e `MCP_ACCESS_TOKEN` no painel do Render. A chave CurseForge precisa ser emitida/aprovada para a aplicação. Gere um token MCP aleatório longo; não reutilize senha.

Após o deploy, o endpoint MCP será `https://SEU-SERVICO.onrender.com/mcp`.

## Testes
`npm run check` valida a sintaxe. `npm test` executa os testes unitários.
