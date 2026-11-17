"use strict";

const UNIQUE_IDENTIFIERS = Object.freeze(["steamId", "epicId", "discordId", "hardwareId"]);

class CoreError extends Error {
  constructor(code, message = code) { super(message); this.name = "CoreError"; this.code = code; }
}

function check(condition, code) { if (!condition) throw new CoreError(code); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function json(value, maxBytes = 16384) {
  check(value !== undefined, "INVALID_JSON");
  let encoded;
  try {
    encoded = JSON.stringify(value, (key, item) => {
      check(!["__proto__", "constructor", "prototype"].includes(key), "INVALID_JSON_KEY");
      check(typeof item !== "function" && typeof item !== "undefined" && typeof item !== "symbol", "INVALID_JSON");
      if (typeof item === "number") check(Number.isFinite(item), "INVALID_JSON");
      return item;
    });
  } catch (error) { if (error instanceof CoreError) throw error; throw new CoreError("INVALID_JSON"); }
  check(typeof encoded === "string" && Buffer.byteLength(encoded) <= maxBytes, "JSON_TOO_LARGE");
  return encoded;
}
function metadata(key, value) {
  check(typeof key === "string" && /^[a-z][a-zA-Z0-9_.:-]{0,63}$/.test(key) &&
    !["userId", "roles", "allowlist", "identities", "permissions", "prototype", "constructor"].includes(key), "INVALID_METADATA_KEY");
  return JSON.parse(json(value));
}
function observed(player) {
  const result = {};
  for (const key of ["steamId", "epicId", "discordId", "discordName", "hardwareId", "ip", "nickname"]) {
    const value = player[key];
    if (typeof value === "string" && value.trim()) result[key] = value.trim().slice(0, key === "nickname" ? 100 : 256);
  }
  return result;
}

function publicId(value) {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  check(typeof id === "string" && /^[1-9][0-9]{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n, "INVALID_ID");
  return id;
}
module.exports = { CoreError, check, clone, json, metadata, observed, publicId, UNIQUE_IDENTIFIERS };
