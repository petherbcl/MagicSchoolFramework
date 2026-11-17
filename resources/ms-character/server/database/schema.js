"use strict";
// Idempotent: creates missing objects and leaves existing tables and data untouched.
// Requires ms-core's schema (ms_core.ms_users) to exist first.
module.exports = `
CREATE SCHEMA IF NOT EXISTS ms_character;
CREATE TABLE IF NOT EXISTS ms_character.characters (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES ms_core.ms_users(id),
 first_name TEXT NOT NULL,last_name TEXT NOT NULL,house TEXT NOT NULL,
 state JSONB NOT NULL DEFAULT '{"inventory":[],"look":null,"location":null}',version INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),last_played_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS characters_user ON ms_character.characters(user_id);
`;
