import { useEffect, useLayoutEffect, useState } from "react";

import { applyAppearance, effectiveLightFromMode, type AppearanceSettings, type AppearanceValues, type ColorMode } from "./themes.ts";

function systemIsDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Effective appearance values derived from colorMode without rewriting saved skin. */
export function effectiveAppearanceValues(settings: AppearanceSettings, systemDark: boolean): AppearanceValues {
  const fallbackLight = settings.current.appearance.light;
  const effectiveLight = effectiveLightFromMode(settings.colorMode, systemDark, fallbackLight);
  if (effectiveLight === settings.current.appearance.light) return settings.current.appearance;
  return { ...settings.current.appearance, light: effectiveLight };
}

/** Keep this window painted with the given appearance, re-applying whenever
 *  it changes or OS scheme changes (when System). The main Deck window and
 *  every pop-out use this one hook, so a skin looks the same in all of them. */
export function useAppearance(appearance: AppearanceValues | AppearanceSettings): void {
  const isSettingsObject = (v: AppearanceValues | AppearanceSettings): v is AppearanceSettings =>
    !!(v as AppearanceSettings).current && typeof (v as AppearanceSettings).current === 'object';

  const [sysDark, setSysDark] = useState<boolean>(() => systemIsDark());

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    // Only listen when colorMode is system (or when passed settings has system)
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent | MediaQueryList) => setSysDark((e as any).matches ?? mq.matches);
    // Modern browsers
    if (mq.addEventListener) mq.addEventListener('change', onChange as any);
    else (mq as any).addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange as any);
      else (mq as any).removeListener(onChange);
    };
  }, []);

  const resolvedValues: AppearanceValues = (() => {
    if (!isSettingsObject(appearance)) return appearance as AppearanceValues;
    return effectiveAppearanceValues(appearance as AppearanceSettings, sysDark);
  })();

  useLayoutEffect(() => {
    const cleanup = applyAppearance(document.documentElement, resolvedValues);
    return cleanup;
  }, [resolvedValues]);

  // Also keep dataset for true-black enforcement and other hooks that read effective mode
  useLayoutEffect(() => {
    const mode = (isSettingsObject(appearance) ? (appearance as AppearanceSettings).colorMode : undefined) as ColorMode | undefined;
    document.documentElement.dataset.deckColorMode = mode ?? 'system';
    document.documentElement.dataset.deckSystemDark = String(sysDark);
  }, [appearance, sysDark]);
}

/** Hook to get current system dark flag reactively. */
export function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => systemIsDark());
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent | MediaQueryList) => setDark((e as any).matches ?? mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', handler as any);
    else (mq as any).addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler as any);
      else (mq as any).removeListener(handler);
    };
  }, []);
  return dark;
}

/** Utility for non-hook contexts to resolve effective light. */
export function resolveEffectiveLight(settings: AppearanceSettings, systemDark: boolean): boolean {
  return effectiveLightFromMode(settings.colorMode, systemDark, settings.current.appearance.light);
}
