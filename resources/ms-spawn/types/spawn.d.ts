// Types of the `Spawn` export of ms-spawn: Exports.get("ms-spawn", "Spawn"). Resolve it lazily on every use.
export interface SpawnLocationSummary {
  /** Slug of the configured name ("Sala Comum Slytherin" -> "sala-comum-slytherin"). Never "last". */
  readonly id: string;
  readonly name: string;
}
export interface Spawn {
  /** "0.5.2" (0.5.1 plus CHG-07: client-only, the local player has no world collision and no gravity while choosing, restored in order on every exit and, on a confirm, at the end of the confirm flow; no contract change; 0.5.1 = 0.5.0 plus CHG-06: `camera` may aim with `yaw` (+ optional `pitch`) instead of `lookAt`; 0.5.0 = 0.4.0 plus CHG-05: mandatory `camera` per configured location (the preview teleport and hold go to the camera position, the confirm destination stays the spawn point), optional `icon` file name in ms-spawn:open, migration tool; 0.4.0 = 0.3.2 plus CHG-04: optional `role` per configured location, offered only to characters that have it; 0.3.2 = 0.3.1 plus CHG-03: preview teleport without snapToGround by default, optional timing log, `timingLog` in ms-spawn:open; 0.3.0 behaviour plus the client abandon signal): every select also teleports and holds the invisible player at the chosen point (hold owner "ms-spawn:preview"); CHG-02 adds the client cover, the hidden local body and camera.departure. */
  readonly version: string;
  /** True while ms-spawn is started with a valid configuration. */
  isReady(): boolean;
  /** True while a selection for this exact session is still waiting for the player. */
  holds(playerId: number, sessionId: string): boolean;
  /** Every configured location without coordinates or role (CHG-04: includes role-restricted ones; it is not the list offered to a player). Frozen. */
  locations(): ReadonlyArray<SpawnLocationSummary>;
}
export interface SpawnPosition { x: number; y: number; z: number; yaw: number }
// Server events (ms-character <-> ms-spawn).
export interface SpawnSelectionRequested { playerId: number; sessionId: string; userId: string; characterId: string; last: SpawnPosition | null;
  /** CHG-04 (ms-character 0.6.1): the character's roles, at most 32 of [a-z0-9_-]{1,32}. Missing or malformed = no roles. */
  roles?: string[] }
export interface SpawnSelected { playerId: number; sessionId: string; destination: SpawnPosition }
export interface SpawnCancelled { playerId: number; sessionId: string; reason: "NOT_READY" | "NO_OPTIONS" | "INTERNAL_ERROR" | "STOPPED" | "CLIENT_TIMEOUT" | "CLIENT_ABORTED" }
// Client payload (server to client, JSON string): ms-spawn:open. CHG-05 (0.5.0). The spawn point, the look-at point and the role are never part of it.
export interface SpawnCameraPose { position: { x: number; y: number; z: number }; rotation: { pitch: number; yaw: number; roll: number } }
export interface SpawnOpenLocation {
  id: string; name: string; kind: "last" | "config";
  /** File name of an image in ui-src/public/icons/ (served as icons/<name>). Only for configured locations that set one; never for "last". */
  icon?: string;
  camera: SpawnCameraPose & { departure: SpawnCameraPose };
}
export interface SpawnOpen { locations: SpawnOpenLocation[]; flight: { durationMs: number; easing: string }; areaTimeoutMs: number; timingLog?: boolean }
// One entry of the MS_SPAWN_LOCATIONS configuration (server side only, never sent to a client as is).
export interface SpawnLocationConfig {
  name: string; x: number; y: number; z: number; yaw: number;
  role?: string;
  /** [a-z0-9_-]+.(png|webp|jpg|jpeg|svg), 1-64 characters; "" or null = none. */
  icon?: string | null;
  /**
   * Mandatory since 0.5.0. Position plus ONE aiming (CHG-06, 0.5.1): `lookAt` (a point), or `yaw` (degrees, -360..360) with optional `pitch`
   * (degrees, -89..89, default 0; Unreal convention: yaw 0 looks along +X, positive pitch looks up), or neither (looks at the spawn point).
   * `lookAt` with yaw or pitch, `pitch` without `yaw`, and null / non-numeric / out-of-range values are rejected (LOCATION_CAMERA_INVALID).
   * In the lookAt and default modes the camera may not equal its aim point.
   */
  camera: { x: number; y: number; z: number } & (
    | { lookAt?: { x: number; y: number; z: number }; yaw?: never; pitch?: never }
    | { yaw: number; pitch?: number; lookAt?: never });
}
