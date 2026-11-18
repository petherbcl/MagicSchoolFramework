import { useCallback, useEffect, useRef, useState } from "react";
import { send } from "./bridge.js";
import { bodyOf, firstBodyPreset, toValues } from "./creatorCategories.js";
import { voiceOf } from "./voice.js";

// Creator session of the page (STORY-05.11), the page side of plan §4.4: creator:begin on mount, then
// creator:schema / creator:state / creator:error from the client, and creator:patch / body / pronoun / cancel back.
//
// The page owns the CONFIRMED selection (`values`): the client sends creator:state after every applied patch,
// previews included, so a state cannot tell a hovered option from a chosen one. Only a state without `change`
// (the client's answer to a commit) is adopted, and only once every commit has been answered and no preview is
// outstanding. A new creator:schema (begin, body switch) replaces the selection wholesale.
export const PREVIEW_DEBOUNCE_MS = 80;
const BODY_TIMEOUT_MS = 2000; // a body switch without a new schema must not leave the grids loading forever

const EMPTY = { schema: null, values: {}, pronoun: "wizard", bodyPending: null, gender: null, voice: { tone: 0, pitch: 0 } };
const genderOf = state => (state?.gender === 1 ? "female" : state?.gender === 0 ? "male" : null); // CreatorState.gender: 0 male, 1 female
const asPronoun = value => (value === "witch" || value === "wizard" ? value : null);

