"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../server/config");

function envFile(t, content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ms-core-env-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("ms-core-env-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, ".env"); fs.writeFileSync(file, content); return file;
}

test("resource env files support BOM, quoted values and comments", t => {
  const file = envFile(t, '\uFEFF# fixture\nMS_DATABASE_URL="postgresql://user:example%23%3D@localhost/test"\nMS_MAX_CHARACTERS=2 # comment\n');
  const config = loadConfig({}, { envFile: file });
  assert.equal(config.databaseConfigured, true);
  assert.equal(config.databaseUrl, "postgresql://user:example%23%3D@localhost/test");
  assert.equal(config.maxCharacters, 2);
});
test("host environment overrides the file without mutating the host object", t => {
  const file = envFile(t, "MS_DATABASE_URL=postgresql://file/test\nMS_DATABASE_POOL_SIZE=7\n");
  const env = { MS_DATABASE_URL: "postgresql://host/test", MS_DATABASE_POOL_SIZE: "2" };
  const config = loadConfig(env, { envFile: file });
  assert.equal(config.databaseUrl, env.MS_DATABASE_URL);
  assert.equal(config.poolSize, 2);
  assert.deepEqual(Object.keys(env).sort(), ["MS_DATABASE_POOL_SIZE", "MS_DATABASE_URL"]);
});
test("an explicit empty host variable is not silently replaced", t => {
  const file = envFile(t, "MS_DATABASE_URL=postgresql://file/test\n");
  assert.equal(loadConfig({ MS_DATABASE_URL: "" }, { envFile: file }).databaseConfigured, false);
});
test("a missing env file falls back to the supplied environment", t => {
  const file = envFile(t, ""); fs.unlinkSync(file);
  assert.equal(loadConfig({ MS_DATABASE_URL: "postgresql://host/test" }, { envFile: file }).databaseConfigured, true);
  assert.equal(loadConfig({}, { envFile: file }).databaseConfigured, false);
});
test("explicit test environments do not import the operator's real env file", () => {
  assert.equal(loadConfig({}).databaseConfigured, false);
});
