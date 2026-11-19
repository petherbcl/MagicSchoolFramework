"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { translate, cacheSize, clearCache } = require("../server/placeholders");

const pg = (sql, params) => translate(sql, params, "postgres");
const my = (sql, params) => translate(sql, params, "mysql");
const invalid = fn => assert.throws(fn, error => error.name === "SqlError" && error.kind === "INVALID_PARAMS");

test("positional ? becomes $n on PostgreSQL and stays ? on MySQL/MariaDB", () => {
  const a = pg("SELECT * FROM t WHERE a = ? AND b = ?", [1, "x"]);
  assert.equal(a.text, "SELECT * FROM t WHERE a = $1 AND b = $2");
  assert.deepEqual(a.values, [1, "x"]);
  for (const dialect of ["mysql", "mariadb"]) {
    const b = translate("SELECT * FROM t WHERE a = ? AND b = ?", [1, "x"], dialect);
    assert.equal(b.text, "SELECT * FROM t WHERE a = ? AND b = ?");
    assert.deepEqual(b.values, [1, "x"]);
  }
});

test(":name uses an object; PostgreSQL reuses $n for repeated names, MySQL duplicates the value", () => {
  const sql = "SELECT * FROM t WHERE a = :id OR b = :other OR c = :id";
  const a = pg(sql, { id: 1, other: 2 });
  assert.equal(a.text, "SELECT * FROM t WHERE a = $1 OR b = $2 OR c = $1");
  assert.deepEqual(a.values, [1, 2]);
  const b = my(sql, { id: 1, other: 2 });
  assert.equal(b.text, "SELECT * FROM t WHERE a = ? OR b = ? OR c = ?");
  assert.deepEqual(b.values, [1, 2, 1]);
});

test("placeholders inside string literals are ignored, including doubled quotes", () => {
  assert.equal(pg("SELECT '?' AS q, ? AS v", [1]).text, "SELECT '?' AS q, $1 AS v");
  assert.equal(pg("SELECT 'it''s ? :x', ?", [1]).text, "SELECT 'it''s ? :x', $1");
  assert.deepEqual(my("SELECT 'a:b ?'", []).values, []);
});

test("quoted identifiers are ignored", () => {
  assert.equal(pg('SELECT "weird?col", ? FROM t', [1]).text, 'SELECT "weird?col", $1 FROM t');
  assert.equal(my("SELECT `weird?col`, ? FROM t", [1]).text, "SELECT `weird?col`, ? FROM t");
  assert.equal(pg('SELECT "a""?b", ?', [1]).text, 'SELECT "a""?b", $1');
});

test("comments are ignored", () => {
  assert.equal(pg("SELECT ? -- is it ? here\n, ?", [1, 2]).text, "SELECT $1 -- is it ? here\n, $2");
  assert.equal(pg("SELECT /* ? */ ?", [1]).text, "SELECT /* ? */ $1");
  assert.equal(pg("SELECT /* outer /* nested ? */ ? */ ?", [1]).text, "SELECT /* outer /* nested ? */ ? */ $1");
  assert.equal(my("SELECT ? # ? comment\n, ?", [1, 2]).text, "SELECT ? # ? comment\n, ?");
});

test("MySQL double-dash needs trailing whitespace to be a comment", () => {
  assert.equal(my("SELECT 5--?", [1]).text, "SELECT 5--?");
  assert.deepEqual(my("SELECT 5--?", [1]).values, [1]);
  assert.deepEqual(my("SELECT 5 -- ?\n", []).values, []);
});

test("dollar-quoted bodies are ignored on PostgreSQL", () => {
  assert.equal(pg("SELECT $$ ? $$, ?", [1]).text, "SELECT $$ ? $$, $1");
  assert.equal(pg("SELECT $tag$ ? $$ :x $tag$, ?", [1]).text, "SELECT $tag$ ? $$ :x $tag$, $1");
  assert.equal(pg("DO $body$ BEGIN PERFORM 1; PERFORM 2; END $body$").values.length, 0);
});

test("the :: cast is not a named placeholder", () => {
  assert.equal(pg("SELECT a::text, :id::int", { id: 1 }).text, "SELECT a::text, $1::int");
  assert.equal(pg("SELECT ?::bigint", [1]).text, "SELECT $1::bigint");
});

test("backslash escapes in MySQL strings and E'' strings in PostgreSQL", () => {
  assert.equal(my("SELECT 'a\\'?', ?", [1]).text, "SELECT 'a\\'?', ?");
  assert.equal(my('SELECT "a\\"?", ?', [1]).text, 'SELECT "a\\"?", ?');
  assert.equal(pg("SELECT E'a\\'?', ?", [1]).text, "SELECT E'a\\'?', $1");
  assert.equal(pg("SELECT 'a\\', ?", [1]).text, "SELECT 'a\\', $1"); // standard string: backslash is literal
});

test("existing $1 style text on PostgreSQL is left alone", () => {
  const t = pg("SELECT 1 WHERE x = $1");
  assert.equal(t.text, "SELECT 1 WHERE x = $1");
  assert.deepEqual(t.values, []);
});

test("missing, extra or mixed parameters throw INVALID_PARAMS", () => {
  invalid(() => pg("SELECT ?, ?", [1]));
  invalid(() => pg("SELECT ?", [1, 2]));
  invalid(() => pg("SELECT ?", undefined));
  invalid(() => pg("SELECT ?", { a: 1 }));
  invalid(() => pg("SELECT :a", [1]));
  invalid(() => pg("SELECT :a, :b", { a: 1 }));
  invalid(() => pg("SELECT :a", { a: 1, z: 2 }));
  invalid(() => pg("SELECT 1", [1]));
  invalid(() => pg("SELECT ? , :a", [1]));
  invalid(() => pg("SELECT 1", { a: 1 }));
  invalid(() => my("SELECT ?", []));
});

