# ms-sql

Camada de acesso à base de dados do MagicSchoolRP. Uma só API assíncrona sobre **PostgreSQL**, **MySQL** e **MariaDB**. O motor é escolhido pelo protocolo do URL. Não tem eventos de cliente nem UI.

Documentação completa (cada função com exemplo, `SqlError`, diferenças entre motores, limitações, schema e permissão `CREATE`, versões mínimas): [docs/MS_SQL.md](../../docs/MS_SQL.md).

## Configuração

Copiar `.env.example` para `.env` (ignorado pelo git) ou definir variáveis de ambiente (têm prioridade sobre o ficheiro).

| Variável | Default | Descrição |
| --- | --- | --- |
| `MS_SQL_URL` | vazio | `postgresql://`, `mysql://` ou `mariadb://` |
| `MS_SQL_SCHEMA` | (obrigatória com URL) | Schema (PostgreSQL) ou base de dados (MySQL/MariaDB) de **todas** as tabelas. Criado pelo ms-sql no arranque se não existir; os outros resources não criam nem nomeiam schemas (SQL sem prefixo) |
| `MS_SQL_POOL_SIZE` | 5 | Ligações no pool (1..20) |
| `MS_SQL_QUERY_TIMEOUT_MS` | 10000 | Timeout por query (100..300000) |
| `MS_SQL_SLOW_QUERY_MS` | 1000 | Regista queries lentas (só o SQL, nunca valores). 0 desativa |
| `MS_SQL_SSL` | false | `true` verifica o certificado TLS (obrigatório fora do loopback; há aviso se estiver off com host remoto) |
| `MS_SQL_SSL_CA` | vazio | Ficheiro PEM com a CA (exige `MS_SQL_SSL=true`) |
| `MS_SQL_MAX_SQL_BYTES` / `MS_SQL_MAX_PARAMS` / `MS_SQL_MAX_BATCH` | 1048576 / 65535 / 10000 | Limites de tamanho do SQL, parâmetros e lotes |
| `MS_SQL_HOLD_TIMEOUT_MS` | 60000 | Tempo máximo de posse da ligação em `transaction`/`withLock` |

Sem `MS_SQL_URL` o resource arranca, regista um aviso e `isReady()` fica `false`; todas as queries falham com `NOT_READY`. Sem `MS_SQL_SCHEMA` (ou com um nome inválido) o resource pára com `Invalid MS_SQL_SCHEMA`. Se o schema não puder ser criado o resource não fica `ready` (fail-closed). `Sql.schema` expõe o valor configurado. Uma configuração inválida pára o resource (`errorBehavior: stop`); as mensagens nunca incluem o URL.

## Utilização

```js
const Sql = Exports.get("ms-sql", "Sql");
await Sql.awaitConnection(10000);
const id = await Sql.insert("INSERT INTO t (name) VALUES (?)", ["x"]);
const row = await Sql.single("SELECT * FROM t WHERE id = ?", [id]);
await Sql.transaction(async tx => { await tx.update("UPDATE t SET name = :n WHERE id = :id", { n: "y", id }); });
```

- Placeholders: `?` com array ou `:nome` com objeto (nunca misturados).
- Colunas BIGINT e ids de insert são strings decimais.
- Funções: `query`, `single`, `scalar`, `insert`, `update`, `prepare`, `rawExecute`, `transaction`, `withLock`, `isReady`, `awaitConnection`, `dialect`. Tipos completos em `types/sql.d.ts`.
- Erros são `SqlError` com `kind` (`UNIQUE_VIOLATION`, `CONNECTION`, `NOT_READY`, ...).
- O export é uma vista congelada **sem** `close()`: só o próprio resource fecha o pool (em `resourceStop`).

## Eventos de servidor

| Evento | Payload | Quando |
| --- | --- | --- |
| `ms-sql:ready` | `{ dialect }` | Base ligada (inclui recuperação após queda) |
| `ms-sql:down` | nenhum | Ligação perdida; o resource continua vivo e reconecta sozinho com backoff |

Resources dependentes devem declarar `resourceDependencies: ["ms-sql"]`, não assumir `isReady()` no arranque (usar `awaitConnection`) e tolerar `NOT_READY` durante quedas.

## Testes

```powershell
npm.cmd ci --prefix resources/ms-sql
npm.cmd test --prefix resources/ms-sql
```

Usam PGlite e drivers falsos; não tocam na base real. `server/main.js` é só a cola com os globais; a lógica está em `server/runtime.js` e é testada com `Events`/`Exports` falsos.

## Notas

- Não há migrações nem multi-statement: um statement por chamada.
- O operador JSON `?` do PostgreSQL não é suportado (é tratado como placeholder).
