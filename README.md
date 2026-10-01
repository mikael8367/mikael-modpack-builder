# Mikael Modpack Builder

Gerador de modpacks por links e arquivos locais.

O usuário escolhe a versão do Minecraft e o modloader, adiciona URLs públicas e/ou arquivos `.jar`/`.zip` e baixa tudo em um único ZIP.

## Rodar localmente

npm install
npm start

Abra http://localhost:3000

## Deploy no Render

- Build: npm install
- Start: npm start
- Health check: /api/status

Para downloads automatizados do CurseForge, configure a variável secreta `CURSEFORGE_API_KEY` no Render. A chave não deve ser colocada no frontend ou no TXT. O servidor usa a chave no header `x-api-key` e também consegue resolver links de projeto do CurseForge para o arquivo compatível com a versão do Minecraft/modloader selecionados.

## Limites

- Até 999999 links por requisição, limitado também pelo tamanho do corpo JSON configurado no servidor
- Até 150 MB por arquivo
- Até 500 MB por pacote
- Até 999 arquivos locais por upload
- Arquivos locais: `.jar` ou `.zip`
- Apenas URLs HTTP/HTTPS públicas
- Endereços locais/privados são bloqueados
- Uploads temporários são removidos automaticamente

## TXT

O TXT pode ter uma URL por linha ou usar o formato:

`Nome do mod = https://exemplo.com/mod.jar`

Linhas vazias e linhas começando com `#` são ignoradas. Ao carregar, a interface mostra o nome e o link encontrados.


## CurseForge

A CurseForge passou a exigir autenticação por API Key para downloads automatizados da CDN em 16/07/2026. O builder suporta a variável de ambiente `CURSEFORGE_API_KEY`, envia a chave somente do servidor e resolve URLs de projeto/download do CurseForge quando a chave está configurada.

A API oficial documenta a autenticação pelo header `x-api-key` e o endpoint de URL de download de arquivos.