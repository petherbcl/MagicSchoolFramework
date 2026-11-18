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
// LookJson (#api-client-lookjson), plan §4.3. Every key is either allowed, stripped or imposed by the server.
const LOOK_MAX_BYTES = 16 * 1024;
const LOOK_ID = /^[\w.\-/:#]+$/;
const LOOK_STRIPPED = Object.freeze(["scale", "scaleMode", "boneScales"]);
// Measured in game (findings §8): setVoice takes integers, tone is clamped to 0..1 and pitch is not clamped at all.
// The pitch limit is ours (must match VOICE_PITCH_MAX in ui-src/src/voice.js).
const VOICE_PITCH_MAX = 10;
const voiceInput = value => isPlainObject(value) && Object.keys(value).every(key => key === "tone" || key === "pitch")
  && Number.isInteger(value.tone) && value.tone >= 0 && value.tone <= 1
  && Number.isInteger(value.pitch) && Math.abs(value.pitch) <= VOICE_PITCH_MAX;
// The real Creator.exportLook() always returns these (findings §3), so a look without them is forged.
const LOOK_REQUIRED = Object.freeze(["format", "version", "gender", "pronoun", "presets", "gear"]);
// "Nenhum" (no glasses / no facial hair) is an empty option in the creator: it means the field is absent.
const OPTIONAL_EMPTY = Object.freeze(["faceGear", "facialHair"]);
const LOOK_IMPOSED = Object.freeze(["name", "house"]);
const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const lookId = value => typeof value === "string" && value.length <= 128 && LOOK_ID.test(value);
const LOOK_FIELDS = Object.freeze({
  format: value => typeof value === "string" && value.length <= 32,
  version: value => Number.isInteger(value) && value >= 0 && value <= 1000,
  gender: value => value === "male" || value === "female",
  presets: value => isPlainObject(value) && Object.keys(value).length <= 64
    && Object.entries(value).every(([key, item]) => lookId(key) && lookId(item)),
  gear: value => Array.isArray(value) && value.length <= 32 && value.every(lookId),
  faceGear: lookId,
  facialHair: lookId,
  facialHairColor: value => value === "hair" || (typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)),
  pronoun: value => value === "witch" || value === "wizard",
  hood: value => typeof value === "boolean",
  wandStyle: lookId,
  voice: voiceInput,
});
function lookInput(value, { firstName, lastName, house }) {
  if (![firstName, lastName, house].every(item => typeof item === "string")) throw new TypeError("lookInput requires the character's firstName, lastName and house");
  check(isPlainObject(value), "INVALID_LOOK");
  let look;
  // json() applies the forbidden-key, finite-number and size guards. Validating the re-parsed copy means
  // getters, toJSON and proxies cannot make the checked value differ from what gets serialized.
  try { look = JSON.parse(json(value, LOOK_MAX_BYTES)); } catch (error) {
    if (error instanceof CharacterError) throw new CharacterError("INVALID_LOOK"); throw error;
  }
  check(isPlainObject(look), "INVALID_LOOK");
  const result = {};
  for (const [key, item] of Object.entries(look)) {
    if (LOOK_STRIPPED.includes(key) || LOOK_IMPOSED.includes(key)) continue;
    if (OPTIONAL_EMPTY.includes(key) && item === "") continue; // "Nenhum" in the creator may export an empty string
    check(Object.hasOwn(LOOK_FIELDS, key) && LOOK_FIELDS[key](item), "INVALID_LOOK");
    result[key] = item;
  }
  check(LOOK_REQUIRED.every(key => Object.hasOwn(result, key)), "INVALID_LOOK");
  if (result.gender === "female") { delete result.facialHair; delete result.facialHairColor; }
  result.name = { first: firstName, last: lastName };
  result.house = house;
  return result;
}
function publicId(value) {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  check(typeof id === "string" && /^[1-9][0-9]{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n, "INVALID_ID");
  return id;
}
module.exports = { CharacterError, check, clone, json, characterInput, lookInput, publicId, HOUSES, VOICE_PITCH_MAX };
