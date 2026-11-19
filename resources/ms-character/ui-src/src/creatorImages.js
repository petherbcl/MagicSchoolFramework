// Thumbnails of the creator options, keyed by the runtime option ID (UI_Refs/criacao, resized to WebP).
// `assets/creator/<optionId>.webp` exists for presets (Body…), face shapes, hair styles, brow shapes and the
// markings that the game ships an icon for; every other option keeps its number tile.
const files = import.meta.glob("./assets/creator/*.webp", { eager: true, query: "?url", import: "default" });
const byId = new Map(Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -".webp".length), url]));
// Each body has its own hair thumbnails (HairMaleNNN / HairFemaleNNN). HairFemale052 has no thumbnail yet, so it
// falls back to HairMale052 (the number tile would also do).
export const optionImage = id => (typeof id === "string" ? byId.get(id) ?? byId.get(id.replace(/^HairFemale/, "HairMale")) : undefined);
// Portrait thumbnails: the premade bodies.
export const isTall = id => typeof id === "string" && id.startsWith("Body");
