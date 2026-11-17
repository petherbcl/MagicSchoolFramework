import { houseLabel } from "../houses.js";

// The server lists the most recently played character first.
export default function CharacterList({ characters, disabled, onSelect }) {
  return (
    <ul className="mt-4">
      {characters.map((character, index) => (
        <li key={character.characterId} className="flex items-center justify-between gap-4 border-t border-slate-600 py-3">
          <p>
            {character.firstName} {character.lastName}
            <small className="block font-sans text-sm text-mist">
              {houseLabel(character.house)}{index === 0 && characters.length > 1 ? " · última jogada" : ""}
            </small>
          </p>
          <button type="button" disabled={disabled} onClick={() => onSelect(character.characterId)}
            className="bg-gold px-5 py-3 font-sans text-sm text-night hover:brightness-110 focus:outline-2 focus:outline-offset-2 focus:outline-gold disabled:cursor-wait disabled:opacity-50">
            Jogar
          </button>
        </li>
      ))}
    </ul>
  );
}
