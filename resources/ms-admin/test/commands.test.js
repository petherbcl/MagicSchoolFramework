"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createAdmin } = require("../server/commands");
const { loadConfig } = require("../server/config");

function setup(roles = ["admin"], role = "admin") {
  const players = new Map([[1, { playerId: 1, sessionId: "10", roles }]]);
  const log = { chat: [], emits: [], visible: true };
  const player = { id: 1 };
  const game = {
    hide: () => { const previous = { visible: log.visible, collidable: true }; log.visible = false; return previous; },
    show: (_p, previous) => { log.visible = previous.visible; },
    startFx: () => { log.fx = true; return { fx: "k" }; },
    stopFx: () => { log.fx = false; },
    fxCatalog: filter => [{ name: "Smoke", path: "/Game/VFX/Smoke" }, { name: "Fire", path: "/Game/VFX/Fire" }]
      .filter(entry => !filter || entry.name.toLowerCase().includes(filter)),
    emit: (_p, name, payload) => log.emits.push([name, payload]),
    position: () => ({ x: 1.234, y: -2, z: 3.999, yaw: 90 }),
  };
  const admin = createAdmin({ config: { role }, core: { Players: { get: id => players.get(id) || null } }, game, chat: (_p, text) => log.chat.push(text) });
  return { admin, player, players, log };
}

test("coords prints x, y, z, yaw", () => {
  const { admin, player, log } = setup();
  assert.equal(admin.handle(player, "coords"), true);
  assert.deepEqual(log.chat, ["x: 1.23, y: -2, z: 4, yaw: 90"]);
});
test("nc toggles noclip and restores visibility", () => {
  const { admin, player, log } = setup();
  admin.handle(player, "nc");
  assert.equal(admin.isNoclip(1), true);
  assert.equal(log.visible, false);
  assert.deepEqual(log.emits.at(-1), ["ms-admin:noclip", { enabled: true }]);
  admin.handle(player, "nc");
  assert.equal(admin.isNoclip(1), false);
  assert.equal(log.visible, true);
  assert.deepEqual(log.emits.at(-1), ["ms-admin:noclip", { enabled: false }]);
});
test("nc starts and stops the effect", () => {
  const { admin, player, log } = setup();
  admin.handle(player, "nc");
  assert.equal(log.fx, true);
  admin.handle(player, "nc");
  assert.equal(log.fx, false);
});
test("coords in noclip asks the client and prints the camera pose", () => {
  const { admin, player, log } = setup();
  admin.handle(player, "nc");
  admin.handle(player, "coords");
  assert.deepEqual(log.emits.at(-1), ["ms-admin:camera-request", {}]);
  assert.deepEqual(log.chat, ["Noclip ligado."]);
  assert.equal(admin.cameraReply(player, { x: 10.126, y: 20, z: 30, yaw: 45 }), true);
  assert.equal(log.chat.at(-1), "x: 10.13, y: 20, z: 30, yaw: 45");
});
test("camera replies are rejected without a request, twice, late, invalid or outside noclip", () => {
  let now = 1000;
  const { admin, player, log } = setup();
  assert.equal(admin.cameraReply(player, { x: 1, y: 2, z: 3, yaw: 4 }), false);
  admin.handle(player, "nc");
  admin.handle(player, "coords");
  assert.equal(admin.cameraReply(player, { x: "1", y: 2, z: 3, yaw: 4 }), false);
  assert.equal(admin.cameraReply(player, { x: 1, y: 2, z: 3, yaw: 4 }), false, "request already consumed");
  admin.handle(player, "coords");
  admin.handle(player, "nc");
  assert.equal(admin.cameraReply(player, { x: 1, y: 2, z: 3, yaw: 4 }), false, "noclip ended");
  assert.equal(log.chat.some(line => line.startsWith("x:")), false);
  void now;
});
test("a late camera reply is ignored", () => {
  let now = 0;
  const players = new Map([[1, { playerId: 1, sessionId: "10", roles: ["admin"] }]]);
  const game = { hide: () => ({}), show() {}, startFx: () => ({}), stopFx() {}, emit() {}, position: () => null };
  const out = [];
  const admin = createAdmin({ config: { role: "admin" }, core: { Players: { get: id => players.get(id) || null } }, game, chat: (_p, t) => out.push(t), clock: () => now });
  const player = { id: 1 };
  admin.handle(player, "nc");
  admin.handle(player, "coords");
  now = 5000;
  assert.equal(admin.cameraReply(player, { x: 1, y: 2, z: 3, yaw: 4 }), false);
});
test("fxlist filters the catalog", () => {
  const { admin, player, log } = setup();
  admin.handle(player, "fxlist", ["smoke"]);
  assert.deepEqual(log.chat, ["1 efeitos (a mostrar 1):", "/Game/VFX/Smoke"]);
});
test("players without the configured role are ignored", () => {
  const { admin, player, log } = setup(["moderator"]);
  assert.equal(admin.handle(player, "nc"), false);
  assert.equal(admin.handle(player, "coords"), false);
  assert.deepEqual(log.chat, []);
});
test("the role is configurable", () => {
  const { admin, player } = setup(["moderator"], "moderator");
  assert.equal(admin.handle(player, "coords"), true);
});
test("unknown commands and players outside the game are ignored", () => {
  const { admin, player, players } = setup();
  assert.equal(admin.handle(player, "nope"), false);
  assert.equal(admin.handle(player, "constructor"), false);
  players.delete(1);
  assert.equal(admin.handle(player, "coords"), false);
});
test("revalidate turns noclip off when the role is lost", () => {
  const { admin, player, players, log } = setup();
  admin.handle(player, "nc");
  players.get(1).roles = [];
  admin.revalidate(() => player);
  assert.equal(admin.isNoclip(1), false);
  assert.equal(log.visible, true);
});
test("config reads MS_ADMIN_ROLE and rejects bad values", () => {
  assert.equal(loadConfig({}, { envFile: null }).role, "admin");
  assert.equal(loadConfig({ MS_ADMIN_ROLE: "staff" }, { envFile: null }).role, "staff");
  assert.throws(() => loadConfig({ MS_ADMIN_ROLE: "a b" }, { envFile: null }));
  assert.equal(loadConfig({}, { envFile: null }).noclipFxEnabled, true);
  assert.equal(loadConfig({ MS_ADMIN_NOCLIP_FX_ENABLED: "false" }, { envFile: null }).noclipFxEnabled, false);
  assert.throws(() => loadConfig({ MS_ADMIN_NOCLIP_FX_ENABLED: "maybe" }, { envFile: null }));
});
