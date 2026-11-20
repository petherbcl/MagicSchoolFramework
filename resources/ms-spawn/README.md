# ms-spawn

Escolha do local de aparição do MagicSchoolRP (versão 0.3.2). Depois de o jogador escolher uma personagem no [ms-character](../ms-character/README.md), este recurso deixa-o sobrevoar os locais configurados com a câmara e confirmar onde aparece. Só depois da confirmação o ms-character liberta o jogador no mundo 0.

- **Sem base de dados.** Não usa o ms-sql, não importa `pg`/`mysql2` e não tem variáveis de base de dados. A última posição vem do ms-character (`ms_characters`).
- **O servidor manda.** O cliente só envia o `id` do local. As coordenadas vêm sempre da configuração (ou da última posição guardada) e nunca de um payload do cliente.
- **Opcional.** Dependências: `ms-core` e `ms-character`. O ms-character não depende do ms-spawn: se este estiver parado, a falhar ou com configuração inválida, o ms-character entra como na 0.5.0.
- Documentos: plano [docs/architecture-plan-ms-spawn.md](../../docs/architecture-plan-ms-spawn.md), tickets [docs/tickets-ms-spawn.md](../../docs/tickets-ms-spawn.md), design [docs/design/handoff-ms-spawn.md](../../docs/design/handoff-ms-spawn.md), **verificações em jogo por fazer** [docs/ms-spawn-runtime-findings.md](../../docs/ms-spawn-runtime-findings.md).

## Fluxo

1. O ms-character carrega a personagem e, se `Exports.get("ms-spawn", "Spawn")?.isReady()`, passa a `choosingSpawn` e emite `ms:spawnSelectionRequested`. O jogador fica retido no lobby (invisível, preso).
2. O ms-spawn abre a página (`ms-spawn:open`) com a lista: "Última localização" (só se a personagem tem posição guardada em Overland) e os locais configurados.
3. Ao clicar num local, o cliente envia `ms-spawn:select { id }` e a câmara voa até à pose que o servidor calculou. Novo clique reinicia o voo. **Desde a 0.2.0** o servidor também leva o jogador (invisível) ao ponto do local escolhido, porque o mundo faz streaming à volta do jogador e não da câmara (ver "Movimento do jogador").
4. O CTA "Aparecer aqui" ativa com local escolhido e câmara chegada (o swoop só começa depois de a zona estar carregada, ver "Cobertura e corpo local"). A zona carregada é detetada no cliente com `World.lineTrace` na vertical (início z+100, fim z-10000, `objectTypes` `worldStatic`, `shallowWater`, `deepWater`; acerto sem `startPenetrating`). Isto só serve a interface: o servidor nunca usa a informação do cliente para autorizar o destino.
5. `ms-spawn:confirm { id }`: o servidor valida e emite `ms:spawnSelected`. O ms-character aplica a personagem nesse destino, liberta o jogador e emite `ms:characterReady`; o ms-spawn envia `closed`, o cliente mantém a cobertura até o mundo na posição final estar carregado, faz o fade-out e só depois devolve a câmara e o corpo e fecha a página.
6. Uma rejeição (id inválido, `NOT_ARRIVED`...) mostra um aviso em pt-PT e mantém a seleção e a câmara; o jogador pode confirmar de novo.

Estados do servidor por jogador: `opening → choosing → applying → closed`. Não há temporizador de inatividade: a seleção termina com `ms:characterReady`, fim de sessão ou desconexão.

## Cobertura e corpo local (0.3.0, CHG-02)

Apresentação só do cliente (`client/main.js`); o servidor continua a decidir o `confirm`.

