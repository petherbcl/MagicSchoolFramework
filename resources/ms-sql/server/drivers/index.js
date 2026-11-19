"use strict";

// Driver factory. Drivers are loaded lazily so a PostgreSQL deployment never loads mysql2 and vice versa.
function createDriver(config) {
  if (config.dialect === "postgres") return require("./postgres").createPostgresDriver(config);
  if (config.dialect === "mysql" || config.dialect === "mariadb") return require("./mysql").createMysqlDriver(config);
  throw new Error("No database dialect configured");
}

module.exports = { createDriver };
