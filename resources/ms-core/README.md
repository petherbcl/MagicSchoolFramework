# ms-core

Framework base do MagicSchoolRP (versão 0.4.0). Gere contas PostgreSQL com ID numérico, admissão no ecrã de entrada, allowlist externa, chave local, roles e bans. A especificação completa (fluxo, esquema, SQL para a aplicação do formulário, recuperação de contas) está em [docs/MS_CORE.md](../../docs/MS_CORE.md).

**Fora do âmbito:** personagens. A criação, a seleção e a persistência (inventário, look e localização) ficam no recurso [ms-character](../ms-character/README.md), que depende do ms-core, abre o lobby de personagens no `ms:playerReady` e associa as personagens ao `userId`.

## Fluxo

1. **Ecrã de entrada (`playerConnecting`).** O core valida os identificadores obrigatórios e encontra a conta pelos IDs Steam, Epic, Discord ou de hardware. Se não existir conta, cria um registo `pending`. O resultado aparece no próprio ecrã "Joining":
   - **Pendente:** mostra `ID: 123 criado. Aguarda aprovação da allowlist. Formulário: …` e recusa a entrada.
   - **Recusado, banido ou já ligado:** mostra a recusa com o ID e o motivo.
   - **Aprovado:** deixa entrar.
2. **No jogo.** O jogador fica numa quarentena: mundo privado, invisível e preso ao spawn. O cliente apresenta a chave local guardada no storage CEF. Se ainda não tiver chave, recebe uma nova.
3. **Pronto.** Com a conta aprovada, a chave verificada e o mundo carregado, o core liberta a quarentena e emite `ms:playerReady`.

Identificadores na conta:
- Só são acrescentados tipos que a conta ainda não tinha. Um Discord, Steam, Epic ou hardware ID diferente do registado é ignorado.
- IP, nickname e nome Discord são atualizados para o valor mais recente.

## Configuração

Copiar [.env.example](.env.example) para `.env`. As variáveis definidas no ambiente do processo têm prioridade sobre o ficheiro. Sem `MS_DATABASE_URL`, a admissão fica fechada.

| Variável | Default | Função |
| --- | --- | --- |
| `MS_DATABASE_URL` | vazio | Connection string PostgreSQL (obrigatória) |
| `MS_DATABASE_POOL_SIZE` | 5 | Pool de 1 a 20 ligações |
| `MS_SERVER_KEY` | MagicSchoolRP | Namespace do servidor e do storage local |
| `MS_ALLOWLIST_FORM_URL` | vazio | URL do formulário; recebe `?id=<ID>` |
| `MS_REQUIRED_IDENTIFIERS` | vazio | Identificadores obrigatórios; `,` = E, `\|` = OU |
| `MS_APPROVAL_TIMEOUT_SECONDS` | 1800 | Prazo das fases pendentes, 60–86400 |
| `MS_ACCESS_POLL_SECONDS` | 5 | Intervalo de revisão de acesso, 1–60 |

Exemplo: exigir Discord e Steam ou Epic.

```
MS_REQUIRED_IDENTIFIERS=discordId,steamId|epicId
```

Quando falta um identificador obrigatório, o jogador vê o que tem de fazer, por exemplo abrir a aplicação do Discord antes de ligar.

## Comandos

Executar a partir da pasta que contém `server.json`. Na PowerShell, usar `npm.cmd`.

```powershell
npm.cmd ci --prefix resources/ms-core           # dependências (inclui as de teste)
npm.cmd test --prefix resources/ms-core         # testes (PGlite embebido, não toca na BD real)
node resources/ms-core/tools/smoke-runtime.js   # arranca o ArcaneMPServer.exe real numa pasta isolada
node resources/ms-core/tools/admin.js --help    # administração local
```

Comandos de administração: `users`, `show`, `approve`, `deny`, `role-add`, `role-remove`, `ban`, `unban`, `recover <pendente> <original>` e `reset-key <id>`. O `reset-key` revoga as chaves da conta; o próximo cliente com os mesmos identificadores recebe uma chave nova. Todas as operações ficam na auditoria.

## Integração com outros recursos

Declarar `"resourceDependencies": ["ms-core"]` no manifesto `mafiahub` e confirmar a sessão antes de agir:

```javascript
const Core = Exports.get("ms-core", "Core");
Events.on("ms:playerReady", ({ playerId, sessionId, userId }) => {
  if (Core.Users.get(playerId)?.sessionId !== sessionId || !Core.Users.isReady(playerId)) return;
  // Carregar ou criar a personagem de userId.
});
```

- **Eventos de servidor:** `ms:sessionStarted`, `ms:userAuthenticated`, `ms:playerReady` e `ms:sessionEnded`.
- **API (`Core`):**
  - `Users`: `get`, `getOnlineById`, `isReady`, `hasPermission`, `load`, `setMetadata`.
  - `Allowlist`: `approve`, `deny`.
  - `Roles`: `set`.
  - `Bans`: `add`, `revoke`.
- Os IDs são strings decimais (`"123"`). Os tipos estão em [types/core.d.ts](types/core.d.ts).
