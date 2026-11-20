import IconSpinner from "./icons/IconSpinner.jsx";

// Decorative spinner (rotated by CSS, 0.9 s). Always pair it with visible text such as "A entrar".
export default function Spinner({ className = "", ...props }) {
  return <IconSpinner className={`spinner ${className}`.trim()} {...props} />;
}
