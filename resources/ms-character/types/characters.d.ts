/** ms-character 0.2.0 server-only API (Exports.get("ms-character", "Characters")). IDs are decimal strings. */
export type PublicId = string;
export type House = "Unaffiliated" | "Gryffindor" | "Hufflepuff" | "Ravenclaw" | "Slytherin";
export type LobbyStatus = "loading" | "lobby" | "creating" | "deleting" | "applying" | "playing" | "closed";
export interface CharacterSummary { characterId: PublicId; firstName: string; lastName: string; house: House; }
/** Lobby payload sent only to the account owner in ms-character:state. `look` is null for characters created before the creator existed. */
export interface LobbyCharacter extends CharacterSummary { lastPlayedAt: string | null; look: Record<string, unknown> | null; }
/** S->C ms-character:state (JSON string). */
export interface LobbyState { status: LobbyStatus; characters: LobbyCharacter[]; maxCharacters: number; characterId: PublicId | null; }
/** Client payload of ms-character:create. `look` is required and is sanitised server-side (name and house are imposed). */
export interface CreateCharacterInput { firstName: string; lastName: string; house: House; look: Record<string, unknown>; }
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
