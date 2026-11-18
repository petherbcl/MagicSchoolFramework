import IconBody from "./IconBody.jsx";
import IconBrows from "./IconBrows.jsx";
import IconEyes from "./IconEyes.jsx";
import IconFace from "./IconFace.jsx";
import IconFacewear from "./IconFacewear.jsx";
import IconFacialHair from "./IconFacialHair.jsx";
import IconFinalise from "./IconFinalise.jsx";
import IconGeneric from "./IconGeneric.jsx";
import IconHair from "./IconHair.jsx";
import IconHairColour from "./IconHairColour.jsx";
import IconMarks from "./IconMarks.jsx";
import IconSkin from "./IconSkin.jsx";

// Category icon per design asset name (docs/design/assets/icon-<key>.svg). The runtime category
// IDs are mapped onto these keys by the creator's category table (STORY-01.01 / STORY-05.11).
export const categoryIcons = Object.freeze({
  "body": IconBody,
  "face": IconFace,
  "skin": IconSkin,
  "hair": IconHair,
  "hair-colour": IconHairColour,
  "brows": IconBrows,
  "eyes": IconEyes,
  "marks": IconMarks,
  "facewear": IconFacewear,
  "facial-hair": IconFacialHair,
  "finalise": IconFinalise,
});

// Unknown or runtime-only categories fall back to the generic icon.
export const categoryIcon = key => (Object.hasOwn(categoryIcons, key) ? categoryIcons[key] : IconGeneric);
