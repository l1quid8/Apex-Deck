// Model names typed before, per preset, so the bot form offers them again.
// Kept in browser storage; Settings › General can clear them.

const MODELS_KEY = "apex-deck.models.v1";

export function rememberedModels(): Record<string, string[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODELS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function rememberModel(preset: string, model: string) {
  if (!model) return;
  try {
    const all = rememberedModels();
    const list = all[preset] ?? [];
    if (!list.includes(model)) {
      all[preset] = [model, ...list].slice(0, 12);
      localStorage.setItem(MODELS_KEY, JSON.stringify(all));
    }
  } catch {
    // Storage can be unavailable; the name is then simply not remembered.
  }
}

export function forgetModels() {
  try {
    localStorage.removeItem(MODELS_KEY);
  } catch {
    // Nothing to clear.
  }
}
