"use strict";
// Cross-dialect conformance. The very same assertions run for postgres (PGlite over a socket) and, when
// MS_SQL_TEST_MYSQL_URL / MS_SQL_TEST_MARIADB_URL are set, for mysql and mariadb; otherwise those dialects are
// reported as skipped with the reason. Per-dialect differences live in test/helpers/dialects.js, never in the
// assertions. Basic result formats, errors and transaction forms are already covered by api.test.js; this file
// focuses on behavior that must be identical across engines.
const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { DIALECTS, connect, DDL } = require("./helpers/dialects");

const BIG = "9007199254740993"; // 2^53 + 1
const rejects = (promise, kind) => assert.rejects(promise, error => { assert.equal(error.name, "SqlError"); assert.equal(error.kind, kind); return true; });
const plain = rows => rows.map(row => ({ ...row }));

for (const dialect of DIALECTS) {
  describe(`[${dialect.name}] conformance`, { skip: dialect.skip ? `${dialect.name} tests skipped: ${dialect.skip}` : false }, () => {
    let db, sql;
    const ddl = DDL[dialect.name];
    const resetDatabase = async () => { for (const statement of ddl.reset) await sql.query(statement); };

    before(async () => {
      db = await dialect.start();
      ({ sql } = connect(db));
      await sql.awaitConnection(5000);
      await sql.query(ddl.create);
      await sql.query(ddl.createChild);
    });
    after(async () => { await sql?.close(); await db?.stop(); });
    beforeEach(resetDatabase);

    test("result rows keep column names and order; INT is a number, BIGINT a string", async () => {
      await sql.insert("INSERT INTO t_items (name, qty) VALUES (?, ?)", ["a", 7]);
      const row = await sql.single("SELECT id, name, qty FROM t_items");
      assert.deepEqual(Object.keys(row), ["id", "name", "qty"]);
      assert.equal(row.id, "1");
      assert.equal(row.qty, 7);
      assert.equal(typeof row.qty, "number");
    });

    test("NULL parameters and NULL columns round trip as null", async () => {
      await sql.insert("INSERT INTO t_items (name, qty, data) VALUES (?, ?, ?)", ["n", 1, null]);
      assert.equal(await sql.scalar("SELECT data FROM t_items WHERE name = ?", ["n"]), null);
      assert.equal(await sql.scalar("SELECT name FROM t_items WHERE name = ?", ["missing"]), null);
      assert.equal(await sql.update("UPDATE t_items SET data = ? WHERE name = ?", [undefined, "n"]), 1);
    });

    test("unicode, quotes and SQL metacharacters in values are stored verbatim", async () => {
      const values = ["Hogwarts Legacy ✨ 🧙", "O'Brien \"quoted\"", "semi; -- comment /* x */", "back\\slash", "100% _wild_"];
      for (const [index, value] of values.entries()) await sql.insert("INSERT INTO t_items (name, qty) VALUES (?, ?)", [value, index]);
      const rows = await sql.query("SELECT name FROM t_items ORDER BY qty");
      assert.deepEqual(rows.map(r => r.name), values);
      assert.equal(await sql.scalar("SELECT qty FROM t_items WHERE name = ?", [values[2]]), 2);
    });

    test("a ? or :name inside a string literal is not a placeholder", async () => {
      assert.equal(await sql.scalar("SELECT 'what?' AS q"), "what?");
      assert.equal(await sql.scalar("SELECT 'a:b' AS q"), "a:b");
      assert.equal(await sql.scalar("SELECT ? AS q, 'x:y?' AS lit", ["v"]), "v");
    });

    test("parameters work in WHERE, LIKE, LIMIT and arithmetic", async () => {
      for (let i = 1; i <= 5; i++) await sql.insert("INSERT INTO t_items (name, qty) VALUES (?, ?)", ["item" + i, i]);
      assert.equal((await sql.query("SELECT name FROM t_items WHERE name LIKE ? ORDER BY qty", ["item%"])).length, 5);
      assert.deepEqual(plain(await sql.query("SELECT qty FROM t_items WHERE qty > ? ORDER BY qty LIMIT 2", [2])), [{ qty: 3 }, { qty: 4 }]);
      assert.equal(await sql.update("UPDATE t_items SET qty = qty * ? WHERE qty >= ?", [2, 4]), 2);
      assert.equal(Number(await sql.scalar("SELECT sum(qty) FROM t_items")), 1 + 2 + 3 + 8 + 10);
    });

    test("names are case sensitive for the unique constraint (binary collation)", async () => {
      await sql.insert("INSERT INTO t_items (name) VALUES (?)", ["Apple"]);
      await sql.insert("INSERT INTO t_items (name) VALUES (?)", ["apple"]);
      assert.equal(Number(await sql.scalar("SELECT count(*) FROM t_items")), 2);
      await rejects(sql.insert("INSERT INTO t_items (name) VALUES (?)", ["Apple"]), "UNIQUE_VIOLATION");
    });

    test("BIGINT ids above 2^53 are accepted as string parameters and filter exactly", async () => {
      await sql.query(dialect.name === "postgres" ? "ALTER TABLE t_items ALTER COLUMN id RESTART WITH " + BIG : "ALTER TABLE t_items AUTO_INCREMENT = " + BIG);
      const id = await sql.insert("INSERT INTO t_items (name) VALUES (?)", ["big"]);
      assert.equal(id, BIG);
      const child = await sql.insert("INSERT INTO t_children (item_id) VALUES (?)", [id]);
      assert.equal(typeof child, "string");
      const row = await sql.single("SELECT i.id AS item, c.item_id AS ref FROM t_items i JOIN t_children c ON c.item_id = i.id WHERE i.id = ?", [BIG]);
      assert.deepEqual({ ...row }, { item: BIG, ref: BIG });
      assert.equal(await sql.scalar("SELECT name FROM t_items WHERE id = ?", [id]), "big");
      await resetDatabase();
    });

    test("insert() ids are strings and consecutive inside and outside a transaction", async () => {
      const outside = await sql.insert("INSERT INTO t_items (name) VALUES (?)", ["o"]);
      const inside = await sql.transaction(tx => tx.insert("INSERT INTO t_items (name) VALUES (?)", ["i"]));
      assert.equal(typeof outside, "string");
      assert.equal(typeof inside, "string");
      assert.equal(BigInt(inside), BigInt(outside) + 1n);
    });

    test("JSON arrays, nested values and falsy members round trip unchanged", async () => {
      const samples = { arr: [1, "two", null, { three: 3 }], deep: { a: { b: { c: [] } }, zero: 0, no: false, empty: "" }, unicode: { text: "ação ✨" } };
      for (const [name, value] of Object.entries(samples)) await sql.insert("INSERT INTO t_items (name, data) VALUES (?, ?)", [name, value]);
      for (const [name, value] of Object.entries(samples)) assert.deepEqual((await sql.single("SELECT data FROM t_items WHERE name = ?", [name])).data, value);
    });

    test("an UPDATE or DELETE that matches nothing returns 0 and leaves data alone", async () => {
      await sql.insert("INSERT INTO t_items (name, qty) VALUES (?, ?)", ["keep", 1]);
      assert.equal(await sql.update("UPDATE t_items SET qty = 2 WHERE name = ?", ["nobody"]), 0);
      assert.equal(await sql.update("DELETE FROM t_items WHERE name = ?", ["nobody"]), 0);
      assert.equal(await sql.scalar("SELECT qty FROM t_items WHERE name = ?", ["keep"]), 1);
    });

    test("a transaction reads its own writes and they persist after commit", async () => {
      await sql.transaction(async tx => {
        await tx.insert("INSERT INTO t_items (name, qty) VALUES (?, ?)", ["t", 5]);
        assert.equal(await tx.scalar("SELECT qty FROM t_items WHERE name = ?", ["t"]), 5);
      });
      assert.equal(await sql.scalar("SELECT qty FROM t_items WHERE name = ?", ["t"]), 5);
    });

    test("every tx function works inside a transaction: update, single, prepare, rawExecute", async () => {
      await sql.transaction(async tx => {
        await tx.insert("INSERT INTO t_items (name, qty) VALUES (?, ?)", ["x", 1]);
        assert.equal(await tx.update("UPDATE t_items SET qty = ? WHERE name = ?", [2, "x"]), 1);
        assert.deepEqual({ ...(await tx.single("SELECT qty FROM t_items WHERE name = :n", { n: "x" })) }, { qty: 2 });
        await tx.prepare("INSERT INTO t_items (name, qty) VALUES (?, ?)", ["y", 3]);
        const results = await tx.rawExecute("INSERT INTO t_items (name, qty) VALUES (?, ?)", [["z1", 4], ["z2", 5]]);
        assert.equal(results.length, 2);
      });
      assert.equal(Number(await sql.scalar("SELECT count(*) FROM t_items")), 4);
    });

    test("a rolled back transaction undoes updates and deletes as well as inserts", async () => {
      await sql.insert("INSERT INTO t_items (name, qty) VALUES (?, ?)", ["stay", 1]);
      await rejects(sql.transaction([
        { query: "UPDATE t_items SET qty = 99 WHERE name = ?", values: ["stay"] },
        { query: "DELETE FROM t_items WHERE name = ?", values: ["stay"] },
        { query: "INSERT INTO t_children (item_id) VALUES (?)", values: [12345] },
      ]), "FOREIGN_KEY_VIOLATION");
      assert.deepEqual(plain(await sql.query("SELECT name, qty FROM t_items")), [{ name: "stay", qty: 1 }]);
    });

    test("transaction([...]) validates every entry before BEGIN, and an empty array commits nothing", async () => {
      await rejects(sql.transaction([{ query: "INSERT INTO t_items (name) VALUES (?)", values: ["early"] }, { query: "SELECT ?", values: [] }]), "INVALID_PARAMS");
      await rejects(sql.transaction([{ values: [] }]), "INVALID_PARAMS");
      assert.equal(Number(await sql.scalar("SELECT count(*) FROM t_items")), 0);
      assert.equal(await sql.transaction([]), true);
    });

    test("rawExecute with named parameter sets and invalid sets validates before executing", async () => {
      const results = await sql.rawExecute("INSERT INTO t_items (name, qty) VALUES (:name, :qty)", [{ name: "r1", qty: 1 }, { name: "r2", qty: 2 }]);
      assert.equal(results.length, 2);
      await rejects(sql.rawExecute("INSERT INTO t_items (name, qty) VALUES (?, ?)", [["ok", 1], ["bad"]]), "INVALID_PARAMS");
      assert.equal(Number(await sql.scalar("SELECT count(*) FROM t_items")), 2, "nothing from the invalid call was executed");
    });

    test("a failed statement mid rawExecute reports a normalized error and keeps the pool healthy", async () => {
      await rejects(sql.rawExecute("INSERT INTO t_items (name) VALUES (?)", [["dup"], ["dup"]]), "UNIQUE_VIOLATION");
      assert.equal(Number(await sql.scalar("SELECT count(*) FROM t_items")), 1);
      assert.equal(sql.isReady(), true);
    });

    test("foreign key violation on delete of a referenced row is normalized with the constraint", async () => {
      const id = await sql.insert("INSERT INTO t_items (name) VALUES (?)", ["parent"]);
      await sql.insert("INSERT INTO t_children (item_id) VALUES (?)", [id]);
      await assert.rejects(sql.update("DELETE FROM t_items WHERE id = ?", [id]), error => {
        assert.equal(error.kind, "FOREIGN_KEY_VIOLATION");
        assert.ok(error.constraint);
        return true;
      });
    });

    test("an error inside a transaction does not poison the connection for later calls", async () => {
      for (let i = 0; i < 6; i++) { // more rounds than pool connections
        await rejects(sql.transaction(async tx => { await tx.query("SELEKT 1"); }), "SYNTAX");
      }
      assert.equal(Number(await sql.scalar("SELECT 1")), 1);
      assert.equal(await sql.transaction(async tx => Number(await tx.scalar("SELECT 2"))), 2);
    });

    test("withLock scope behaves as a transaction-less connection that can run queries and return values", async () => {
      const result = await sql.withLock("conformance", async tx => {
        await tx.insert("INSERT INTO t_items (name, qty) VALUES (?, ?)", ["locked", 1]);
        return Number(await tx.scalar("SELECT count(*) FROM t_items"));
      });
      assert.equal(result, 1);
      await rejects(sql.withLock("", async () => 1), "INVALID_PARAMS");
      await rejects(sql.withLock("x".repeat(65), async () => 1), "INVALID_PARAMS");
    });

    test("many concurrent plain queries all resolve with their own result", async () => {
      const results = await Promise.all(Array.from({ length: 30 }, (_, n) => sql.scalar("SELECT ? AS n", [n])));
      assert.deepEqual(results.map(Number), Array.from({ length: 30 }, (_, n) => n));
    });
  });
}
