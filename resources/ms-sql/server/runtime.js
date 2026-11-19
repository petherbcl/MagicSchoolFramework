"use strict";

const { loadConfig } = require("./config");
const { createSql } = require("./index");

const PREFIX = "[ms-sql] ";

// Builds the logger handed to createSql. It only prefixes: createSql never passes URLs or parameter values.
function createLogger(sink) {
  return Object.freeze({
    info: message => sink.log(PREFIX + message),
    warn: message => sink.warn(PREFIX + message),
    error: message => sink.error(PREFIX + message),
  });
}

// Wires createSql to the runtime. `host` is injected ({ Events, Exports, console }) so tests can fake it;
// only server/main.js passes the real globals. Nothing here registers client events.
function start(host, deps = {}) {
  const { Events, Exports } = host;
  const load = deps.loadConfig || loadConfig;
  const create = deps.createSql || createSql;
  const logger = createLogger(host.console || console);
  let owner = null;

  Events.on("resourceStart", name => {
    if (name !== "ms-sql" || owner) return;
    let config;
    try { config = load(); }
    catch (error) { logger.error("Invalid configuration: " + error.message); throw new Error("MS_SQL_CONFIG_INVALID"); }
    // SEC-06 / SEC-02: loud, value-free warnings for unsafe or ineffective settings (names only, never the URL).
    if (config.databaseConfigured && !config.ssl && config.hostLocal === false) {
      logger.warn("MS_SQL_SSL is false but the database host is not local: credentials and data travel unencrypted. Set MS_SQL_SSL=true (and MS_SQL_SSL_CA for a private CA)");
    }
    if (config.ignoredUrlParams?.length) {
      logger.warn("Ignoring MS_SQL_URL query parameters (" + config.ignoredUrlParams.join(", ") + "): use MS_SQL_SSL, MS_SQL_SSL_CA and the MS_SQL_* settings instead");
    }
    if (config.ignoredUrlTls?.length) {
      logger.warn("MS_SQL_URL requests TLS (" + config.ignoredUrlTls.join(", ") + ") but the URL query string is ignored and MS_SQL_SSL is not true: the connection is NOT encrypted. Set MS_SQL_SSL=true (and MS_SQL_SSL_CA for a private CA)");
    }
    if (config.ignoredUrlDatabase) {
      logger.warn("Ignoring the database name in MS_SQL_URL: on MySQL/MariaDB the schema is the database and comes from MS_SQL_SCHEMA");
    }
    if (!config.databaseConfigured) logger.warn("MS_SQL_URL is not set (resources/ms-sql/.env or process environment); the database stays unavailable and every query is rejected with NOT_READY");

    const api = create({
      config, logger,
      onReady: ({ dialect }) => { logger.info(`Database ready (${dialect})`); Events.emit("ms-sql:ready", { dialect }); },
      onDown: () => Events.emit("ms-sql:down"),
    });
    owner = api;
    // The public view has no close(): only this resource may shut the pool down.
    const { close, ...publicApi } = api;
    if (!Exports.register("Sql", Object.freeze(publicApi))) {
      logger.error("Export registration failed");
      api.close();
      owner = null;
      throw new Error("MS_SQL_EXPORT_REGISTRATION_FAILED");
    }
  });

  Events.on("resourceStop", async name => {
    if (name !== "ms-sql" || !owner) return;
    const api = owner;
    owner = null;
    await api.close();
  });
}

module.exports = { start, createLogger };
