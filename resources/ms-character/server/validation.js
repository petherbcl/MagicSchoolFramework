"use strict";

const HOUSES = Object.freeze(["Unaffiliated", "Gryffindor", "Hufflepuff", "Ravenclaw", "Slytherin"]);

class CharacterError extends Error {
  constructor(code, message = code) { super(message); this.name = "CharacterError"; this.code = code; }
}
function check(condition, code) { if (!condition) throw new CharacterError(code); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function json(value, maxBytes) {
  let encoded;
  try {
    encoded = JSON.stringify(value, (key, item) => {
      check(!["__proto__", "constructor", "prototype"].includes(key), "INVALID_JSON_KEY");
      if (typeof item === "number") check(Number.isFinite(item), "INVALID_JSON");
      return item;
    });
  } catch (error) { if (error instanceof CharacterError) throw error; throw new CharacterError("INVALID_JSON"); }
  check(typeof encoded === "string" && Buffer.byteLength(encoded) <= maxBytes, "JSON_TOO_LARGE");
  return encoded;
}
function characterInput(value) {
  check(value && typeof value === "object", "INVALID_CHARACTER");
  const name = input => {
    check(typeof input === "string", "INVALID_NAME");
    const normalized = input.trim().normalize("NFC");
    check(normalized.length >= 2 && normalized.length <= 32 && /^[\p{L}][\p{L}\p{M}' -]*$/u.test(normalized), "INVALID_NAME");
    return normalized;
  };
  check(HOUSES.includes(value.house), "INVALID_HOUSE");
  return { firstName: name(value.firstName), lastName: name(value.lastName), house: value.house };
}
function publicId(value) {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  check(typeof id === "string" && /^[1-9][0-9]{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n, "INVALID_ID");
  return id;
}
module.exports = { CharacterError, check, clone, json, characterInput, publicId, HOUSES };
