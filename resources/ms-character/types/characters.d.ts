/** ms-character 0.1.0 server-only API (Exports.get("ms-character", "Characters")). IDs are decimal strings. */
export type PublicId = string;
export type House = "Unaffiliated" | "Gryffindor" | "Hufflepuff" | "Ravenclaw" | "Slytherin";
export type LobbyStatus = "loading" | "lobby" | "creating" | "applying" | "playing" | "closed";
export interface CharacterSummary { characterId: PublicId; firstName: string; lastName: string; house: House; }
export interface Character extends CharacterSummary {
  userId: PublicId;
  state: { inventory: unknown[]; look: unknown | null; location: { areaId: string; x: number; y: number; z: number; yaw: number } | null };
  version: number;
}
/** Server events: ms:characterLobby (lobby opened) and ms:characterReady (character restored, player released). */
export interface CharacterReady { playerId: number; sessionId: PublicId; userId: PublicId; characterId: PublicId; }
export interface CharacterLobby { playerId: number; sessionId: PublicId; userId: PublicId; characters: number; }
export interface Characters {
  readonly version: string;
  isPlaying(playerId: number): boolean;
  /** Copy of the selected character while playing, otherwise null. */
  getSelected(playerId: number): Character | null;
  list(playerId: number): Promise<CharacterSummary[]>;
  save(playerId: number): Promise<boolean>;
}
