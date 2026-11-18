import { houseCrest, houseLabel } from "../houses.js";
import Button from "./Button.jsx";
import IconPlus from "./icons/IconPlus.jsx";
import IconTrash from "./icons/IconTrash.jsx";

const dateFormat = new Intl.DateTimeFormat("pt-PT", { dateStyle: "long", timeStyle: "short" });

// "16 de novembro de 2026 às 21:40"; null when the character was never played (or the value is not a date).
function sessionDate(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : { iso, label: dateFormat.format(date) };
}

// Most recently played first, never played last. Same order as the server (the sort is stable).
export function sortByRecent(characters) {
  const time = character => { const value = Date.parse(character.lastPlayedAt); return Number.isNaN(value) ? -Infinity : value; };
  return [...characters].sort((a, b) => time(b) - time(a));
}

// Lobby cards. Tab order: Jogar → Apagar of each card, then "Criar nova personagem".
//   busyId        character being entered: its card shows the loading state, the others are dimmed and inert
//   disabled      a request is in flight (every control disabled)
//   canCreate     renders the "Criar nova personagem" slot (only while there are free slots)
//   deleteRefs    ref holding a Map(characterId → "Apagar" button), so App can return focus there
//   onPreview     focus or selection of a card (lobby:preview); onDelete also runs on the Del key
export default function CharacterList({ characters, maxCharacters, busyId, disabled, canCreate, deleteRefs, onSelect, onPreview, onDelete, onCreate }) {
  const free = maxCharacters - characters.length;
  return (
    <ul className="char-list" aria-label="As tuas personagens">
      {characters.map((character, index) => {
        const { characterId, firstName, lastName, house, lastPlayedAt } = character;
        const name = `${firstName} ${lastName}`;
        const Crest = houseCrest(house);
        const session = sessionDate(lastPlayedAt);
        const entering = busyId === characterId;
        const dimmed = busyId !== null && !entering;
        return (
          <li key={characterId} className={`char-card${entering ? " is-loading" : ""}${dimmed ? " is-disabled" : ""}`}
            onFocus={() => onPreview(characterId)}
            onKeyDown={event => { if (event.key === "Delete" && !disabled) { event.preventDefault(); onDelete(character); } }}>
            <span className="char-card__crest" aria-hidden="true"><Crest /></span>
            <div>
              <h2 className="char-card__name">{name}</h2>
              <p className="char-card__meta">
                <span>{houseLabel(house)}</span>
                {index === 0 && characters.length > 1 && lastPlayedAt && <span className="badge">Última jogada</span>}
              </p>
              {session && <p className="char-card__date">Última sessão: <time dateTime={session.iso}>{session.label}</time></p>}
            </div>
            <div className="char-card__actions">
              <Button variant="primary" aria-label={`Jogar com ${name}`} loading={entering} busyLabel="A entrar" disabled={disabled}
                onClick={() => { onPreview(characterId); onSelect(characterId); }}>
                Jogar
              </Button>
              <Button variant="quiet-danger" icon={<IconTrash />} aria-label={`Apagar ${name}`} disabled={disabled}
                ref={element => { if (element) deleteRefs.current.set(characterId, element); else deleteRefs.current.delete(characterId); }}
                onClick={() => onDelete(character)}>
                Apagar
              </Button>
            </div>
          </li>
        );
      })}
      {canCreate && (
        <li>
          <button type="button" className="slot-new" disabled={disabled} onClick={onCreate}>
            <IconPlus />
            <span>Criar nova personagem<small>{free === 1 ? "1 vaga livre" : `${free} vagas livres`}</small></span>
          </button>
        </li>
      )}
    </ul>
  );
}
