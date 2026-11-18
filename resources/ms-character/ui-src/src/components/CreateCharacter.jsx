import { useEffect, useMemo, useRef, useState } from "react";
import { send } from "../bridge.js";
import { NAME_ERROR, normalizeName, validName } from "../characterName.js";
import { FEMALE_HIDDEN, buildTabs, groupConfig } from "../creatorCategories.js";
import { useCreatorSession } from "../useCreatorSession.js";
import ChoiceGroup from "./ChoiceGroup.jsx";
import Cta from "./Cta.jsx";
import CreatorTabs, { panelId, tabId } from "./CreatorTabs.jsx";
import DeleteDialog from "./DeleteDialog.jsx";
import FinaliseForm from "./FinaliseForm.jsx";
import Group from "./Group.jsx";
import OptionGrid from "./OptionGrid.jsx";
import Screen from "./Screen.jsx";
import Skeleton from "./Skeleton.jsx";
import StepSlider from "./StepSlider.jsx";
import { PITCH_OPTIONS, TONE_OPTIONS } from "../voice.js";

const FIRST_TEXT = "Ainda não tens personagens. Cria a primeira para entrares no mundo.";
const BODY_OPTIONS = [{ value: "female", label: "Feminino" }, { value: "male", label: "Masculino" }];
const PRONOUN_OPTIONS = [{ value: "witch", label: "Bruxa" }, { value: "wizard", label: "Feiticeiro" }];
const NAME_FIELDS = ["firstName", "lastName"];
const isTyping = element => element instanceof HTMLElement && (element.matches("input, textarea, select") || element.isContentEditable);

