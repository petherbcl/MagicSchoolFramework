import { useEffect, useState } from "react";
import { send, useLobby } from "./bridge.js";
import Panel from "./components/Panel.jsx";
import CharacterList from "./components/CharacterList.jsx";
import CreateCharacter from "./components/CreateCharacter.jsx";

export default function App() {
  const { state, notice } = useLobby();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const characters = state?.characters || [];
  const count = characters.length;

  // Any server answer (new state or notice) unlocks the buttons; a longer list means creation succeeded.
  useEffect(() => { setBusy(false); }, [state, notice]);
  useEffect(() => { setCreating(false); }, [count]);

  if (!state || state.status === "loading") return <Panel title="A carregar as tuas personagens" subtitle="Aguarda um momento…" />;
  if (state.status === "applying") return <Panel title="A entrar em Hogwarts" subtitle="A carregar a personagem. Aguarda um momento…" />;

  const canCreate = count < state.maxCharacters;
  // Without characters the lobby goes straight to the creation form.
  if (canCreate && (creating || count === 0)) {
    return (
      <Panel title="Cria a tua personagem" subtitle={count ? "" : "Ainda não tens personagens."} notice={notice?.text}>
        <CreateCharacter busy={busy} onCancel={count ? () => setCreating(false) : null}
          onSubmit={input => { setBusy(true); send("create", input); }} />
      </Panel>
    );
  }
  return (
    <Panel title="Escolhe a tua personagem" subtitle={`${count} de ${state.maxCharacters} personagens.`} notice={notice?.text}>
      <CharacterList characters={characters} disabled={busy || state.status !== "lobby"}
        onSelect={characterId => { setBusy(true); send("select", { characterId }); }} />
      {canCreate && (
        <button type="button" onClick={() => setCreating(true)}
          className="mt-4 border border-brass px-4 py-3 font-sans text-sm text-gold hover:bg-brass/20 focus:outline-2 focus:outline-offset-2 focus:outline-gold">
          Criar nova personagem
        </button>
      )}
    </Panel>
  );
}
