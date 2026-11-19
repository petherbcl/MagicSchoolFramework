# MagicSchoolRP

Servidor de roleplay para **Hogwarts Legacy** na plataforma multijogador [ArcaneMP](https://docs.arcane.mp/).

## Intuito

O MagicSchoolRP quer ser um servidor de RP sério e persistente passado no mundo de Hogwarts Legacy: cada jogador entra com uma conta aprovada, cria a sua personagem (nome, apelido e casa) e retoma-a sempre no ponto onde a deixou, com inventário, aparência e localização guardados.

Para isso, o projeto não é só um gamemode: é uma **framework própria**, pensada para que as funcionalidades de RP futuras (aulas, casas, economia, staff, eventos) assentem numa base comum e segura. Os princípios que a orientam:

- **Comunidade controlada.** A entrada passa por uma allowlist. O jogador recebe um ID numérico no primeiro acesso e só joga depois de a candidatura ser aprovada numa aplicação externa (formulário) ou pela staff.
- **Autoridade no servidor.** O cliente só faz pedidos. Contas, permissões, bans e o estado das personagens são decididos e guardados no servidor, em PostgreSQL.
- **Separação entre conta, sessão e personagem.** Uma conta pode ter várias personagens. Cada camada vive num recurso próprio, com uma API estável para os restantes.
- **Base reutilizável.** Novos recursos de gameplay dependem da framework e reagem aos seus eventos, sem reimplementar login, permissões ou persistência.

## Recursos

| Recurso | Função |
| --- | --- |
| [ms-core](resources/ms-core/README.md) | Framework base: contas, IDs de registo, allowlist, chave local, roles, permissões e bans |
| [ms-character](resources/ms-character/README.md) | Lobby de personagens: criação, seleção e persistência (inventário, look, casa, posição) |

Fluxo de um jogador: **ligação → allowlist e chave local (ms-core) → lobby de personagens (ms-character) → jogo (`ms:characterReady`)**.

## Arranque rápido

Requisitos: Node ≥ 22.13 e PostgreSQL (o `docker-compose.yml` sobe um Postgres 15 local em `:5432`).

```powershell
docker compose up -d
copy resources\ms-sql\.env.example resources\ms-sql\.env     # definir MS_SQL_URL
npm.cmd ci --prefix resources/ms-sql
npm.cmd ci --prefix resources/ms-core
.\ArcaneMPServer.exe
```

O servidor escuta na porta **27016** (ver `server.json`). Os clientes ligam-se a `127.0.0.1:27016`.

## Licença

[MIT](LICENSE)