// Creator screen (STORY-05.11 tabs and categories, STORY-05.12 finalise and exit). Plan §4.4 / §5.3.1,
// handoff §4.3, §5, §6, §8; mockup creator.html. The page owns the interaction, the client script owns the game:
//   hasCharacters   false for the first character: no Esc and no "Voltar" (there is no lobby to go back to)
//   busy            create request in flight (CTA loading, controls disabled)
//   notice          server notice object { text } (CHARACTER_LIMIT, INVALID_LOOK, ...): shown in the alert zone
//   onSubmit        ({ firstName, lastName, house }): App sends `create` (the client adds the look)
//   onExit          back to the lobby (after creator:cancel)
//   onFailed        creator:error: the creator could not open
export default function CreateCharacter({ hasCharacters, busy, notice, onSubmit, onExit, onFailed }) {
  const session = useCreatorSession({ onFailed });
  const [activeKey, setActiveKey] = useState("body");
  const [form, setForm] = useState({ firstName: "", lastName: "", house: "Unaffiliated" });
  const [errors, setErrors] = useState({});
  const [formDirty, setFormDirty] = useState(false);
  const [discard, setDiscard] = useState(null);          // null | { status: "idle" | "done" }
  const firstRef = useRef(null), lastRef = useRef(null);
  const slideFrom = useRef("8px");                      // direction of the panel slide
  const focusTab = useRef(null);                        // tab to focus once the panel switched
  const opener = useRef(null), refocus = useRef(false); // where the focus returns when the discard dialog closes
  const framedFor = useRef(null), submitted = useRef(false);

  const tabs = useMemo(() => buildTabs(session.schema?.categories, session.currentBody), [session.schema, session.currentBody]);
  const index = Math.max(0, tabs.findIndex(tab => tab.key === activeKey));
  const active = tabs[index];
  const dirty = session.dirty || formDirty;

  // Camera: face or body framing for the tab that opens (no `shift`, it is the client's).
  useEffect(() => {
    if (framedFor.current === active.key) return;
    framedFor.current = active.key;
    send("camera:frame", { framing: active.framing });
  }, [active.key, active.framing]);

  useEffect(() => {
    document.querySelector(".panel__scroll")?.scrollTo?.(0, 0);
    if (focusTab.current) { document.getElementById(tabId(focusTab.current))?.focus(); focusTab.current = null; }
  }, [active.key]);

  // A server notice while a create was in flight: the client already released its session, so open it again.
  useEffect(() => {
    if (notice && submitted.current) { submitted.current = false; session.rebegin(); }
  }, [notice]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectTab = (key, { focus = false } = {}) => {
    if (busy || discard) return;
    const next = tabs.findIndex(tab => tab.key === key);
    if (next < 0 || key === active.key) { if (focus) document.getElementById(tabId(key))?.focus(); return; }
    session.settle(); // a hovered option must not stay on the character when its tab hides
    slideFrom.current = next >= index ? "8px" : "-8px";
    if (focus) focusTab.current = key;
    setActiveKey(key);
  };
  // Q / E: previous / next tab, no wrap. The focus follows only if it would be lost (on a tab or inside the panel that hides).
  const step = direction => {
    const target = tabs[index + direction];
    if (!target) return;
    const here = document.activeElement;
    const focus = Boolean(here && (here.getAttribute("role") === "tab" || document.getElementById(panelId(active.key))?.contains(here)));
    selectTab(target.key, { focus });
  };

  const exit = () => { send("creator:cancel"); onExit(); };
  const requestLeave = () => {
    if (busy || discard || !hasCharacters) return;
    session.settle();
    if (!dirty) { exit(); return; }
    opener.current = document.activeElement;
    setDiscard({ status: "idle" });
  };
  const discardConfirmed = () => { send("creator:cancel"); setDiscard({ status: "done" }); };
  const discardClosed = () => {
    if (discard?.status === "done") { onExit(); return; }
    refocus.current = true;
    setDiscard(null);
  };
  useEffect(() => {
    if (discard || !refocus.current) return;
    refocus.current = false;
    const element = opener.current?.isConnected ? opener.current : document.getElementById(tabId(active.key));
    element?.focus();
  }, [discard]); // eslint-disable-line react-hooks/exhaustive-deps

  // Global keys. Q/E never while typing (they are letters of a name); Esc in a field only blurs it. The discard
  // dialog handles its own Esc in the capture phase, so only Q/E need the guard here.
  const onKey = useRef(null);
  onKey.current = event => {
    if (event.defaultPrevented || discard) return;
    if (event.key === "Escape") {
      if (isTyping(event.target)) { event.preventDefault(); event.target.blur(); return; }
      if (hasCharacters && !busy) { event.preventDefault(); requestLeave(); }
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
    const key = event.key.toLowerCase();
    if (key === "q" || key === "e") { event.preventDefault(); step(key === "q" ? -1 : 1); }
  };
  useEffect(() => {
    const handler = event => onKey.current(event);
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // ---- Finalise form ----
  const validate = (name, value) => setErrors(current => {
    const { [name]: removed, ...rest } = current; // eslint-disable-line no-unused-vars
    return validName(value) ? rest : { ...rest, [name]: NAME_ERROR };
  });
  const onField = (name, value) => {
    setFormDirty(true);
    setForm(current => ({ ...current, [name]: value }));
    if (name !== "house" && errors[name]) validate(name, value); // once an error is shown, every key re-validates
  };
  const submit = () => {
    if (busy || discard) return;
    const invalid = NAME_FIELDS.filter(name => !validName(form[name]));
    setErrors(Object.fromEntries(invalid.map(name => [name, NAME_ERROR])));
    if (invalid.length) { (invalid[0] === "firstName" ? firstRef : lastRef).current?.focus(); return; }
    session.settle(); // exportLook must see the confirmed look, never a hovered option
    submitted.current = true;
    onSubmit({ firstName: normalizeName(form.firstName), lastName: normalizeName(form.lastName), house: form.house });
  };

  // ---- Tab contents ----
  const loading = Boolean(session.bodyPending);
  const renderGroup = (id, options = session.schema.categories[id]) => {
    const config = groupConfig(id);
    const titleId = `creator-g-${id}`;
    const common = { labelledBy: titleId, disabled: busy, loading, value: session.values[id],
      onPreview: option => session.preview(id, option), onCommit: option => session.commit(id, option) };
    return (
      <Group key={id} id={titleId} title={config.title}>
        {config.control === "slider"
          ? <StepSlider options={options} label={config.title} {...common} />
          : <OptionGrid options={options} none={config.none} {...common} />}
      </Group>
    );
  };
  const waiting = (
    <div className="option-grid" aria-busy="true" aria-label="A carregar as opções">
      {Array.from({ length: 12 }, (_, item) => <Skeleton key={item} style={{ aspectRatio: "1" }} />)}
    </div>
  );
  const content = tab => {
    if (tab.key === "finalise") {
      return <FinaliseForm form={form} errors={errors} busy={busy} firstRef={firstRef} lastRef={lastRef}
        onChange={onField} onBlur={name => { if (form[name] !== "") validate(name, form[name]); }}
        onEnter={name => (name === "firstName" ? lastRef.current?.focus() : submit())} />;
    }
    if (!session.ready) return waiting;
    if (tab.key === "body") {
      return (
        <>
          <Group id="creator-g-body" title="Tipo de corpo" help={FEMALE_HIDDEN} helpId="creator-g-body-help">
            <ChoiceGroup options={BODY_OPTIONS} value={session.body} labelledBy="creator-g-body" describedBy="creator-g-body-help"
              disabled={busy} onChange={session.switchBody} />
          </Group>
          <Group id="creator-g-pronoun" title="Pronome">
            <ChoiceGroup options={PRONOUN_OPTIONS} value={session.pronoun} labelledBy="creator-g-pronoun" disabled={busy}
              onChange={session.choosePronoun} />
          </Group>
          <Group id="creator-g-voice" title="Voz">
            <div className="voice-controls">
            <ChoiceGroup options={TONE_OPTIONS} value={String(session.voice.tone)} labelledBy="creator-g-voice" disabled={busy}
              onChange={value => session.setVoice({ tone: Number(value) })} />
            <StepSlider options={PITCH_OPTIONS} value={String(session.voice.pitch)} label="Altura da voz" disabled={busy}
              onCommit={value => session.setVoice({ pitch: Number(value) })} />
            </div>
          </Group>
          {session.schema.categories.preset && renderGroup("preset")}
        </>
      );
    }
    return tab.groups.length
      ? tab.groups.map(id => renderGroup(id))
      : <p className="group-help">Sem opções disponíveis para este corpo.</p>;
  };

  const hints = [
    { keys: ["Q", "E"], label: "Mudar de separador" },
    { keys: ["Enter"], label: "Selecionar" },
    ...(hasCharacters ? [{ keys: ["Esc"], label: "Voltar", onClick: requestLeave }] : []),
  ];
  return (
    <>
      <Screen titleId="creator-title" eyebrow={`Criar personagem · ${index + 1} de ${tabs.length}`} title={active.label}
        subtitle={hasCharacters ? null : FIRST_TEXT} busy={busy} enter inert={Boolean(discard)} notice={notice?.text} hints={hints}
        afterHeader={<CreatorTabs tabs={tabs} activeKey={active.key} disabled={busy} onSelect={selectTab} onStep={step} />}
        stage={active.key === "finalise" ? <Cta loading={busy} onClick={submit}>Começar a jornada</Cta> : null}>
        {tabs.map(tab => (
          <section key={tab.key} role="tabpanel" className="tab-panel" id={panelId(tab.key)} aria-labelledby={tabId(tab.key)}
            aria-busy={tab.key !== "finalise" && (!session.ready || loading) ? true : undefined}
            hidden={tab.key !== active.key} style={tab.key === active.key ? { "--panel-from": slideFrom.current } : undefined}>
            {content(tab)}
          </section>
        ))}
      </Screen>
      {discard && (
        <DeleteDialog title="Descartar personagem" cancelLabel="Continuar a editar" confirmLabel="Descartar" busyLabel="A sair"
          done={discard.status === "done"} onConfirm={discardConfirmed} onClosed={discardClosed}>
          Sair do criador? As alterações que fizeste perdem-se.
        </DeleteDialog>
      )}
    </>
  );
}
