"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { SqlError, mapError, KINDS } = require("../server/errors");

const pgError = (code, extra = {}) => Object.assign(new Error("driver message with secret-value"), { code, ...extra });
const myError = (errno, code, extra = {}) => Object.assign(new Error(extra.message || "driver message with secret-value"), { errno, code, ...extra });
const map = (dialect, error) => mapError(dialect, error);

test("SqlError has the stable shape", () => {
  const cause = new Error("boom");
  const error = new SqlError("OTHER", "msg", { constraint: "c", sqlState: "23505", driverCode: "x", cause });
  assert.ok(error instanceof Error);
  assert.equal(error.name, "SqlError");
  assert.equal(error.code, "SQL_ERROR");
  assert.equal(error.kind, "OTHER");
  assert.equal(error.constraint, "c");
  assert.equal(error.cause, cause);
  assert.ok(KINDS.includes("UNIQUE_VIOLATION") && KINDS.includes("NOT_READY"));
  assert.equal(new SqlError("OTHER").constraint, null);
});

test("PostgreSQL mapping table", () => {
  const cases = [
    [pgError("23505", { constraint: "uq_name" }), "UNIQUE_VIOLATION", "uq_name"],
    [pgError("23503", { constraint: "fk_item" }), "FOREIGN_KEY_VIOLATION", "fk_item"],
    [pgError("40P01"), "DEADLOCK"], [pgError("40001"), "DEADLOCK"],
    [pgError("57014"), "TIMEOUT"],
    [pgError("08006"), "CONNECTION"], [pgError("08001"), "CONNECTION"], [pgError("57P01"), "CONNECTION"],
    [pgError("28P01"), "CONNECTION"], [pgError("53300"), "CONNECTION"],
    [pgError("ECONNREFUSED"), "CONNECTION"], [pgError("ECONNRESET"), "CONNECTION"], [pgError("ENOTFOUND"), "CONNECTION"],
    [pgError("42601"), "SYNTAX"], [pgError("42P01"), "SYNTAX"], [pgError("42703"), "SYNTAX"],
    [pgError("22P02"), "OTHER"], [pgError("23502"), "OTHER"], [pgError(undefined), "OTHER"],
  ];
  for (const [error, kind, constraint] of cases) {
    const mapped = map("postgres", error);
    assert.equal(mapped.kind, kind, String(error.code));
    assert.equal(mapped.constraint, constraint ?? null, String(error.code));
    assert.equal(mapped.cause, error);
    assert.equal(mapped.code, "SQL_ERROR");
    assert.equal(mapped.driverCode, error.code ?? null);
  }
  assert.equal(map("postgres", pgError("23505")).sqlState, "23505");
  assert.equal(map("postgres", pgError("ECONNREFUSED")).sqlState, null);
});

test("PostgreSQL client side timeouts and connection drops without a code", () => {
  assert.equal(map("postgres", new Error("Query read timeout")).kind, "TIMEOUT");
  assert.equal(map("postgres", new Error("timeout exceeded when trying to connect")).kind, "CONNECTION");
  assert.equal(map("postgres", new Error("Connection terminated unexpectedly")).kind, "CONNECTION");
  assert.equal(map("postgres", new Error("Client has encountered a connection error and is not queryable")).kind, "CONNECTION");
  assert.equal(map("postgres", new Error("something else")).kind, "OTHER");
});

