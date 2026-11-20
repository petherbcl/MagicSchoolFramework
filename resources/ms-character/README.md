# ms-character

Lobby de personagens do MagicSchoolRP (versão 0.6.0). Depende do [ms-core](../ms-core/README.md) e do [ms-sql](../ms-sql/README.md): o jogador só chega aqui depois de a conta estar aprovada e a chave local verificada.

## Fluxo

Estados do lobby: `loading → lobby ⇄ creating | deleting → [choosingSpawn →] applying → playing → closed`. O estado `choosingSpawn` (0.6.0) só existe com o ms-spawn pronto; o script cliente fecha então a página do ms-character (a UI do ms-spawn assume o ecrã) e mantém-na fechada até `playing`.

1. O ms-core emite `ms:playerReady`. O ms-character volta a confirmar a sessão e leva o jogador para o **lobby**: um mundo privado, invisível, invulnerável e preso ao ponto do lobby.
   - **Mundo carregado primeiro:** até o mundo à volta do ponto do lobby estar carregado, o jogador só vê um ecrã opaco "A preparar o mundo" (sem lobby, sem o modelo de pré-visualização). O servidor usa a espera nativa do jogo: `Player.teleport(..., { snapToGround: true })` para o ponto do lobby, que prende o jogador a pé até o chão carregar (até 20 s) e devolve `groundSnapped` em `playerTeleportComplete`. O lobby só passa de `loading` a `lobby` quando as personagens e esta confirmação terminam, e o estado leva `groundSnapped`. Se vier `true`, o cliente mostra o lobby de imediato. Se vier `false` (falha ou limite de tempo), o script cliente tenta ainda `World.lineTrace` sob o jogador durante 5 s no máximo. Nunca bloqueia o jogador e nada disto autoriza efeitos no servidor. O hold do lobby sai durante o teleporte e volta ao ponto onde o jogador aterrou.
2. A UI do lobby mostra as personagens da conta, começando pela última jogada:
   - **Sem personagens:** abre diretamente o criador de personagens.
   - **Com personagens:** o jogador escolhe uma com "Jogar", cria outra (até `MS_MAX_CHARACTERS`) ou apaga uma. Ao focar um cartão, a personagem aparece em pré-visualização com a aparência guardada.
3. Ao escolher, o servidor confirma que a personagem pertence à conta. Se o [ms-spawn](../ms-spawn/README.md) estiver pronto (`Exports.get("ms-spawn", "Spawn")?.isReady()`, resolvido a cada uso; é opcional e não é dependência), o lobby passa a `choosingSpawn`: emite `ms:spawnSelectionRequested { playerId, sessionId, userId, characterId, last }` (`last` só se a personagem tem posição guardada em Overland, senão `null`) e mantém o jogador no lobby, sem temporizador para um jogador parado, até chegar `ms:spawnSelected { playerId, sessionId, destination }` ou `ms:spawnCancelled { playerId, sessionId, reason }`. No tick do autosave, se o ms-spawn deixou de estar pronto ou já não guarda esta seleção (`Spawn.holds`, p. ex. depois de um `ensure ms-spawn`), o jogador entra com o destino por omissão (vigilância; pedidos com menos de 5 s não são avaliados). `ms:spawnSelected` com coordenadas fora de ±1e7 (ou `yaw` fora de ±360) é tratado como sem destino. Respostas com outro `sessionId` ou fora de `choosingSpawn` são ignoradas. Sem ms-spawn pronto (ou em cancelamento) o destino é o de sempre. Depois restaura a personagem: viagem para Overland, inventário, look, casa e posição guardada. Uma personagem nova aparece no spawn.
4. O jogador sai do lobby para o mundo 0, o recurso avisa o ms-core com `Core.Players.enterGame(playerId, { sessionId, characterId })` (o core volta a validar a conta e guarda em memória `userId`, `playerId`, `characterId` e roles; requer ms-core 0.7.0) e emite `ms:characterReady`.
5. A personagem é guardada automaticamente (`MS_SAVE_INTERVAL_SECONDS`) e quando o jogador sai. Os saves usam controlo de versão, por isso um save desatualizado é recusado.
   - **Posição:** só se restauram posições do Overland. Fora do Overland (castelo, masmorras, durante cargas) o save mantém a última posição Overland conhecida.
   - **Falhas no autosave:** uma falha transitória (BD, captura nativa) é repetida no tick seguinte. O jogador só é desligado à 3.ª falha seguida.
   - **Conflito de versão:** desliga o jogador de imediato, porque a personagem foi alterada fora desta sessão (edição na BD, sessão duplicada). A cópia em memória está desatualizada e não deve sobrescrever a da BD.

## Criador de personagens

