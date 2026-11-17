// Must match HOUSES in server/validation.js (the server re-validates every value).
export const HOUSES = [
  { value: "Unaffiliated", label: "Sem casa atribuída" },
  { value: "Gryffindor", label: "Gryffindor" },
  { value: "Hufflepuff", label: "Hufflepuff" },
  { value: "Ravenclaw", label: "Ravenclaw" },
  { value: "Slytherin", label: "Slytherin" },
];
export const houseLabel = value => HOUSES.find(house => house.value === value)?.label || value;
