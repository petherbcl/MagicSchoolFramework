"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { lookInput, CharacterError } = require("../server/validation");

const owner = { firstName: "Ana", lastName: "Silva", house: "Ravenclaw" };
function look(overrides = {}) {
  return {
    format: "arcanemp-look", version: 1, gender: "male", pronoun: "wizard", hood: false,
    presets: { "Face": "face_01", "Hair/Style": "hair:12#a" }, gear: ["robe.school", "shoes-01"],
    faceGear: "glasses_round", facialHair: "beard_02", facialHairColor: "#1c1410", wandStyle: "wand/oak",
    ...overrides,
  };
}
function rejects(value, message) {
  assert.throws(() => lookInput(value, owner), error => error instanceof CharacterError && error.code === "INVALID_LOOK", message);
}
const expected = (base = look()) => ({ ...base, name: { first: "Ana", last: "Silva" }, house: "Ravenclaw" });

test("lookInput accepts a valid look and keeps only the allowed fields", () => {
  assert.deepEqual(lookInput(look(), owner), expected());
});

const REQUIRED = ["format", "version", "gender", "pronoun", "presets", "gear"];
test("lookInput rejects a look missing any required field", () => {
  for (const key of REQUIRED) { const value = look(); delete value[key]; rejects(value, key); rejects(look({ [key]: undefined }), key); }
  rejects({ pronoun: "witch" });
});

test("lookInput treats faceGear, facialHair, facialHairColor, hood and wandStyle as optional", () => {
  const value = look(); for (const key of ["faceGear", "facialHair", "facialHairColor", "hood", "wandStyle"]) delete value[key];
  assert.deepEqual(lookInput(value, owner), expected(value));
});

test("lookInput only accepts hair or #rrggbb as facialHairColor", () => {
  for (const ok of ["hair", "#1c1410", "#ABCDEF"]) assert.equal(lookInput(look({ facialHairColor: ok }), owner).facialHairColor, ok);
  for (const bad of ["#1c141", "#1c14100", "red", "Hair", "1c1410", "#gggggg", "", "#1c1410 ", 0, null]) rejects(look({ facialHairColor: bad }), String(bad));
});

test("lookInput accepts the real Creator.exportLook() output from findings §3", () => {
  const real = { format: "arcanemp-look", version: 7, gender: "male", pronoun: "wizard", house: "Unaffiliated", hood: false,
    gear: ["GA_Back_014", "GA_Outfit_002"],
    presets: { browColour: "p1", browShape: "p2", eyeColour: "p3", faceShape: "p4", hairColour: "p5", hairStyle: "p6",
      marking0: "m0", marking1: "m1", marking2: "m2", marking3: "m3", skin: "s1" },
    voice: { pitch: 0, tone: 0 } };
  const { house, ...rest } = real;
  assert.deepEqual(lookInput(real, owner), { ...rest, name: { first: "Ana", last: "Silva" }, house: "Ravenclaw" });
});

test("lookInput rejects a key outside the allow-list", () => rejects(look({ hairColor: "red" })));

test("lookInput rejects a __proto__ key at any depth", () => {
  rejects(JSON.parse(JSON.stringify(look()).replace(/^\{/, '{"__proto__":{"admin":true},')));
  rejects(look({ presets: JSON.parse('{"__proto__":"x"}') }));
  rejects(look({ constructor: "x" }));
  assert.equal({}.admin, undefined);
});

test("lookInput rejects non-finite numbers, including inside stripped fields", () => {
  rejects(look({ version: Number.NaN }));
  rejects(look({ version: Infinity }));
  rejects(look({ scale: Infinity }));
  rejects(look({ voice: { tone: Number.NaN, pitch: 1 } }));
});

test("lookInput keeps a valid voice and rejects out-of-range or malformed ones", () => {
  assert.deepEqual(lookInput(look({ voice: { tone: 1, pitch: -3 } }), owner).voice, { tone: 1, pitch: -3 });
  assert.deepEqual(lookInput(look({ voice: { tone: 0, pitch: 10 } }), owner).voice, { tone: 0, pitch: 10 });
  for (const voice of [{ tone: 2, pitch: 0 }, { tone: -1, pitch: 0 }, { tone: 0.5, pitch: 0 }, { tone: 0, pitch: 11 }, { tone: 0, pitch: -11 },
    { tone: 0, pitch: 100 }, { tone: 0 }, { pitch: 0 }, { tone: 0, pitch: 0, pad: "x" }, [], "voice", null]) rejects(look({ voice }));
});

test("lookInput enforces the 16 KB serialized limit", () => {
  // Allowed fields are capped well below 16 KB, so pad through a stripped field: the size guard runs on the raw input.
  const padded = bytes => {
    const value = look({ scale: { pad: "" } });
    value.scale.pad = "x".repeat(bytes - Buffer.byteLength(JSON.stringify(value)));
    assert.equal(Buffer.byteLength(JSON.stringify(value)), bytes);
    return value;
  };
  assert.deepEqual(lookInput(padded(16 * 1024), owner), expected());
  rejects(padded(16 * 1024 + 1));
});

test("lookInput rejects a gender outside male/female", () => {
  rejects(look({ gender: "other" }));
  rejects(look({ gender: 0 }));
});

test("lookInput rejects a missing or invalid pronoun", () => {
  const { pronoun, ...withoutPronoun } = look();
  assert.equal(pronoun, "wizard");
  rejects(withoutPronoun);
  rejects(look({ pronoun: undefined }));
  rejects(look({ pronoun: "they" }));
  rejects(look({ pronoun: null }));
});

test("lookInput limits presets to 64 entries", () => {
  const presets = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`slot${i}`, `value${i}`]));
  assert.equal(Object.keys(lookInput(look({ presets: presets(64) }), owner).presets).length, 64);
  rejects(look({ presets: presets(65) }));
});