A aparência só se escolhe na criação (não há edição depois). O criador usa a API `Creator` do cliente sobre a personagem real, com a câmara do `CreatorPreview` (corpo ou rosto, conforme a aba) e a pose parada (`CreatorPreview.freeze`).

- **Abas:** Corpo (tipo de corpo, pronome, **voz** e predefinição), Rosto, Cabelo, Olhos e sobrancelhas, Marcas, Acessórios e Finalizar (nome, apelido e casa).
- **Pré-visualização:** passar o rato ou o foco por uma opção mostra-a no modelo; só o clique (ou Enter) a confirma.
- **Voz:** dois timbres (`tone`: Voz 1 feminina, Voz 2 masculina) e a altura (`pitch`, de −10 a 10). A voz toca a cada alteração.
- **Sair:** Esc ou "Voltar" saem de imediato se nada mudou; com alterações abre "Descartar personagem". A aparência original repõe-se sempre (`Creator.cancel()` sozinho não reverte). Na primeira personagem não há saída.
- **Criar:** o cliente junta o `look` exportado (`Creator.exportLook()`) ao pedido. O servidor trata-o como um pedido: `lookInput` ([server/validation.js](server/validation.js)) aceita só campos conhecidos, impõe o nome e a casa, remove `scale`, `scaleMode` e `boneScales`, valida a `voice` (`tone` 0 ou 1, `pitch` inteiro até ±10) e limita o tamanho a 16 KB. Os pelos faciais são descartados num corpo feminino.
- **Rodar o modelo:** a página envia `model:rotate` com `{ delta }` (graus, relativo; arrastar o avatar ou os botões ↺ / ↻). O cliente limita cada passo a ±45° e acumula o total em `turned`, porque `CreatorPreview.rotate` é relativo e não tem leitura. A rotação é desfeita (`unrotate()`) ao mudar de enquadramento (corpo/rosto), ao entrar no criador, ao sair do lobby e ao abrir uma nova sessão de lobby, para a câmara voltar sempre ao ângulo inicial. Cancelar o criador de volta ao lobby mantém a sessão (só repõe a aparência e o enquadramento do corpo), para evitar um movimento rápido da câmara.
- **Imagens:** as miniaturas (`ui-src/src/assets/creator/`) e os brasões (`assets/houses/`) vêm de `UI_Refs/` convertidos para WebP. A chave é o ID da opção do jogo (`HairMale001`…, `HairFemale001`…). O jogo só traz ícones `UI_T_HairMale*` (nenhum feminino) e a ordem das opções de `hairStyle` **não é sequencial** (por exemplo, no feminino a posição 16 é a `HairFemale033`; faltam as 038 e 039). A grelha mostra a posição (`index + 1`) e escolhe a imagem pelo ID, por isso cada ficheiro `HairMale###.webp` / `HairFemale###.webp` tem o conteúdo da miniatura que o jogo mostra na posição do ID, e não o do ícone com o mesmo número. Se o jogo mudar a ordem, regista a ordem do schema e reatribui as imagens. Opções sem imagem mostram o número.

## Apagar personagens

O jogador apaga uma personagem no lobby, depois de confirmar num diálogo. É um soft delete (ver abaixo).

Se o ms-core recusar a entrada em jogo (sessão alterada, conta bloqueada), o jogador é desligado e não se emite `ms:characterReady`. Se o restauro nativo falhar, o jogador é desligado, porque o estado ficaria a meio. Nesse caso não se emite `ms:characterReady` e não se grava nada.

## Configuração

O ms-character **não tem nenhum parâmetro de base de dados** (nem URL, nem pool, nem timeouts): a ligação pertence ao [ms-sql](../ms-sql/README.md) (`resources/ms-sql/.env`, `MS_SQL_URL`). O recurso declara `ms-core` e `ms-sql` em `resourceDependencies` e resolve o export `Sql` de forma lazy. Sem BD pronta (ms-sql sem `MS_SQL_URL`, ou ligação em baixo) o lobby fica desativado e regista o motivo no log. Um `.env` próprio (ver [.env.example](.env.example)) e as variáveis de ambiente do processo (prioritárias) só afinam os limites abaixo.

| Variável | Default | Função |
| --- | --- | --- |
| `MS_MAX_CHARACTERS` | 1 | Personagens por conta, 1–5 |
| `MS_SAVE_INTERVAL_SECONDS` | 30 | Autosave, 5–300 |
| `MS_MAX_CREATIONS_PER_DAY` | 5 | Personagens que uma conta pode criar em 24 h, **incluindo as apagadas**, 1–100. Impede ciclos de criar e apagar que encheriam a BD |
| `MS_DELETED_RETENTION_DAYS` | 30 | Dias que uma personagem apagada fica recuperável; depois é eliminada de vez (purga ao arrancar e de hora a hora), 1–3650 |

