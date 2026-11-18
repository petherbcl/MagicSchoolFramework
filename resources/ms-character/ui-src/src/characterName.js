// Name validation of the finalise form. Mirrors characterInput in server/validation.js (the server stays the
// authority): trimmed, NFC-normalised, 2 to 32 characters, a letter first, then letters, marks, ' space or -.
export const NAME_ERROR = "Usa nomes com 2 a 32 letras.";
const NAME_PATTERN = /^[\p{L}][\p{L}\p{M}' -]*$/u;

export const normalizeName = value => String(value).trim().normalize("NFC");

export function validName(value) {
  const name = normalizeName(value);
  return name.length >= 2 && name.length <= 32 && NAME_PATTERN.test(name);
}