- **Corpo oculto.** Em `ms-spawn:open` o cliente chama `LocalPlayer.setVisibility(false)` (dentro de `attempt()`; devolve falso sem pawn, por isso repete de 250 ms em 250 ms até 40 vezes e depois só regista um aviso). O corpo volta com `setVisibility(true)`, uma só vez, em todas as saídas: no sucesso só depois do fade-out final; em `closed` sem sucesso, `ms:spawnCancelled`, sessão perdida, erro do cliente, vigilância e paragem do recurso, de imediato.
- **Cobertura opaca em ecrã inteiro** (evento de página `cover`, ver `ui-src/src/bridge.js`): liga em cada `select` e fica ligada até o servidor sinalizar `teleport: "done"` para esse select e `World.lineTrace` acertar no chão do alvo, ou até `areaTimeoutMs` (reinicia em cada select). Debaixo dela a câmara é posta na pose `camera.departure` (sem animação); quando a cobertura levanta corre o swoop `animateTo` até à pose `camera`, e o `ms-spawn:arrived` sai uma vez no fim. Teto atingido com o teleport concluído não é falha (swoop sem aviso). Teleport falhado (`teleport: "failed"`) ou teto sem resultado do teleport: a cobertura levanta, aviso "Não foi possível preparar este local. Tenta de novo ou escolhe outro local.", a câmara fica onde está e um novo clique tenta de novo.
- **Confirmar.** A cobertura volta ao confirmar e fica até o mundo na posição do próprio jogador (`LocalPlayer.getPosition()`) estar carregado (traço) ou até ao teto; levanta com fade de 150 ms e, 250 ms depois, restaura a câmara e o corpo e fecha a página. Rejeição do servidor: a cobertura levanta com o aviso, corpo e câmara mantêm-se. Salvaguardas: um `confirm` sem resposta em 5 s levanta a cobertura; sem `closed` do ms-character em 60 s depois de `applying` a página levanta e fecha.
- **Pose de partida.** O servidor deriva `camera.departure` (pose `camera` com `MS_SPAWN_CAMERA_DEPARTURE_HEIGHT` e `MS_SPAWN_CAMERA_DEPARTURE_DISTANCE` a mais, a olhar para o ponto); nunca o ponto de aparição.
- **Sinal do teleport.** `ms-spawn:state` leva `teleport: "done" | "failed"` (sem coordenadas) apenas no estado emitido quando o último select termina, ou ao repetir o mesmo local já concluído. Só apresentação: o gate do `confirm` não o lê.
- **Verificação em jogo por fazer:** secção 6 de `docs/ms-spawn-runtime-findings.md`.

## Movimento do jogador (0.2.0, CHG-01)

- **Cada `select` válido** (incluindo "Última localização") liberta o hold `ms-spawn:preview`, faz `player.teleport(x, y, z, { yaw, snapToGround: true })` para o ponto guardado no servidor (configuração ou `last`, nunca coordenadas do cliente), espera `playerTeleportComplete` (0 concluído, 1 substituído por um teleport mais recente, 2 o jogo ainda não pode, 3 mudou de mundo, 4 falhou, 5 expirou) e volta a reter o jogador nesse ponto (`clamp`, raio 0, `ttlMs` de 30 minutos só como rede de segurança).
- **Posse do hold.** No primeiro `select` o ms-spawn toma o jogador ao hold `ms-character:lobby`: primeiro põe o hold `ms-spawn:preview` na posição atual e só depois liberta o do lobby (nunca fica solto). Se o jogo recusar, o hold do lobby mantém-se e o jogador recebe o aviso de falha.
- **Cliques rápidos.** Um `select` novo substitui o teleport pendente (o resultado do antigo, incluindo o estado 1, é ignorado); nunca há dois teleports em paralelo por jogador. Voltar a escolher o mesmo local onde o jogador já está (ou para onde vai) reinicia o voo mas não teleporta de novo; uma tentativa falhada repete-se.
- **Falha do teleport** (estados 2 a 5, tempo limite, erro): a seleção mantém-se, o jogador volta a ser retido no último ponto retido, recebe "Não foi possível preparar este local. Tenta de novo ou escolhe outro local." (com `teleport: "failed"` no estado, desde a 0.3.0), e vale o temporizador de fallback. Nunca expulsa nem cancela.
- **Gate do `confirm`:** além das regras anteriores (mesmo `id`, chegada reportada ou `MS_SPAWN_AREA_TIMEOUT_MS` desde o `select`), o teleport do último `select` não pode estar pendente (rejeitado com `NOT_ARRIVED`); concluído ou falhado passam.
- **Saídas.** Em `confirm`, cancelamento (`reason` qualquer), fim de sessão, desconexão, paragem do recurso e vigilância o hold `ms-spawn:preview` é libertado exatamente uma vez e o teleport pendente é cancelado. O ms-character aplica depois o destino como antes (liberta o hold do lobby, que já não existe, e viaja/teleporta). O ms-spawn nunca volta a pôr o hold do lobby.
- **Limites de movimento (SEC-06).** No máximo um teleport nativo por 1,5 s por seleção (um `select` dentro do intervalo substitui o pendente e corre num temporizador final: ganha o último), no máximo 20 locais diferentes por seleção (depois o aviso "Mudaste de local demasiadas vezes. Confirma o local atual." e a seleção fica onde está) e o jogador não pode ficar sem hold mais de 40 s (vigilância `tick()`): passado esse limite a seleção é cancelada com `INTERNAL_ERROR` e o ms-character usa o destino por omissão. Constantes em `server/config.js` (`moveGapMs`, `maxMoves`, `maxUnheldMs`). Não foi possível verificar em jogo se o hold pode ser posto no ponto de destino antes do teleport (ordem hold/teleport); fica por testar (`docs/ms-spawn-runtime-findings.md` 5.4).
- **Renovação do hold (SEC-08).** O `ttlMs` de 30 minutos é só rede de segurança contra um crash: enquanto a seleção está viva o `tick()` renova o hold (liberta e volta a pôr, no mesmo ponto) de 10 em 10 minutos. Se a renovação falhar a seleção é cancelada (`INTERNAL_ERROR`). Um recurso que crashou deixa de renovar e o TTL expira o hold.
- **Hold obrigatório (SEC-09).** Se, depois de tomar o jogador, um hold não puder ser posto (a seguir a um teleport, na recuperação de uma falha, ou ao substituir uma seleção a meio de um teleport) a seleção é cancelada com `INTERNAL_ERROR` (sem expulsar). Uma seleção que substitui outra a meio de um teleport volta a reter o jogador antes de abrir.
- **Dono do hold (contrato).** O hold de pré-visualização tem o dono `ms-spawn:preview`. O ms-character liberta também este dono sempre que liberta `ms-character:lobby` (`apply`, `release`, `cancel`; o fallback do `watchSpawn` passa por `apply`), pelo que um hold órfão de um ms-spawn perdido nunca prende um jogador libertado (SEC-07). Libertar um dono sem hold é inofensivo.
- **Limite conhecido (SEC-10).** `Player.teleport` não tem cancelamento. Fechar uma seleção com um teleport pendente descarta apenas a promessa e regista o id do pedido; se o teleport aterrar depois, o resultado é ignorado e registado (nunca altera estado nem põe hold) e o `ms:spawnCancelled` sai logo, sem esperar. O pior caso é uma posição errada transitória: o `apply` do ms-character termina sempre com o seu próprio teleport para o destino e o autosave seguinte guarda-o.
- **Hold no ponto configurado (INFO-03).** O hold depois do teleport usa o ponto configurado e não o destino ajustado ao chão (`groundSnapped`): o `playerTeleportComplete` só entrega o estado ao adaptador. Se um `z` configurado ficar acima ou abaixo do chão, o jogador fica retido no `z` configurado. Escolher `z` ao nível do chão nas localizações; usar o destino ajustado fica como melhoria futura.