As coordenadas do lobby e do spawn de personagens novas estão em [server/config.js](server/config.js).

## Base de dados

O recurso cria a tabela `ms_characters` (índices `ms_characters_user` e `ms_characters_user_active`), que referencia `ms_users(id)` do ms-core. **Não cria nem nomeia schemas**: o schema (`MS_SQL_SCHEMA`, por exemplo `magic_school_rp`) é definido só no ms-sql, que o cria uma vez no arranque, e todas as tabelas (ms-core e ms-character) vivem nele, por isso o SQL não tem prefixos. As tabelas do ms-core têm de existir primeiro no mesmo schema (`MS_CORE_SCHEMA_MISSING` se faltarem). Tal como no ms-core, não há migrations: as tabelas são criadas com `IF NOT EXISTS` em cada arranque (`createTables()`). A criação de personagens fica registada em `ms_audit_log` (`character.created`).

**Renome na 0.4.0:** a tabela `characters` passou a `ms_characters` (e os índices a `ms_characters_user*`), porque as tabelas de todos os resources partilham agora um só schema e o prefixo `ms_` evita colisões futuras. A BD antiga foi apagada e não há migração nem compatibilidade com os schemas `ms_core`/`ms_character`.

Funciona em **PostgreSQL, MySQL e MariaDB**, conforme o `MS_SQL_URL` do ms-sql (`sql.dialect`). O DDL é uma lista de statements por motor: [schema.postgres.js](server/database/schema.postgres.js) (sem `CREATE SCHEMA`) e [schema.mysql.js](server/database/schema.mysql.js) (MySQL 8.0.19+ e MariaDB 10.6+). No MySQL/MariaDB o "schema" é a base de dados `MS_SQL_SCHEMA`, criada pelo ms-sql; o índice parcial `ms_characters_user_active` passa a um índice simples `(user_id, deleted_at)` e a coluna `state` (JSON) não tem `DEFAULT`, porque o valor é sempre passado no INSERT. O `createTables()` corre sob `sql.withLock("ms-character:schema", ...)` e falha com `MS_CORE_SCHEMA_MISSING` se o schema do ms-core não existir. Os cortes das 24 h do limite de criações e da retenção calculam-se em JS (`Date`), e uma transação escolhida como vítima de deadlock é repetida (até 2 vezes).

### Recuperar uma personagem apagada

Apagar uma personagem é um soft delete: a linha fica com `deleted_at` preenchido, deixa de aparecer no lobby, deixa de contar para o limite `MS_MAX_CHARACTERS` e fica registada em `magic_school_rp.ms_audit_log` (`character.deleted`). Fica recuperável durante `MS_DELETED_RETENTION_DAYS` dias; depois é eliminada de vez.

Um admin recupera-a no `psql`, numa só instrução atómica. O `psql` não passa pelo ms-sql, por isso o schema (valor de `MS_SQL_SCHEMA`, aqui `magic_school_rp`) vai explícito nas tabelas; em alternativa fazer antes `SET search_path TO magic_school_rp;` e omitir o prefixo. Só restaura se a personagem estiver apagada e se a conta tiver vaga, e só então regista `character.restored`:

```sql
\set cid 123        -- ID da personagem
\set max 1          -- o valor de MS_MAX_CHARACTERS
\set admin 'nome'   -- quem restaura (sem aspas dentro do nome)
WITH r AS (
  UPDATE magic_school_rp.ms_characters c SET deleted_at = NULL
  WHERE c.id = :cid AND c.deleted_at IS NOT NULL
    AND (SELECT count(*) FROM magic_school_rp.ms_characters x WHERE x.user_id = c.user_id AND x.deleted_at IS NULL) < :max
  RETURNING c.id, c.user_id)
INSERT INTO magic_school_rp.ms_audit_log(actor, action, user_id, details)
SELECT 'admin:' || :'admin', 'character.restored', user_id, jsonb_build_object('characterId', id::text) FROM r;
```

`INSERT 0 0` quer dizer que nada foi restaurado: a personagem não estava apagada, não existe, já foi purgada ou a conta não tem vaga.

No MySQL/MariaDB (equivalente, **não validado** em servidor real), no cliente `mysql`:

