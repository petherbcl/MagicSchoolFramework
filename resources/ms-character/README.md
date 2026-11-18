# ms-character

Lobby de personagens do MagicSchoolRP (versão 0.2.0). Depende do [ms-core](../ms-core/README.md): o jogador só chega aqui depois de a conta estar aprovada e a chave local verificada.

## Fluxo

1. O ms-core emite `ms:playerReady`. O ms-character volta a confirmar a sessão e leva o jogador para o **lobby**: um mundo privado, invisível, invulnerável e preso ao ponto do lobby.
2. A UI do lobby mostra as personagens da conta, começando pela última jogada:
   - **Sem personagens:** abre diretamente o criador de personagens.
   - **Com personagens:** o jogador escolhe uma com "Jogar", cria outra (até `MS_MAX_CHARACTERS`) ou apaga uma. Ao focar um cartão, a personagem aparece em pré-visualização com a aparência guardada.
3. Ao escolher, o servidor confirma que a personagem pertence à conta e restaura-a: viagem para Overland, inventário, look, casa e posição guardada. Uma personagem nova aparece no spawn.
4. O jogador sai do lobby para o mundo 0 e o recurso emite `ms:characterReady`.
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
- **Imagens:** as miniaturas (`ui-src/src/assets/creator/`) e os brasões (`assets/houses/`) vêm de `UI_Refs/` convertidos para WebP. A chave é o ID da opção do jogo (`HairMale001`…); os penteados femininos usam as imagens masculinas. Opções sem imagem mostram o número.

## Apagar personagens

O jogador apaga uma personagem no lobby, depois de confirmar num diálogo. É um soft delete (ver abaixo).

Se o restauro nativo falhar, o jogador é desligado, porque o estado ficaria a meio. Nesse caso não se emite `ms:characterReady` e não se grava nada.

## Configuração

Por omissão usa o `MS_DATABASE_URL` do `resources/ms-core/.env`. Um `.env` próprio (ver [.env.example](.env.example)) e as variáveis de ambiente do processo têm prioridade.

| Variável | Default | Função |
| --- | --- | --- |
| `MS_CHARACTER_POOL_SIZE` | 3 | Pool PostgreSQL, 1–20 |
| `MS_MAX_CHARACTERS` | 1 | Personagens por conta, 1–5 |
| `MS_SAVE_INTERVAL_SECONDS` | 30 | Autosave, 5–300 |

As coordenadas do lobby e do spawn de personagens novas estão em [server/config.js](server/config.js).

## Base de dados

O recurso cria o schema `ms_character` com a tabela `ms_character.characters`, que referencia `ms_core.ms_users(id)`. O schema do ms-core tem de existir primeiro. Tal como no ms-core, não há migrations: o schema é criado com `IF NOT EXISTS` em cada arranque. A criação de personagens fica registada em `ms_core.ms_audit_log` (`character.created`).

Uma BD criada antes da versão 0.4.0 do ms-core tem as personagens em `ms_core.ms_characters`. Para as passar para aqui, correr uma vez:

```sql
INSERT INTO ms_character.characters(user_id,first_name,last_name,house,state,version,created_at,updated_at)
SELECT user_id,first_name,last_name,house,state,version,created_at,updated_at FROM ms_core.ms_characters ORDER BY id;
```

### Recuperar uma personagem apagada

Apagar uma personagem é um soft delete: a linha fica com `deleted_at` preenchido, deixa de aparecer no lobby, deixa de contar para o limite e fica registada em `ms_core.ms_audit_log` (`character.deleted`). Um admin recupera-a com esta SQL, substituindo `$1` pelo ID da personagem e `<nome>` pelo seu nome:

```sql
-- Confirmar primeiro que a conta tem vaga: as personagens ativas têm de ser menos do que MS_MAX_CHARACTERS.
UPDATE ms_character.characters SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL;
INSERT INTO ms_core.ms_audit_log(actor, action, user_id, details)
  SELECT 'admin:<nome>', 'character.restored', user_id, jsonb_build_object('characterId', id::text) FROM ms_character.characters WHERE id = $1;
```

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

Os testes usam PGlite embebido e um adaptador nativo simulado. O `node resources/ms-core/tools/smoke-runtime.js` também arranca este recurso no executável real.
