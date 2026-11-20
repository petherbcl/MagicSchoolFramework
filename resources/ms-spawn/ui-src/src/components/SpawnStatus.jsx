import Spinner from "./Spinner.jsx";

// Persistent role="status" line (handoff §3.5): rendered from the first render, empty, so screen readers announce
// the text injected later. Its min-height is reserved, so changing the text never shifts the layout.
export default function SpawnStatus({ busy = false, children }) {
  return (
    <p className="spawn-status" role="status">
      {busy && <Spinner aria-hidden="true" />}
      {children}
    </p>
  );
}
