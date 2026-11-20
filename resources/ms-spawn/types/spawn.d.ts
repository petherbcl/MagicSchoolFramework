// Types of the `Spawn` export of ms-spawn: Exports.get("ms-spawn", "Spawn"). Resolve it lazily on every use.
export interface SpawnLocationSummary {
  /** Slug of the configured name ("Sala Comum Slytherin" -> "sala-comum-slytherin"). Never "last". */
  readonly id: string;
  readonly name: string;
}
export interface Spawn {
  /** "0.3.2" (0.3.1 plus CHG-03: preview teleport without snapToGround by default, optional timing log, `timingLog` in ms-spawn:open; 0.3.0 behaviour plus the client abandon signal): every select also teleports and holds the invisible player at the chosen point (hold owner "ms-spawn:preview"); CHG-02 adds the client cover, the hidden local body and camera.departure. */
  readonly version: string;
  /** True while ms-spawn is started with a valid configuration. */
  isReady(): boolean;
  /** True while a selection for this exact session is still waiting for the player. */
  holds(playerId: number, sessionId: string): boolean;
  /** Configured locations without coordinates. Frozen. */
  locations(): ReadonlyArray<SpawnLocationSummary>;
}
export interface SpawnPosition { x: number; y: number; z: number; yaw: number }
// Server events (ms-character <-> ms-spawn).
export interface SpawnSelectionRequested { playerId: number; sessionId: string; userId: string; characterId: string; last: SpawnPosition | null }
export interface SpawnSelected { playerId: number; sessionId: string; destination: SpawnPosition }
export interface SpawnCancelled { playerId: number; sessionId: string; reason: "NOT_READY" | "NO_OPTIONS" | "INTERNAL_ERROR" | "STOPPED" | "CLIENT_TIMEOUT" | "CLIENT_ABORTED" }
