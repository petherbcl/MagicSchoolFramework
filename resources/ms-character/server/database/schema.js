"use strict";
// Picks the DDL for the dialect reported by ms-sql (`sql.dialect`). MySQL and MariaDB share one file.
const postgres = require("./schema.postgres");
const mysql = require("./schema.mysql");

function schemaFor(dialect) {
  if (dialect === "postgres") return postgres;
  if (dialect === "mysql" || dialect === "mariadb") return mysql;
  throw new Error("UNSUPPORTED_SQL_DIALECT");
}
module.exports = { schemaFor };
