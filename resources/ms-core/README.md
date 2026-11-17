# ms-core

Core inicial do MagicSchoolRP. Instruções de instalação, API e limites em [docs/MS_CORE.md](../../docs/MS_CORE.md).

PostgreSQL, registo automático com ID numérico para formulário externo, allowlist, permissões e bans. Personagens (criação, seleção, persistência) ficam num recurso próprio. Identificação automática por chave local gerada pelo servidor; sem OAuth2. Requer `MS_DATABASE_URL` e o driver `pg`.

```powershell
npm.cmd test --prefix resources/ms-core
node resources/ms-core/tools/admin.js --help
```

Executar a ferramenta administrativa a partir da pasta que contém `server.json`. Os tipos da API de servidor estão em [types/core.d.ts](types/core.d.ts).
