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

O serviço não precisa de API Key da CurseForge para o modo por links.

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
