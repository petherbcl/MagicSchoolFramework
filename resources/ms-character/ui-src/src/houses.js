import CrestGryffindor from "./components/crests/CrestGryffindor.jsx";
import CrestHufflepuff from "./components/crests/CrestHufflepuff.jsx";
import CrestNone from "./components/crests/CrestNone.jsx";
import CrestRavenclaw from "./components/crests/CrestRavenclaw.jsx";
import CrestSlytherin from "./components/crests/CrestSlytherin.jsx";

// Must match HOUSES in server/validation.js (the server re-validates every value).
export const HOUSES = [
  { value: "Unaffiliated", label: "Sem casa atribuída", Crest: CrestNone },
  { value: "Gryffindor", label: "Gryffindor", Crest: CrestGryffindor },
  { value: "Hufflepuff", label: "Hufflepuff", Crest: CrestHufflepuff },
  { value: "Ravenclaw", label: "Ravenclaw", Crest: CrestRavenclaw },
  { value: "Slytherin", label: "Slytherin", Crest: CrestSlytherin },
];
export const houseLabel = value => HOUSES.find(house => house.value === value)?.label || value;
// Unknown values (never sent by the server) fall back to the neutral crest.
export const houseCrest = value => HOUSES.find(house => house.value === value)?.Crest || CrestNone;
