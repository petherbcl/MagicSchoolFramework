import SpawnItem from "./SpawnItem.jsx";

// `ul` of toggle buttons (handoff §3.3: no radiogroup, the screen is mouse-only; each item is a Tab stop).
// The "Última localização" entry (kind "last") comes first, with a separator, only when there are other locations;
// the rest keep the order received. Nothing is rendered for it when there is no `last` entry.
export const LIST_LABEL = "Locais de entrada";

export default function SpawnList({ locations, selectedId, flyingId, locked, onSelect }) {
  const ordered = [...locations.filter(item => item.kind === "last").slice(0, 1), ...locations.filter(item => item.kind !== "last")];
  return (
    <ul className="spawn-list" aria-label={LIST_LABEL}>
      {ordered.flatMap(item => {
        const row = (
          <li key={item.id}>
            <SpawnItem name={item.name} kind={item.kind} icon={item.icon} selected={selectedId === item.id} flying={flyingId === item.id}
              disabled={locked} onSelect={() => onSelect(item.id)} />
          </li>
        );
        return item.kind === "last" && ordered.length > 1 ? [row, <li key={`${item.id}-sep`} className="spawn-sep" role="separator" />] : [row];
      })}
    </ul>
  );
}
