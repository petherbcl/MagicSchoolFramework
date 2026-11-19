"use strict";
// MySQL 8.0.19+ / MariaDB 10.6+ DDL, one statement per entry. No database is named or created here: ms-sql
// (MS_SQL_SCHEMA) creates it and every connection is bound to it. Idempotent like the PostgreSQL one.
// Requires ms-core's tables (ms_users) in the same database first.
// Rules (docs/architecture-plan-ms-sql.md 3.3): indexes live inside CREATE TABLE (no CREATE INDEX IF NOT EXISTS);
// no literal DEFAULT on JSON (callers always pass the state); the partial index ms_characters_user_active becomes a
// plain (user_id, deleted_at) index. The table is always created with deleted_at.
const TS = "DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)";
module.exports = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ms_characters (
 id BIGINT AUTO_INCREMENT PRIMARY KEY,user_id BIGINT NOT NULL,
 first_name VARCHAR(64) NOT NULL,last_name VARCHAR(64) NOT NULL,house VARCHAR(32) NOT NULL,
 state JSON NOT NULL,version INT NOT NULL DEFAULT 0,
 created_at ${TS},updated_at ${TS},last_played_at DATETIME(3) NULL,deleted_at DATETIME(3) NULL,
 KEY ms_characters_user (user_id),
 KEY ms_characters_user_active (user_id,deleted_at),
 CONSTRAINT ms_characters_user_fk FOREIGN KEY (user_id) REFERENCES ms_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
]);
