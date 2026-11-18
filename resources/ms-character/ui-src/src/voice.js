// Voice controls of the creator (findings §8). The game takes integers: tone is clamped to 0..1 (two timbres) and pitch
// is not clamped, so the range is ours. Must match VOICE_PITCH_MAX in server/validation.js and client/main.js.
export const VOICE_PITCH_MAX = 10;
// Measured in game: tone 1 is the feminine voice and tone 0 the masculine one, so "Voz 1" (feminina) comes first.
export const TONE_OPTIONS = [{ value: "1", label: "Voz · Feminina" }, { value: "0", label: "Voz · Masculina" }];
// StepSlider works with option ids (strings): "-10" … "10".
export const PITCH_OPTIONS = Array.from({ length: VOICE_PITCH_MAX * 2 + 1 }, (_, index) => String(index - VOICE_PITCH_MAX));
const clampInt = (value, min, max) => (Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : 0);
export const voiceOf = state => ({
  tone: clampInt(state?.voice?.tone, 0, 1),
  pitch: clampInt(state?.voice?.pitch, -VOICE_PITCH_MAX, VOICE_PITCH_MAX),
});