## Eventos

| Evento | Origem | Payload |
| :--- | :--- | :--- |
| `ms:spawnSelectionRequested` | ms-character | `{ playerId, sessionId, userId, characterId, last: {x,y,z,yaw} \| null }` |
| `ms:spawnSelected` | ms-spawn | `{ playerId, sessionId, destination: {x,y,z,yaw} }` |
| `ms:spawnCancelled` | ms-spawn | `{ playerId, sessionId, reason }` com `reason` em `NOT_READY`, `NO_OPTIONS`, `INTERNAL_ERROR`, `STOPPED`, `CLIENT_TIMEOUT`, `CLIENT_ABORTED`. O ms-character segue com o destino por omissão. Fim de sessão e desconexão não emitem nada |

Cliente e servidor (JSON; servidor para cliente sempre `JSON.stringify`):

| Sentido | Evento | Payload |
| :--- | :--- | :--- |
| S para C | `ms-spawn:open` | `{ locations: [{ id, name, kind: "last"\|"config", camera: { position, rotation: {pitch,yaw,roll}, departure: { position, rotation } } }], flight: { durationMs, easing }, areaTimeoutMs, timingLog?: boolean }` (`timingLog` desde a 0.3.2, CHG-03: só diz ao script do cliente se escreve a linha de medição na consola; ausente = falso; a página nunca o recebe). Nunca leva o ponto de aparição |
| S para C | `ms-spawn:state` | `{ status: "choosing"\|"applying"\|"closed", selectedId?, teleport?: "done"\|"failed", notice? }`. Desde a 0.3.1 (SEC-14) um aviso repete o `teleport` do movimento já terminado do local retido, para o cliente que recomeça nesse id não esperar por um sinal que não volta; o cliente que não recebe resposta a um `confirm` em 5 s repõe a página em `choosing` com aviso (SEC-11) |
| C para S | `ms-spawn:select` / `ms-spawn:arrived` / `ms-spawn:confirm` | `{ id }` (qualquer outro campo é ignorado). Limites por jogador: balde de 10 eventos com reposição de 10/s (o excesso é descartado em silêncio) e um aviso por código a cada 2 s. O servidor ignora um `arrived` anterior à duração mínima do voo (`MS_SPAWN_CAMERA_DURATION_MS` menos 250 ms); o cliente não envia `arrived` quando o voo falha |
| C para S | `ms-spawn:opened` | `{}`; enviado quando a página está pronta, a cada `ms-spawn:open` |
| C para S | `ms-spawn:abandon` | `{}` (0.3.1, SEC-12); enviado só depois de um erro inesperado no cliente (desmontagem de emergência com seleção aberta, depois de devolver câmara, corpo e página). Não lê payload, passa pelo mesmo balde de 10 eventos e só tem efeito com uma seleção `opening`/`choosing`: cancela-a com `CLIENT_ABORTED`, liberta o hold e o ms-character segue com o spawn por omissão. Ignorado em `applying` e sem seleção. Uma página que morra sem erro de script (CEF) não o envia: a seleção continua retida até a sessão terminar |

