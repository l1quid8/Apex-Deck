import { useLayoutEffect } from "react";

import { applyAppearance, type AppearanceValues } from "./themes";

/** Keep this window painted with the given appearance, re-applying whenever
 *  it changes. The main Deck window and every pop-out use this one hook, so
 *  a skin looks the same in all of them. */
export function useAppearance(values: AppearanceValues): void {
  useLayoutEffect(() => applyAppearance(document.documentElement, values), [values]);
}