test("MySQL and MariaDB mapping table", () => {
  const cases = [
    [myError(1062, "ER_DUP_ENTRY", { sqlState: "23000", sqlMessage: "Duplicate entry 'secret-value' for key 'ms_users.uq_name'" }), "UNIQUE_VIOLATION", "uq_name"],
    [myError(1451, "ER_ROW_IS_REFERENCED_2", { sqlMessage: "Cannot delete or update a parent row: a foreign key constraint fails (`db`.`child`, CONSTRAINT `fk_child_item` FOREIGN KEY (`item_id`) REFERENCES `t_items` (`id`))" }), "FOREIGN_KEY_VIOLATION", "fk_child_item"],
    [myError(1452, "ER_NO_REFERENCED_ROW_2", { sqlMessage: "Cannot add or update a child row: a foreign key constraint fails (`db`.`child`, CONSTRAINT `fk_child_item` FOREIGN KEY (`item_id`) REFERENCES `t_items` (`id`))" }), "FOREIGN_KEY_VIOLATION", "fk_child_item"],
    [myError(1213, "ER_LOCK_DEADLOCK"), "DEADLOCK"],
    [myError(3024, "ER_QUERY_TIMEOUT"), "TIMEOUT"], [myError(1205, "ER_LOCK_WAIT_TIMEOUT"), "TIMEOUT"],
    [myError(undefined, "PROTOCOL_SEQUENCE_TIMEOUT"), "TIMEOUT"], [myError(undefined, "POOL_ACQUIRE_TIMEOUT"), "TIMEOUT"],
    [myError(undefined, "ECONNREFUSED"), "CONNECTION"], [myError(undefined, "PROTOCOL_CONNECTION_LOST"), "CONNECTION"],
    [myError(undefined, "ETIMEDOUT"), "CONNECTION"], [myError(1045, "ER_ACCESS_DENIED_ERROR"), "CONNECTION"],
    [myError(undefined, undefined, { fatal: true }), "CONNECTION"],
    [myError(1064, "ER_PARSE_ERROR", { sqlState: "42000" }), "SYNTAX"],
    [myError(1146, "ER_NO_SUCH_TABLE", { sqlState: "42S02" }), "SYNTAX"],
    [myError(1048, "ER_BAD_NULL_ERROR", { sqlState: "23000" }), "OTHER"],
  ];
  for (const dialect of ["mysql", "mariadb"]) {
    for (const [error, kind, constraint] of cases) {
      const mapped = map(dialect, error);
      assert.equal(mapped.kind, kind, `${dialect} ${error.code ?? error.errno}`);
      assert.equal(mapped.constraint, constraint ?? null, `${dialect} ${error.code ?? error.errno}`);
      assert.equal(mapped.cause, error);
    }
  }
  assert.equal(map("mysql", myError(1062, "ER_DUP_ENTRY")).driverCode, "ER_DUP_ENTRY");
  assert.equal(map("mysql", myError(1062, "ER_DUP_ENTRY", { sqlState: "23000" })).sqlState, "23000");
});

test("MySQL constraint extraction: MariaDB format without table prefix, PRIMARY, and hostile values", () => {
  const dup = message => map("mariadb", myError(1062, "ER_DUP_ENTRY", { sqlMessage: message })).constraint;
  assert.equal(dup("Duplicate entry '1' for key 'uq_name'"), "uq_name");
  assert.equal(dup("Duplicate entry '1' for key 'ms_users.PRIMARY'"), "PRIMARY");
  assert.equal(dup("Duplicate entry 'x for key ''fake'' y' for key 'ms_connection_identifiers_unique_owner'"), "ms_connection_identifiers_unique_owner");
  assert.equal(dup("Duplicate entry 'steamId:76561198000000000' for key 'ms_connection_identifiers.ms_connection_identifiers_unique_owner'"), "ms_connection_identifiers_unique_owner");
  assert.equal(dup("unexpected text"), null);
});

test("the message never contains the driver message or any value", () => {
  const dupe = myError(1062, "ER_DUP_ENTRY", { sqlMessage: "Duplicate entry 'secret-value' for key 'ms_users.uq_name'", sqlState: "23000" });
  const cases = [map("mysql", dupe), map("postgres", pgError("23505", { constraint: "uq_name", detail: "Key (name)=(secret-value) already exists." })),
    map("postgres", pgError("22P02")), map("mysql", myError(1064, "ER_PARSE_ERROR", { sqlMessage: "near 'secret-value'" }))];
  for (const error of cases) {
    assert.ok(!error.message.includes("secret-value"), error.message);
    assert.ok(error.message.startsWith("SQL error ("));
  }
  assert.equal(cases[0].message, "SQL error (UNIQUE_VIOLATION) on uq_name");
});

test("mapError is idempotent and tolerates non-error values", () => {
  const existing = new SqlError("TIMEOUT");
  assert.equal(map("postgres", existing), existing);
  const weird = map("postgres", "a string");
  assert.equal(weird.kind, "OTHER");
  assert.equal(weird.cause, "a string");
  assert.equal(map("mysql", null).kind, "OTHER");
});