```sql
SET @cid = 123, @max = 1, @admin = 'nome';
START TRANSACTION;
UPDATE magic_school_rp.ms_characters c SET c.deleted_at = NULL
WHERE c.id = @cid AND c.deleted_at IS NOT NULL
  AND (SELECT count(*) FROM (SELECT user_id FROM magic_school_rp.ms_characters WHERE deleted_at IS NULL) x WHERE x.user_id = c.user_id) < @max;
SELECT ROW_COUNT();  -- 1 = restaurada; 0 = nada a fazer (faz ROLLBACK em vez do passo seguinte)
INSERT INTO magic_school_rp.ms_audit_log(actor, action, user_id, details)
SELECT CONCAT('admin:', @admin), 'character.restored', user_id, JSON_OBJECT('characterId', CAST(id AS CHAR))
FROM magic_school_rp.ms_characters WHERE id = @cid;
COMMIT;
```

Tentativas de apagar ou escolher personagens de outra conta ficam em `magic_school_rp.ms_audit_log` como `character.delete_denied` e `character.select_denied`.

## Integração

```javascript
Events.on("ms:characterReady", ({ playerId, sessionId, characterId }) => {
  const Core = Exports.get("ms-core", "Core"), Characters = Exports.get("ms-character", "Characters");
  if (Core.Users.get(playerId)?.sessionId !== sessionId || !Characters.isPlaying(playerId)) return;
  const character = Characters.getSelected(playerId); // { characterId, firstName, lastName, house, state, ... }
});
```

- **Eventos de servidor:** `ms:characterLobby` e `ms:characterReady`.
- **API (`Characters`):** `isPlaying`, `getSelected`, `list` e `save`. Os tipos estão em [types/characters.d.ts](types/characters.d.ts).
- **Eventos de rede:** `ms-character:sync`, `ms-character:create`, `ms-character:select` e `ms-character:delete` (cliente → servidor); `ms-character:state` e `ms-character:notice` (servidor → cliente). O `state` leva, para o dono da conta, o `look` guardado e `lastPlayedAt` de cada personagem.
- **Página ↔ cliente:** o contrato (`creator:begin`, `creator:schema`, `creator:patch`, `creator:body`, `creator:voice`…) está em [ui-src/src/bridge.js](ui-src/src/bridge.js).

## UI (React + Tailwind)

O código da UI está em [ui-src/](ui-src/) e usa Vite, React 19 e Tailwind CSS 4. O build gera os ficheiros estáticos em `client/ui/`, que são distribuídos aos clientes através de `"files": ["client/ui/**"]`. **Não edites `client/ui/` à mão**: é apagado e gerado de novo em cada build.

```powershell
npm.cmd ci --prefix resources/ms-character/ui-src
npm.cmd run build:ui --prefix resources/ms-character   # gera client/ui/
npm.cmd run dev:ui --prefix resources/ms-character     # browser normal, com servidor simulado
```

- **`npm run dev`:** num browser normal não existe `callEvent`, por isso [src/bridge.js](ui-src/src/bridge.js) simula o servidor (lista, criação, entrada). Assim dá para construir ecrãs sem abrir o jogo.
- **Comunicação com o cliente:** `send(name, payload)` envia para o cliente; o hook `useLobby()` recebe `state` e `notice`. O contrato está documentado no `bridge.js`.
- **Build para o CEF:**
  - O bundle é um script clássico (IIFE com `defer`) e não um ES module. Isto evita problemas de CORS do esquema `fw://`.
  - O CSS sai num ficheiro único e a CSP (`'self'` apenas) é injetada só no build. Estilos injetados por JS seriam bloqueados pela CSP.
  - A renderização no jogo é por software: evitar WebGL, `backdrop-filter` e animações pesadas.
- **Cores:** são tokens Tailwind definidos em [src/index.css](ui-src/src/index.css) (`bg-ink`, `text-gold`, `border-brass`…).
- **Peso:** `client/ui/` ronda os 1,4 MB (170 ficheiros, quase todos miniaturas). É o que cada jogador descarrega.
- **Fazer commit de `client/ui/`:** depois de cada alteração à UI, corre o build e faz commit do `client/ui/` gerado. O servidor distribui esses ficheiros tal como estão.

## Testes

```powershell
npm.cmd ci --prefix resources/ms-character
npm.cmd test --prefix resources/ms-character
```

Os testes usam o `ms-sql` real e um adaptador nativo simulado. A suite do lobby corre uma vez por motor, com as tabelas do ms-core criadas antes (no mesmo schema de teste `ms_test`, criado pelo ms-sql):

- **PostgreSQL:** sempre, em PGlite (em memória, via socket).
- **MySQL / MariaDB:** só se `MS_SQL_TEST_MYSQL_URL` / `MS_SQL_TEST_MARIADB_URL` apontarem para um servidor real (o utilizador precisa de `CREATE`; as tabelas do ms-core e do ms-character no schema de teste `ms_test` são esvaziadas entre testes). Sem a variável o motor é saltado com a razão visível.

 O `node resources/ms-core/tools/smoke-runtime.js` também arranca este recurso no executável real.
