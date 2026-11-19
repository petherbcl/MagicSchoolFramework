"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { observed } = require("../server/validation");

test("observed() never leaves trailing whitespace after truncation", () => {
  const result = observed({ steamId: `${"a".repeat(255)} x`, nickname: `${"b".repeat(99)} y` });
  assert.equal(result.steamId, "a".repeat(255));
  assert.equal(result.nickname, "b".repeat(99));
});

test("observed() trims and drops blank values", () => {
  const result = observed({ steamId: "  abc  ", epicId: "   ", discordId: 5 });
  assert.deepEqual(result, { steamId: "abc" });
});