export function useCreatorSession({ onFailed }) {
  const [model, setModel] = useState(EMPTY);
  const [dirty, setDirty] = useState(false);
  const modelRef = useRef(model);
  const failedRef = useRef(onFailed);
  failedRef.current = onFailed;
  const begun = useRef(false);
  const timer = useRef(null);          // 80 ms preview debounce
  const pending = useRef(null);        // queued preview { category, id }
  const applied = useRef(null);        // last preview sent and not yet reverted { category, id }
  const bodyTimer = useRef(null);
  const awaiting = useRef(0);          // commits sent whose creator:state has not arrived yet
  const chosenPronoun = useRef(null);  // the player's pronoun choice (the client forgets it on a new begin)
  const resendPronoun = useRef(false);

  const update = useCallback(change => {
    modelRef.current = { ...modelRef.current, ...(typeof change === "function" ? change(modelRef.current) : change) };
    setModel(modelRef.current);
  }, []);
  const confirmed = category => modelRef.current.values[category];
  const sendPatch = (category, id, commit) => {
    if (commit) awaiting.current += 1;
    send("creator:patch", { category, id, commit });
  };
  const clearQueued = () => { clearTimeout(timer.current); timer.current = null; pending.current = null; };

  // Puts the 3D back on the confirmed value of a category whose preview is still applied. It goes as a commit
  // (applied at once, and it drops anything the client still has queued) so it also works right before a create.
  const revert = except => {
    const shown = applied.current;
    if (!shown || shown.category === except) return;
    applied.current = null;
    const value = confirmed(shown.category);
    if (value !== undefined && shown.id !== value) sendPatch(shown.category, value, true);
  };
  // Leaves no preview behind: tab change, body switch, create, committing another category.
  const settle = useCallback(() => { clearQueued(); revert(null); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const preview = useCallback((category, id) => {
    revert(category); // the pointer moved from another group: the old preview would stay on the character
    pending.current = { category, id };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const next = pending.current;
      clearQueued();
      if (!next) return;
      sendPatch(next.category, next.id, false);
      applied.current = next.id === confirmed(next.category) ? null : next;
    }, PREVIEW_DEBOUNCE_MS);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = useCallback((category, id) => {
    clearQueued();
    revert(category);
    applied.current = null;
    update(model => ({ values: { ...model.values, [category]: id } })); // optimistic: the grid must not flash the old value
    setDirty(true);
    sendPatch(category, id, true);
  }, [update]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchBody = useCallback(target => {
    const { schema, bodyPending } = modelRef.current;
    const preset = firstBodyPreset(schema?.categories.preset, target);
    if (!preset || bodyPending) return;
    settle();
    setDirty(true);
    // Optimistic: the first preset of the target body is marked at once; the new schema replaces the selection.
    update(model => ({ bodyPending: { target }, values: { ...model.values, preset } }));
    clearTimeout(bodyTimer.current);
    bodyTimer.current = setTimeout(() => update({ bodyPending: null }), BODY_TIMEOUT_MS);
    send("creator:body", { preset });
  }, [settle, update]);

  // Voice is not part of the schema: the page owns it and the client applies it after 80 ms.
  // Every change plays the voice, so the player hears what they picked.
  const setVoice = useCallback(change => {
    const voice = { ...modelRef.current.voice, ...change };
    setDirty(true);
    update({ voice });
    send("creator:voice", voice);
    send("creator:voice:preview");
  }, [update]);

  const choosePronoun = useCallback(pronoun => {
    const value = asPronoun(pronoun);
    if (!value) return;
    chosenPronoun.current = value;
    setDirty(true);
    update({ pronoun: value });
    send("creator:pronoun", { pronoun: value });
  }, [update]);

  // Reopens the client session after a failed create (the client releases it on create), without leaving the screen.
  const rebegin = useCallback(() => {
    settle();
    awaiting.current = 0;
    resendPronoun.current = chosenPronoun.current !== null;
    send("creator:begin");
  }, [settle]);

  useEffect(() => {
    const onSchema = event => {
      const detail = event.detail;
      if (!detail || !Array.isArray(detail.categories)) return;
      const categories = {};
      for (const item of detail.categories) {
        if (item && typeof item.id === "string" && Array.isArray(item.options)) categories[item.id] = item.options.filter(option => typeof option === "string");
      }
      clearTimeout(bodyTimer.current);
      clearQueued();
      applied.current = null;
      awaiting.current = 0;
      if (resendPronoun.current && chosenPronoun.current) send("creator:pronoun", { pronoun: chosenPronoun.current });
      resendPronoun.current = false;
      update(model => {
        const values = toValues(detail.state);
        // The look the game starts with may carry no `preset`: keep the one the player just chose while it still exists.
        if (values.preset === undefined && model.values.preset !== undefined && categories.preset?.includes(model.values.preset)) values.preset = model.values.preset;
        return { values, gender: genderOf(detail.state), voice: voiceOf(detail.state) };
      });
      update({
        schema: { categories, capabilities: detail.capabilities || null },
        pronoun: chosenPronoun.current ?? asPronoun(detail.state?.pronoun) ?? "wizard",
        bodyPending: null,
      });
    };
    const onState = event => {
      const state = event.detail;
      if (!state || typeof state !== "object" || state.change !== undefined) return; // creatorChanged echoes (previews) are not selections
      awaiting.current = Math.max(0, awaiting.current - 1);
      if (awaiting.current > 0 || timer.current || applied.current || modelRef.current.bodyPending || !modelRef.current.schema) return;
      update(model => ({ values: { ...model.values, ...toValues(state) } }));
    };
    const onError = () => { send("creator:cancel"); failedRef.current?.(); };
    window.addEventListener("creator:schema", onSchema);
    window.addEventListener("creator:state", onState);
    window.addEventListener("creator:error", onError);
    if (!begun.current) { begun.current = true; send("creator:begin"); } // once, also under StrictMode's double effect
    return () => {
      window.removeEventListener("creator:schema", onSchema);
      window.removeEventListener("creator:state", onState);
      window.removeEventListener("creator:error", onError);
      clearQueued();
      clearTimeout(bodyTimer.current);
    };
  }, [update]);

  const current = bodyOf(model.values.preset) ?? model.gender;
  const body = model.bodyPending?.target ?? current;
  return { ...model, ready: model.schema !== null, body, currentBody: current, dirty, preview, commit, settle, switchBody, choosePronoun, setVoice, rebegin };
}
