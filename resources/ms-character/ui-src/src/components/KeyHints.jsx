// Key hint bar. `hints`: [{ keys: ["Q", "E"], label: "Mudar de separador", onClick? }]. A hint with `onClick`
// is a real button with a 44x44 hit area (e.g. "Esc Voltar"); the others are plain text.
export default function KeyHints({ hints, label = "Atalhos de teclado", className = "" }) {
  return (
    <footer className={`hintbar ${className}`.trim()} aria-label={label}>
      {hints.map(({ keys, label: text, onClick }) => {
        const caps = keys.map(key => <kbd key={key}>{key}</kbd>);
        return onClick
          ? <button key={text} type="button" className="hint hint--button" onClick={onClick}>{caps} {text}</button>
          : <span key={text} className="hint">{caps} {text}</span>;
      })}
    </footer>
  );
}
