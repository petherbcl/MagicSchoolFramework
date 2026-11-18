import { createElement } from "react";
import unaffiliated from "./assets/houses/unaffiliated.webp";
import gryffindor from "./assets/houses/gryffindor.webp";
import hufflepuff from "./assets/houses/hufflepuff.webp";
import ravenclaw from "./assets/houses/ravenclaw.webp";
import slytherin from "./assets/houses/slytherin.webp";

// House crests from UI_Refs/houses (128 px WebP). Decorative: the house name is always visible text.
const imageCrest = src => function Crest(props) { return createElement("img", { src, alt: "", width: 64, height: 64, draggable: "false", "aria-hidden": "true", ...props }); };

// Must match HOUSES in server/validation.js (the server re-validates every value).
const NEUTRAL_CREST = imageCrest(unaffiliated);
export const HOUSES = [
  { value: "Unaffiliated", label: "Sem casa atribuída", Crest: NEUTRAL_CREST },
  { value: "Gryffindor", label: "Gryffindor", Crest: imageCrest(gryffindor) },
  { value: "Hufflepuff", label: "Hufflepuff", Crest: imageCrest(hufflepuff) },
  { value: "Ravenclaw", label: "Ravenclaw", Crest: imageCrest(ravenclaw) },
  { value: "Slytherin", label: "Slytherin", Crest: imageCrest(slytherin) },
];
export const houseLabel = value => HOUSES.find(house => house.value === value)?.label || value;
// Unknown values (never sent by the server) fall back to the neutral crest.
export const houseCrest = value => HOUSES.find(house => house.value === value)?.Crest || NEUTRAL_CREST;
