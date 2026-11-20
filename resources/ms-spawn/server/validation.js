"use strict";

// Stable error codes: TELEPORT_FAILED (internal, notice only), INVALID_LOCATION, INVALID_STATE, NOT_ARRIVED, LOCATION_REJECTED, RATE_LIMITED, SESSION_EXPIRED.
class SpawnError extends Error {
  constructor(code, message = code) { super(message); this.name = "SpawnError"; this.code = code; }
}
function check(condition, code) { if (!condition) throw new SpawnError(code); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

// Location ids are slugs (or the reserved "last"): lowercase letters, digits and hyphens, short.
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;
// The only field read from a client payload. Everything else (coordinates included) is ignored.
function locationId(payload) {
  check(payload !== null && typeof payload === "object" && typeof payload.id === "string" && ID_PATTERN.test(payload.id), "INVALID_LOCATION");
  return payload.id;
}
// Position of the character's last location, as handed over by ms-character: finite numbers within sane bounds.
const POSITION_BOUND = 1e8;
function position(value) {
  if (value === null || typeof value !== "object") return null;
  const { x, y, z } = value, yaw = value.yaw === undefined ? 0 : value.yaw;
  const finite = [x, y, z, yaw].every(item => typeof item === "number" && Number.isFinite(item) && Math.abs(item) <= POSITION_BOUND);
  return finite ? { x, y, z, yaw } : null;
}

module.exports = { SpawnError, check, clone, locationId, position, ID_PATTERN };
