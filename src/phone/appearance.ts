import { applyAppearance, defaultAppearanceSettings, readAppearance, type AppearanceSettings, type AppearanceValues } from '../themes.ts';

export const PHONE_APPEARANCE_KEY = 'apex-deck.phone.appearance.v1';

export function loadPhoneAppearance(storage: Pick<Storage, 'getItem'>): AppearanceSettings {
  try { return readAppearance(JSON.parse(storage.getItem(PHONE_APPEARANCE_KEY) ?? 'null')); }
  catch { return defaultAppearanceSettings(); }
}

/** A failed save leaves the current preview usable, and lets the UI explain it. */
export function savePhoneAppearance(storage: Pick<Storage, 'setItem'>, value: AppearanceSettings): boolean {
  try { storage.setItem(PHONE_APPEARANCE_KEY, JSON.stringify(value)); return true; }
  catch { return false; }
}

/** Same palette as the Mac, with cleanup when returning to Classic. */
export function applyPhoneTheme(root: Pick<HTMLElement, 'dataset' | 'style'>, values: AppearanceValues): () => void {
  return applyAppearance(root, values);
}

export interface PhoneTransparency {
  getTransparency(): Promise<{ reduced: boolean }>;
  addListener(name: 'transparencyChanged', listener: (value: { reduced: boolean }) => void): Promise<{ remove(): Promise<void> }>;
}

/** WKWebView does not expose the iOS transparency preference through CSS. */
export function watchPhoneTransparency(native: PhoneTransparency, update: (reduced: boolean) => void): () => void {
  let live = true;
  let revision = 0;
  let listener: { remove(): Promise<void> } | undefined;
  void native.addListener('transparencyChanged', value => {
    revision++;
    if (live) update(value.reduced);
  }).then(async handle => {
    if (!live) { await handle.remove(); return; }
    listener = handle;
    const before = revision;
    const initial = await native.getTransparency();
    if (live && before === revision) update(initial.reduced);
  }).catch(() => { /* The editor's Flat surfaces switch remains available. */ });
  return () => { live = false; void listener?.remove().catch(() => {}); };
}
