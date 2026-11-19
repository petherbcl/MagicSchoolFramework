"use strict";

// Free-fly noclip. The server makes the player invisible and non-collidable for everyone; this script repeats
// that locally (own model), removes gravity and walking input, then moves the player along the camera direction.
// Keys: W/A/S/D move, Space up, Ctrl down, Shift fast.
const TICK_MS = 16;
const SPEED = 600;       // units per second
const FAST_FACTOR = 4;
let timer = null, last = 0;

function down(...keys) { return keys.some(key => Key.isDown(key)); }

function step() {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const position = LocalPlayer.getPosition(), look = LocalPlayer.getControlRotation();
  if (!position || !look) return;
  const yaw = look.yaw * Math.PI / 180, pitch = look.pitch * Math.PI / 180;
  const forward = (down("w") ? 1 : 0) - (down("s") ? 1 : 0);
  const right = (down("d") ? 1 : 0) - (down("a") ? 1 : 0);
  const up = (down("space") ? 1 : 0) - (down("ctrl", "lctrl") ? 1 : 0);
  if (!forward && !right && !up) { LocalPlayer.clearVelocity(); return; }
  const distance = SPEED * (down("shift", "lshift") ? FAST_FACTOR : 1) * dt;
  const dx = Math.cos(pitch) * Math.cos(yaw) * forward - Math.sin(yaw) * right;
  const dy = Math.cos(pitch) * Math.sin(yaw) * forward + Math.cos(yaw) * right;
  const dz = Math.sin(pitch) * forward + up;
  LocalPlayer.setPosition(position.x + dx * distance, position.y + dy * distance, position.z + dz * distance);
  LocalPlayer.clearVelocity();
}

function start() {
  if (timer !== null) return;
  LocalPlayer.suspendGravity();
  LocalPlayer.setCollision(false);
  LocalPlayer.setVisibility(false);
  LocalPlayer.stopPlayerInput();
  last = Date.now();
  timer = setInterval(step, TICK_MS);
}

function stop() {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
  LocalPlayer.restorePlayerInput();
  LocalPlayer.setCollision(true);
  LocalPlayer.setVisibility(true);
  LocalPlayer.restoreGravity();
  LocalPlayer.clearVelocity();
  LocalPlayer.resetFall();
}

Events.on("ms-admin:noclip", payload => {
  const data = typeof payload === "string" ? JSON.parse(payload) : payload;
  if (data && data.enabled === true) start(); else stop();
});
Events.on("resourceStop", name => { if (name === "ms-admin") stop(); });
