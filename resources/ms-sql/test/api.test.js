"use strict";
// Public API against a real database through the real drivers. PostgreSQL (PGlite over a socket) always
// runs; MySQL and MariaDB run when MS_SQL_TEST_MYSQL_URL / MS_SQL_TEST_MARIADB_URL are set and are reported
// as skipped, with the reason, otherwise. The exhaustive cross-dialect suite is TASK-07 (conformance.test.js).
const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { DIALECTS, connect, DDL } = require("./helpers/dialects");

const rejects = (promise, kind) => assert.rejects(promise, error => { assert.equal(error.name, "SqlError"); assert.equal(error.kind, kind); return true; });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

for (const dialect of DIALECTS) {
  describe(`[${dialect.name}] public API`, { skip: dialect.skip ? `${dialect.name} tests skipped: ${dialect.skip}` : false }, () => {
    let db, sql, warnings;
    const ddl = DDL[dialect.name];
    const resetDatabase = async () => { for (const statement of ddl.reset) await sql.query(statement); };

    before(async () => {
      db = await dialect.start();
      ({ sql, warnings } = connect(db));
      await sql.awaitConnection(5000);
      await sql.query(ddl.create);
      await sql.query(ddl.createChild);
    });
    after(async () => { await sql?.close(); await db?.stop(); });
    beforeEach(resetDatabase);

    test("ready, dialect and frozen object", () => {
      assert.equal(sql.isReady(), true);
      assert.equal(sql.dialect, dialect.name);
      assert.ok(Object.isFrozen(sql));
    });

    test("insert returns the new id as a string, with ? and :name", async () => {
      const first = await sql.insert("INSERT INTO t_items (name, qty) VALUES (?, ?)", ["apple", 3]);
      assert.equal(first, "1");
      assert.equal(typeof first, "string");
      const second = await sql.insert("INSERT INTO t_items (name, qty) VALUES (:name, :qty)", { name: "pear", qty: 5 });
      assert.equal(second, "2");
    });

    test("insert with returning option and with an explicit RETURNING (PostgreSQL)", async () => {
      assert.equal(await sql.insert("INSERT INTO t_items (name) VALUES (?)", ["x"], { returning: "id" }), "1");
      await rejects(sql.insert("INSERT INTO t_items (name) VALUES (?)", ["y"], { returning: "id; DROP TABLE t_items" }), "INVALID_PARAMS");
      await rejects(sql.insert("UPDATE t_items SET qty = 1"), "INSERT_REQUIRED");
      if (dialect.name === "postgres") assert.equal(await sql.insert("INSERT INTO t_items (name) VALUES (?) RETURNING id", ["z"]), "2");
    });

    test("query, single, scalar formats", async () => {
      await sql.insert("INSERT INTO t_items (name, qty) VALUES (?, ?)", ["a", 1]);
      await sql.insert("INSERT INTO t_items (name, qty) VALUES (?, ?)", ["b", 2]);
      const rows = await sql.query("SELECT name, qty FROM t_items ORDER BY id");
      assert.deepEqual(rows.map(r => ({ ...r })), [{ name: "a", qty: 1 }, { name: "b", qty: 2 }]);
      assert.deepEqual({ ...(await sql.single("SELECT name FROM t_items WHERE qty = ?", [2])) }, { name: "b" });
      assert.equal(await sql.single("SELECT name FROM t_items WHERE qty = ?", [99]), null);
      assert.equal(await sql.scalar("SELECT name FROM t_items WHERE qty = ?", [2]), "b");
      assert.equal(await sql.scalar("SELECT name FROM t_items WHERE qty = ?", [99]), null);
      assert.equal(Number(await sql.scalar("SELECT count(*) FROM t_items")), 2);
      assert.deepEqual({ ...(await sql.single("SELECT name FROM t_items WHERE qty = :q OR qty = :q ORDER BY id", { q: 1 })) }, { name: "a" });
    });

    test("query on a non-row statement returns the header; update returns affectedRows (matched rows)", async () => {
      await sql.insert("INSERT INTO t_items (name, qty) VALUES (?, ?)", ["a", 1]);
      const header = await sql.query("UPDATE t_items SET qty = ? WHERE name = ?", [1, "a"]);
      assert.equal(header.affectedRows, 1, "an UPDATE that changes nothing still counts the matched row");
      assert.ok("insertId" in header && "changedRows" in header);
      assert.equal(await sql.update("UPDATE t_items SET qty = qty + 1 WHERE name = ?", ["a"]), 1);
      assert.equal(await sql.update("UPDATE t_items SET qty = 0 WHERE name = ?", ["nobody"]), 0);
      assert.equal(await sql.update("DELETE FROM t_items WHERE name = ?", ["a"]), 1);
      assert.equal(typeof (await sql.update("DELETE FROM t_items")), "number");
    });

    test("prepare returns the same formats as query", async () => {
      await sql.prepare("INSERT INTO t_items (name, qty) VALUES (?, ?)", ["p", 4]);
      for (let i = 0; i < 2; i++) assert.deepEqual((await sql.prepare("SELECT qty FROM t_items WHERE name = ?", ["p"])).map(r => ({ ...r })), [{ qty: 4 }]);
      const header = await sql.prepare("UPDATE t_items SET qty = 5 WHERE name = ?", ["p"]);
      assert.equal(header.affectedRows, 1);
    });

    test("rawExecute runs every parameter set in order", async () => {
      const results = await sql.rawExecute("INSERT INTO t_items (name, qty) VALUES (?, ?)", [["r1", 1], ["r2", 2], ["r3", 3]]);
      assert.equal(results.length, 3);
      assert.ok(results.every(r => r.affectedRows === 1));
      assert.equal(Number(await sql.scalar("SELECT count(*) FROM t_items")), 3);
      assert.deepEqual(await sql.rawExecute("SELECT 1", []), []);
      await rejects(sql.rawExecute("INSERT INTO t_items (name, qty) VALUES (?, ?)", [["only-one"]]), "INVALID_PARAMS");
    });

    test("undefined is stored as NULL; JSON values round trip as objects", async () => {
      await sql.insert("INSERT INTO t_items (name, qty, data) VALUES (?, ?, ?)", ["j", 1, { a: [1, { b: "x" }], ok: true }]);
      await sql.insert("INSERT INTO t_items (name, qty, data) VALUES (?, ?, ?)", ["n", 1, undefined]);
      const row = await sql.single("SELECT data FROM t_items WHERE name = ?", ["j"]);
      assert.deepEqual(row.data, { a: [1, { b: "x" }], ok: true });
      assert.equal((await sql.single("SELECT data FROM t_items WHERE name = ?", ["n"])).data, null);
    });

    test("dates round trip in UTC", async () => {
      const at = new Date("2026-03-04T05:06:07.089Z");
      await sql.insert("INSERT INTO t_items (name, created) VALUES (?, ?)", ["d", at]);
      const row = await sql.single("SELECT created FROM t_items WHERE name = ?", ["d"]);
      assert.ok(row.created instanceof Date);
      assert.equal(row.created.toISOString(), at.toISOString());
    });

    test("BIGINT identity values above 2^53 stay exact strings", async () => {
      const big = "9007199254740993";
      await sql.query(dialect.name === "postgres" ? "ALTER TABLE t_items ALTER COLUMN id RESTART WITH " + big : "ALTER TABLE t_items AUTO_INCREMENT = " + big);
      assert.equal(await sql.insert("INSERT INTO t_items (name) VALUES (?)", ["big"]), big);
      const row = await sql.single("SELECT id FROM t_items WHERE name = ?", ["big"]);
      assert.equal(row.id, big);
      assert.equal(typeof row.id, "string");
      await resetDatabase();
    });

    test("unique and foreign key violations are normalized and never leak the value", async () => {
      await sql.insert("INSERT INTO t_items (name) VALUES (?)", ["secret-duplicate-value"]);
      await assert.rejects(sql.insert("INSERT INTO t_items (name) VALUES (?)", ["secret-duplicate-value"]), error => {
        assert.equal(error.name, "SqlError");
        assert.equal(error.code, "SQL_ERROR");
        assert.equal(error.kind, "UNIQUE_VIOLATION");
        assert.ok(error.constraint, "constraint name is reported");
        assert.ok(!error.message.includes("secret-duplicate-value"));
        assert.ok(error.cause instanceof Error);
        return true;
      });
      await assert.rejects(sql.insert("INSERT INTO t_children (item_id) VALUES (?)", [999]), error => {
        assert.equal(error.kind, "FOREIGN_KEY_VIOLATION");
        assert.ok(error.constraint);
        return true;
      });
      assert.equal(sql.isReady(), true);
    });

    test("syntax errors are normalized; the pool keeps working", async () => {
      await rejects(sql.query("SELEKT 1"), "SYNTAX");
      await rejects(sql.query("SELECT * FROM table_that_does_not_exist"), "SYNTAX");
      assert.equal(Number(await sql.scalar("SELECT 1")), 1);
    });

    test("multiple statements and bad parameters are rejected before reaching the database", async () => {
      await rejects(sql.query("SELECT 1; SELECT 2"), "INVALID_PARAMS");
      await rejects(sql.query("SELECT ?", []), "INVALID_PARAMS");
      await rejects(sql.query("SELECT ?, :a", [1]), "INVALID_PARAMS");
      await rejects(sql.query("SELECT ?", [() => 1]), "INVALID_PARAMS");
    });

    test("transaction(fn) commits and returns the callback value", async () => {
      const id = await sql.transaction(async tx => {
        const created = await tx.insert("INSERT INTO t_items (name, qty) VALUES (?, ?)", ["tx", 1]);
        await tx.insert("INSERT INTO t_children (item_id) VALUES (?)", [created]);
        return created;
      });
      assert.equal(id, "1");
      assert.equal(Number(await sql.scalar("SELECT count(*) FROM t_children")), 1);
    });

    test("transaction(fn) rolls back when fn rejects, rethrowing the original error", async () => {
      const original = new Error("stop here");
      await assert.rejects(sql.transaction(async tx => {
        await tx.insert("INSERT INTO t_items (name) VALUES (?)", ["gone"]);
        throw original;
      }), error => error === original);
      assert.equal(Number(await sql.scalar("SELECT count(*) FROM t_items")), 0);
    });

    test("transaction(fn) rolls back after a failed statement", async () => {
      await assert.rejects(sql.transaction(async tx => {
        await tx.insert("INSERT INTO t_items (name) VALUES (?)", ["first"]);
        await tx.insert("INSERT INTO t_items (name) VALUES (?)", ["first"]);
      }), error => error.kind === "UNIQUE_VIOLATION");
      assert.equal(Number(await sql.scalar("SELECT count(*) FROM t_items")), 0);
      assert.equal(sql.isReady(), true);
    });

    test("tx is unusable after commit, and nested transactions fail clearly", async () => {
      let leaked;
      await sql.transaction(async tx => { leaked = tx; });
      await rejects(leaked.query("SELECT 1"), "OTHER");
      await assert.rejects(sql.transaction(tx => tx.transaction(async () => 1)), /Nested transactions/);
    });

    test("transaction([...]) commits all statements and returns true", async () => {
      assert.equal(await sql.transaction([
        { query: "INSERT INTO t_items (name, qty) VALUES (?, ?)", values: ["a", 1] },
        { query: "INSERT INTO t_items (name, qty) VALUES (:name, :qty)", values: { name: "b", qty: 2 } },
        { query: "UPDATE t_items SET qty = qty + 10" },
      ]), true);
      assert.equal(Number(await sql.scalar("SELECT sum(qty) FROM t_items")), 23);
    });

    test("transaction([...]) rolls back everything when one statement fails", async () => {
      await rejects(sql.transaction([
        { query: "INSERT INTO t_items (name) VALUES (?)", values: ["dup"] },
        { query: "INSERT INTO t_items (name) VALUES (?)", values: ["dup"] },
      ]), "UNIQUE_VIOLATION");
      assert.equal(Number(await sql.scalar("SELECT count(*) FROM t_items")), 0);
    });

    test("concurrent transactions use separate connections without mixing results", async () => {
      const results = await Promise.all([1, 2, 3].map(n => sql.transaction(async tx => tx.insert("INSERT INTO t_items (name, qty) VALUES (?, ?)", ["c" + n, n]))));
      assert.equal(new Set(results).size, 3);
      assert.equal(Number(await sql.scalar("SELECT count(*) FROM t_items")), 3);
    });

    test("withLock serializes the same name and runs different names in parallel", async () => {
      const order = [];
      const job = (name, label, ms) => sql.withLock(name, async tx => {
        order.push("start " + label);
        assert.equal(Number(await tx.scalar("SELECT 1")), 1);
        await wait(ms);
        order.push("end " + label);
        return label;
      });
      assert.deepEqual(await Promise.all([job("same", "1", 40), job("same", "2", 5)]), ["1", "2"]);
      assert.deepEqual(order, ["start 1", "end 1", "start 2", "end 2"]);
      order.length = 0;
      await Promise.all([job("one", "a", 40), job("two", "b", 40)]);
      assert.deepEqual(order.slice(0, 2).sort(), ["start a", "start b"]);
    });

    test("withLock releases when fn rejects, and times out when the lock is held", async () => {
      const boom = new Error("inside lock");
      await assert.rejects(sql.withLock("release-me", async () => { throw boom; }), error => error === boom);
      assert.equal(await sql.withLock("release-me", async () => "free again"), "free again");
      const holder = sql.withLock("busy", () => wait(150));
      await wait(10);
      await rejects(sql.withLock("busy", async () => 1, 30), "TIMEOUT");
      await holder;
    });

    test("withLock scope can run DDL-style statements and is dead afterwards", async () => {
      let scope;
      await sql.withLock("ddl", async tx => { scope = tx; await tx.query(ddl.create); });
      await rejects(scope.query("SELECT 1"), "OTHER");
    });

    test("slow queries produce a log line with SQL only", async () => {
      const slow = connect(db, { MS_SQL_SLOW_QUERY_MS: "1" });
      try {
        await slow.sql.awaitConnection(5000);
        if (dialect.name === "postgres") await slow.sql.query("SELECT pg_sleep(0.05), ? AS marker", ["parameter-secret"]);
        else await slow.sql.query("SELECT SLEEP(0.05), ? AS marker", ["parameter-secret"]);
        const lines = slow.warnings.filter(w => w.startsWith("Slow query"));
        assert.equal(lines.length, 1);
        assert.ok(!lines[0].includes("parameter-secret"));
      } finally { await slow.sql.close(); }
    });

    test("close is idempotent and later calls reject with NOT_READY", async () => {
      const other = connect(db);
      await other.sql.awaitConnection(5000);
      await other.sql.close();
      await other.sql.close();
      assert.equal(other.sql.isReady(), false);
      await rejects(other.sql.query("SELECT 1"), "NOT_READY");
    });
  });
}

describe("unreachable database (real driver)", () => {
  test("starts not ready, rejects queries immediately and awaitConnection times out", async () => {
    const { sql } = connect({ url: "postgresql://u:p@127.0.0.1:1/db" }, { MS_SQL_QUERY_TIMEOUT_MS: "500" }, { backoff: { minMs: 20, maxMs: 40 } });
    try {
      assert.equal(sql.isReady(), false);
      await rejects(sql.query("SELECT 1"), "NOT_READY");
      await rejects(sql.awaitConnection(200), "TIMEOUT");
    } finally { await sql.close(); }
  });
});
