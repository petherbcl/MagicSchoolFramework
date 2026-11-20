import SpawnScreen from "./components/SpawnScreen.jsx";
import WorldVignette from "./components/WorldVignette.jsx";

// The vignette sits outside the screen (fixed, decorative, never catches the pointer) so it is not recreated on
// state changes. The right side of the page stays empty: it is the live world the camera flies over.
export default function App() {
  return (
    <>
      <WorldVignette variant="spawn" />
      <SpawnScreen />
    </>
  );
}
