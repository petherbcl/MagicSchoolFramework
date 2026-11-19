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
    emit: (_p, name, payload) => log.emits.push([name, payload]),
    position: () => ({ x: 1.234, y: -2, z: 3.999, yaw: 90 }),
  };
  const admin = createAdmin({ config: { role }, core: { Players: { get: id => players.get(id) || null } }, game, chat: (_p, text) => log.chat.push(text) });
  return { admin, player, players, log };
}

test("coords prints x, y, z, w", () => {
  const { admin, player, log } = setup();
  assert.equal(admin.handle(player, "coords"), true);
  assert.deepEqual(log.chat, ["x: 1.23, y: -2, z: 4, w: 90"]);
});
test("np toggles noclip and restores visibility", () => {
  const { admin, player, log } = setup();
  admin.handle(player, "np");
  assert.equal(admin.isNoclip(1), true);
  assert.equal(log.visible, false);
  assert.deepEqual(log.emits.at(-1), ["ms-admin:noclip", { enabled: true }]);
  admin.handle(player, "np");
  assert.equal(admin.isNoclip(1), false);
  assert.equal(log.visible, true);
  assert.deepEqual(log.emits.at(-1), ["ms-admin:noclip", { enabled: false }]);
});
test("players without the configured role are ignored", () => {
  const { admin, player, log } = setup(["moderator"]);
  assert.equal(admin.handle(player, "np"), false);
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
  admin.handle(player, "np");
  players.get(1).roles = [];
  admin.revalidate(() => player);
  assert.equal(admin.isNoclip(1), false);
  assert.equal(log.visible, true);
});
test("config reads MS_ADMIN_ROLE and rejects bad values", () => {
  assert.equal(loadConfig({}, { envFile: null }).role, "admin");
  assert.equal(loadConfig({ MS_ADMIN_ROLE: "staff" }, { envFile: null }).role, "staff");
  assert.throws(() => loadConfig({ MS_ADMIN_ROLE: "a b" }, { envFile: null }));
});