test("lookInput rejects preset keys and values outside the ID pattern", () => {
  rejects(look({ presets: { Face: "face 01" } }));
  rejects(look({ presets: { Face: "<script>" } }));
  rejects(look({ presets: { "bad key": "face_01" } }));
  rejects(look({ presets: { Face: "" } }));
  rejects(look({ presets: { Face: "x".repeat(129) } }));
  rejects(look({ presets: { Face: 1 } }));
  rejects(look({ presets: ["face_01"] }));
  assert.equal(lookInput(look({ presets: { Face: "x".repeat(128) } }), owner).presets.Face.length, 128);
});

test("lookInput validates types and limits of the remaining fields", () => {
  rejects(look({ format: "x".repeat(33) }));
  rejects(look({ format: 1 }));
  rejects(look({ version: 1.5 }));
  rejects(look({ version: -1 }));
  rejects(look({ version: 1001 }));
  rejects(look({ version: "1" }));
  rejects(look({ gear: Array.from({ length: 33 }, (_, i) => `g${i}`) }));
  rejects(look({ gear: ["ok", "not ok"] }));
  rejects(look({ gear: "robe" }));
  rejects(look({ faceGear: "a b" }));
  rejects(look({ facialHair: "x".repeat(129) }));
  rejects(look({ wandStyle: "" }));
  rejects(look({ facialHairColor: "x".repeat(129) }));
  rejects(look({ facialHairColor: 1 }));
  rejects(look({ hood: "true" }));
  assert.equal(lookInput(look({ version: 1000, format: "x".repeat(32) }), owner).version, 1000);
  assert.equal(lookInput(look({ gear: Array.from({ length: 32 }, (_, i) => `g${i}`) }), owner).gear.length, 32);
});

test("lookInput rejects anything that is not a plain object", () => {
  for (const value of [null, undefined, "look", 1, true, [], [look()]]) rejects(value);
  rejects({ toJSON: () => ["pronoun"] });
});

test("lookInput strips scale, scaleMode and boneScales", () => {
  const result = lookInput(look({ scale: 1.1, scaleMode: "visual", boneScales: { spine: 1.2 } }), owner);
  for (const key of ["scale", "scaleMode", "boneScales"]) assert.equal(Object.hasOwn(result, key), false, key);
  assert.deepEqual(result, expected());
});

test("lookInput treats an empty faceGear or facialHair (\"Nenhum\") as absent", () => {
  const result = lookInput(look({ faceGear: "", facialHair: "" }), owner);
  for (const key of ["faceGear", "facialHair"]) assert.equal(Object.hasOwn(result, key), false, key);
  const { faceGear, facialHair, ...rest } = look();
  assert.deepEqual(result, expected(rest));
  rejects(look({ presets: { skin: "" } }));
  rejects(look({ wandStyle: "" }));
});

test("lookInput imposes the character's name and house", () => {
  const result = lookInput(look({ name: { first: "X", last: "Y" }, house: "Slytherin" }), owner);
  assert.deepEqual(result.name, { first: "Ana", last: "Silva" });
  assert.equal(result.house, "Ravenclaw");
  // Malformed client values for imposed fields are discarded rather than rejected.
  assert.deepEqual(lookInput(look({ name: "X", house: 7 }), owner), expected());
});

test("lookInput drops facial hair for a female body", () => {
  const result = lookInput(look({ gender: "female", pronoun: "witch" }), owner);
  assert.equal(Object.hasOwn(result, "facialHair"), false);
  assert.equal(Object.hasOwn(result, "facialHairColor"), false);
  assert.equal(result.faceGear, "glasses_round");
  // An invalid facial hair value is still rejected, even for a female body.
  rejects(look({ gender: "female", facialHair: "bad value" }));
});

test("lookInput returns a detached copy validated after serialization", () => {
  const input = look();
  const result = lookInput(input, owner);
  input.presets.Face = "changed";
  input.gear.push("added");
  assert.equal(result.presets.Face, "face_01");
  assert.equal(result.gear.length, 2);
  let reads = 0;
  const flipping = look();
  Object.defineProperty(flipping, "gender", { enumerable: true, get: () => (reads++ === 0 ? "male" : "other") });
  assert.equal(lookInput(flipping, owner).gender, "male");
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});

test("lookInput requires the server-side character fields", () => {
  assert.throws(() => lookInput(look(), { firstName: "Ana", lastName: "Silva" }), TypeError);
});
