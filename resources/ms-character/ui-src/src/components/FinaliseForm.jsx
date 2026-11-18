import { HOUSES } from "../houses.js";
import ChoiceGroup from "./ChoiceGroup.jsx";
import Group from "./Group.jsx";
import TextField from "./TextField.jsx";

const HOUSE_LABEL_ID = "creator-g-house";

// "Finalizar" tab (STORY-05.12): name, surname and house. Presentational: the creator owns the values, the
// validation timing (on blur, then on every key once an error is shown) and the submit.
//   form      { firstName, lastName, house }
//   errors    { firstName?: string, lastName?: string }
//   busy      the create request is in flight (fields readonly)
//   onChange  (field, value);  onBlur (field);  onEnter (field): Enter in Nome moves on, in Apelido submits
export default function FinaliseForm({ form, errors, busy, firstRef, lastRef, onChange, onBlur, onEnter }) {
  const field = (name, label, placeholder, ref) => (
    <TextField ref={ref} id={`creator-${name}`} label={label} placeholder={placeholder} help="2 a 32 letras." error={errors[name]}
      value={form[name]} busy={busy} maxLength={32} autoComplete="off" spellCheck={false}
      onChange={event => onChange(name, event.target.value)} onBlur={() => onBlur(name)}
      onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); onEnter(name); } }} />
  );
  return (
    <form id="creator-form" noValidate onSubmit={event => event.preventDefault()}>
      <Group id="creator-g-name" title="Nome da personagem">
        <div className="field-row">
          {field("firstName", "Nome", "Ex.: Ana", firstRef)}
          {field("lastName", "Apelido", "Ex.: Silva", lastRef)}
        </div>
      </Group>
      <Group id={HOUSE_LABEL_ID} title="Casa">
        <ChoiceGroup variant="crests" labelledBy={HOUSE_LABEL_ID} options={HOUSES} value={form.house} disabled={busy}
          onChange={house => onChange("house", house)} />
      </Group>
    </form>
  );
}
