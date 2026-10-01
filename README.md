# Mikael Modpack Builder

Gerador de modpacks por links.

O usuário escolhe a versão do Minecraft e o modloader, adiciona até 50 URLs públicas de arquivos e baixa tudo em um único ZIP.

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

- 50 links por pacote
- 150 MB por arquivo
- 500 MB por pacote
- Apenas URLs HTTP/HTTPS públicas
- Endereços locais/privados são bloqueados
