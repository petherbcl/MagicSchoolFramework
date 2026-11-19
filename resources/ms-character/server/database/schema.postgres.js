"use strict";
// PostgreSQL DDL, one statement per entry (ms-sql runs a single statement per call).
// No schema is named or created here: ms-sql (MS_SQL_SCHEMA) creates it and sets the search_path of every
// connection, so every name is unqualified. Idempotent: creates missing objects and leaves existing tables and
// data untouched. Requires ms-core's tables (ms_users) in the same schema first.
module.exports = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ms_characters (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES ms_users(id),
 first_name TEXT NOT NULL,last_name TEXT NOT NULL,house TEXT NOT NULL,
 state JSONB NOT NULL DEFAULT '{"inventory":[],"look":null,"location":null}',version INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_played_at TIMESTAMPTZ,
 deleted_at TIMESTAMPTZ
)`,
  // deleted_at is the soft delete marker (NULL = active).
  "CREATE INDEX IF NOT EXISTS ms_characters_user ON ms_characters(user_id)",
  "CREATE INDEX IF NOT EXISTS ms_characters_user_active ON ms_characters(user_id) WHERE deleted_at IS NULL",
]);
