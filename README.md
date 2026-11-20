# MagicSchoolRP

Servidor de roleplay para **Hogwarts Legacy** na plataforma multijogador [ArcaneMP](https://docs.arcane.mp/).

## Intuito

O MagicSchoolRP quer ser um servidor de RP sério e persistente passado no mundo de Hogwarts Legacy: cada jogador entra com uma conta aprovada, cria a sua personagem (nome, apelido e casa) e retoma-a sempre no ponto onde a deixou, com inventário, aparência e localização guardados.

Para isso, o projeto não é só um gamemode: é uma **framework própria**, pensada para que as funcionalidades de RP futuras (aulas, casas, economia, staff, eventos) assentem numa base comum e segura. Os princípios que a orientam:

- **Comunidade controlada.** A entrada passa por uma allowlist. O jogador recebe um ID numérico no primeiro acesso e só joga depois de a candidatura ser aprovada numa aplicação externa (formulário) ou pela staff.
- **Autoridade no servidor.** O cliente só faz pedidos. Contas, permissões, bans e o estado das personagens são decididos e guardados no servidor, em PostgreSQL, MySQL ou MariaDB, sempre através do ms-sql.
- **Separação entre conta, sessão e personagem.** Uma conta pode ter várias personagens. Cada camada vive num recurso próprio, com uma API estável para os restantes.
- **Base reutilizável.** Novos recursos de gameplay dependem da framework e reagem aos seus eventos, sem reimplementar login, permissões ou persistência.

## Recursos

| Recurso | Função |
| --- | --- |
| [ms-sql](resources/ms-sql/README.md) | Única camada de base de dados: API assíncrona sobre PostgreSQL, MySQL e MariaDB (`Exports.get("ms-sql", "Sql")`) |
| [ms-core](resources/ms-core/README.md) | Framework base: contas, IDs de registo, allowlist, chave local, roles, permissões e bans |
| [ms-character](resources/ms-character/README.md) | Lobby de personagens: criação, seleção e persistência (inventário, look, casa, posição) |
| [ms-spawn](resources/ms-spawn/README.md) | Escolha do ponto de entrada: o jogador sobrevoa os locais configurados e confirma onde aparece (opcional, sem base de dados) |
| ms-admin | Comandos de staff (`/nc` noclip, `/fxlist`, `/coords`), restritos a um role do ms-core (`MS_ADMIN_ROLE`, por omissão `admin`) |

Ordem de dependências: **ms-sql → ms-core → ms-character → ms-spawn** (o ms-spawn é opcional; sem ele o ms-character entra no spawn por omissão). O ms-admin depende só do ms-core.

Fluxo de um jogador: **ligação → allowlist e chave local (ms-core) → lobby de personagens (ms-character) → [escolha de spawn (ms-spawn)] → jogo (`ms:characterReady`)**.

## Arranque rápido

Requisitos: Node ≥ 22.13 e PostgreSQL 15+, MySQL 8.0.19+ ou MariaDB 10.6+ (o `docker-compose.yml` sobe um Postgres 15 local em `:5432`; o perfil `sql-matrix` sobe MySQL e MariaDB descartáveis para os testes).

```powershell
docker compose up -d
copy resources\ms-sql\.env.example resources\ms-sql\.env     # definir MS_SQL_URL
npm.cmd ci --prefix resources/ms-sql
npm.cmd ci --prefix resources/ms-core
.\ArcaneMPServer.exe
```

Testes (não tocam na base de dados real, usam PGlite):

```powershell
npm.cmd test --prefix resources/ms-sql
npm.cmd test --prefix resources/ms-core
npm.cmd test --prefix resources/ms-character
npm.cmd test --prefix resources/ms-spawn
```

O servidor escuta na porta **27016** (ver `server.json`). Os clientes ligam-se a `127.0.0.1:27016`.

## Licença

[MIT](LICENSE)