test("no placeholders accepts undefined, [] and {}", () => {
  for (const params of [undefined, null, [], {}]) assert.deepEqual(pg("SELECT 1", params).values, []);
});

test("undefined becomes null; unsupported types are rejected; bigint becomes a string", () => {
  assert.deepEqual(pg("SELECT ?, ?", [undefined, null]).values, [null, null]);
  assert.deepEqual(pg("SELECT :a", { a: undefined }).values, [null]);
  invalid(() => pg("SELECT ?", [() => 1]));
  invalid(() => pg("SELECT ?", [Symbol("x")]));
  assert.deepEqual(pg("SELECT ?", [10n ** 20n]).values, ["100000000000000000000"]);
});

test("objects and arrays are sent as JSON text; Date and Buffer pass through", () => {
  const date = new Date(0), buffer = Buffer.from("x");
  assert.deepEqual(pg("SELECT ?, ?, ?, ?", [{ a: 1 }, [1, 2], date, buffer]).values, ['{"a":1}', "[1,2]", date, buffer]);
  const circular = {}; circular.self = circular;
  invalid(() => pg("SELECT ?", [circular]));
});

test("statement type and RETURNING are detected with the same tokenizer", () => {
  assert.equal(pg("INSERT INTO t(a) VALUES (?)", [1]).statement, "INSERT");
  assert.equal(pg("  insert into t(a) values (?)", [1]).statement, "INSERT");
  assert.equal(pg("/* c */ INSERT INTO t(a) VALUES (?)", [1]).statement, "INSERT");
  assert.equal(pg("SELECT 1").statement, "SELECT");
  assert.equal(pg("UPDATE t SET a = 1").statement, "UPDATE");
  assert.equal(pg("INSERT INTO t(a) VALUES (?) RETURNING id", [1]).hasReturning, true);
  assert.equal(pg("INSERT INTO t(a) VALUES (?)", [1]).hasReturning, false);
});

test("RETURNING inside a comment, string, identifier or subquery does not count", () => {
  assert.equal(pg("INSERT INTO t(a) VALUES (?) /* RETURNING id */", [1]).hasReturning, false);
  assert.equal(pg("INSERT INTO t(a) VALUES (?) -- RETURNING id", [1]).hasReturning, false);
  assert.equal(pg("INSERT INTO t(a) VALUES ('RETURNING')").hasReturning, false);
  assert.equal(pg('INSERT INTO t("returning") VALUES (1)').hasReturning, false);
  assert.equal(pg("INSERT INTO t(a) SELECT x FROM (DELETE FROM u RETURNING x) q").hasReturning, false);
  assert.equal(pg("INSERT INTO t(a) VALUES ($$ RETURNING $$)").hasReturning, false);
});

test("multiple statements are rejected, a trailing semicolon is dropped", () => {
  invalid(() => pg("SELECT 1; SELECT 2"));
  invalid(() => my("SELECT 1; DROP TABLE t"));
  invalid(() => pg("SELECT 1;;"));
  assert.equal(pg("SELECT 1;").text, "SELECT 1");
  assert.equal(pg("SELECT 1;  \n -- done\n").text, "SELECT 1  \n -- done\n");
  assert.equal(pg("SELECT ';'").text, "SELECT ';'");
  assert.equal(pg("SELECT $$;$$").text, "SELECT $$;$$");
});

test("unterminated strings and comments are rejected", () => {
  for (const sql of ["SELECT 'abc", 'SELECT "abc', "SELECT /* abc", "SELECT $$ abc"]) {
    assert.throws(() => pg(sql), error => error.name === "SqlError" && error.kind === "SYNTAX", sql);
  }
  assert.throws(() => my("SELECT `abc"), error => error.kind === "SYNTAX");
});

test("empty or non-string SQL is rejected", () => {
  invalid(() => pg(""));
  invalid(() => pg("   "));
  invalid(() => pg(null));
  invalid(() => pg(42));
});

test("a colon that is not a placeholder is left as is", () => {
  assert.equal(my("SET @x := 1").text, "SET @x := 1");
  assert.equal(pg("SELECT 1 WHERE a = ':'").text, "SELECT 1 WHERE a = ':'");
  assert.equal(pg("SELECT ?::text, ?", [1, 2]).text, "SELECT $1::text, $2");
});

test("the translation cache is bounded and keyed by dialect", () => {
  clearCache();
  const a = pg("SELECT ?", [1]).text, b = my("SELECT ?", [1]).text;
  assert.equal(a, "SELECT $1");
  assert.equal(b, "SELECT ?");
  assert.equal(cacheSize(), 2);
  for (let i = 0; i < 700; i++) pg(`SELECT ${i}`);
  assert.ok(cacheSize() <= 500);
  assert.equal(pg("SELECT ?", [1]).text, "SELECT $1");
});

test("error messages never contain parameter values", () => {
  try { pg("SELECT ?, ?", ["super-secret-value"]); assert.fail("should throw"); }
  catch (error) { assert.ok(!error.message.includes("super-secret-value")); }
  try { pg("SELECT :a", { a: 1, "secret-key-value": "x" }); assert.fail("should throw"); }
  catch (error) { assert.equal(error.kind, "INVALID_PARAMS"); }
});

test("a binary JSON operator ? is documented as incompatible (it is treated as a placeholder)", () => {
  invalid(() => pg("SELECT data ? 'key' FROM t"));
  assert.equal(pg("SELECT jsonb_exists(data, ?) FROM t", ["key"]).text, "SELECT jsonb_exists(data, $1) FROM t");
});