O contrato página/cliente está em `ui-src/src/bridge.js`. Export `Spawn`: `isReady()`, `holds(playerId, sessionId)`, `version`, `locations()` (`{id, name}`, sem coordenadas); tipos em `types/spawn.d.ts`.

## Configuração (`resources/ms-spawn/.env`, ver `.env.example`)

Variáveis de processo sobrepõem o ficheiro. Uma configuração inválida impede o arranque (fail closed) e o servidor continua; o ms-character usa o destino por omissão.

| Variável | Por omissão | Limites | Descrição |
| :--- | :--- | :--- | :--- |
| `MS_SPAWN_LOCATIONS` | 6 locais do `.env.example` | 0 a 12 entradas | JSON `[{ "name", "x", "y", "z", "yaw" }]`. `name` 1 a 40 caracteres, sem caracteres de controlo; `x,y,z` em cm (até 1e7), `yaw` em graus (±360). O `id` é o slug do nome (`Pátio de Hogwarts` dá `patio-de-hogwarts`); nomes com o mesmo slug, slug vazio e o id reservado `last` são rejeitados. Zero entradas é válido |
| `MS_SPAWN_CAMERA_DURATION_MS` | 1500 | 300 a 10000 | Duração do voo |
| `MS_SPAWN_CAMERA_EASING` | `easeInOut` | `linear`, `smoothStep`, `easeIn`, `easeOut`, `easeInOut` | Curva do voo |
| `MS_SPAWN_CAMERA_DISTANCE` | 1200 | 100 a 20000 | cm atrás do ponto de aparição |
| `MS_SPAWN_CAMERA_HEIGHT` | 600 | 0 a 20000 | cm acima do ponto; o pitch é derivado (a câmara olha para o ponto) |
| `MS_SPAWN_CAMERA_DEPARTURE_HEIGHT` | 1500 | 0 a 20000 | cm a mais de altura da pose de partida do swoop, somados a `MS_SPAWN_CAMERA_HEIGHT` |
| `MS_SPAWN_CAMERA_DEPARTURE_DISTANCE` | 3000 | 0 a 20000 | cm a mais de distância da pose de partida, somados a `MS_SPAWN_CAMERA_DISTANCE` |
| `MS_SPAWN_AREA_TIMEOUT_MS` | 15000 | 1000 a 60000 | Teto de espera do carregamento da zona (o cliente sai antes se o `World.lineTrace` acertar; teto com o teleport concluído não é falha) e atraso a partir do qual o servidor aceita o `confirm` sem relatório de chegada |
| `MS_SPAWN_PREVIEW_SNAP_TO_GROUND` | `false` | `true`/`false`/`1`/`0` | CHG-03 (0.3.2): se o teleport de pré-visualização de cada `select` pede `snapToGround` ao jogo. Desligado, o jogador invisível retido só serve para o mundo carregar à volta e não espera pelo chão (o jogo segura um jogador com snap até o chão carregar, até 20 s). Só afeta a pré-visualização: o teleport do ms-character na confirmação não muda. Valor inválido recusa o arranque |
| `MS_SPAWN_TIMING_LOG` | `true` | `true`/`false`/`1`/`0` | CHG-03 (0.3.2): medição para calibrar o carregamento. O servidor escreve uma linha por `select` quando chega o resultado do teleport (`[ms-spawn] timing player=<id> select=<local> teleportMs=<ms> status=<0..5 ou timeout> snap=<bool>`) e o cliente escreve uma linha na consola quando a cobertura levanta ou o teto é atingido (`toTeleportDoneMs`, `toGroundHitMs`, `toCoverLiftMs`, `ceiling` e campos experimentais). Sem coordenadas nem dados de conta. Pode desligar-se com `false` depois de calibrar |
| `MS_SPAWN_OPEN_ACK_TIMEOUT_MS` | 30000 | 5000 a 600000 | Vigilância do cliente: se a página nunca confirmar (`ms-spawn:opened`) que abriu, a seleção é cancelada com `CLIENT_TIMEOUT` e o ms-character usa o spawn por omissão. Não limita um jogador parado na UI: o relógio pára na primeira confirmação |

Como obter coordenadas: no jogo, `/pos` no sítio e com a orientação pretendidos (o `yaw` é o "w"). Se um ponto é um spawn seguro ainda não foi verificado em jogo.

## Comandos

```powershell
npm.cmd test --prefix resources/ms-spawn        # node:test, sem jogo nem base de dados
npm.cmd run build:ui --prefix resources/ms-spawn
```
