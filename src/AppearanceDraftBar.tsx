// The one reminder that Appearance work is waiting. It sits under the title bar
// everywhere except the Appearance page, which already shows all of this.

import { deckLabel, editedKeys } from "./appearanceDraft";
import type { AppSettings } from "./settings";
import { settleFocus, type AppearanceStudioState } from "./useAppearanceDraft";

export const draftCountText = (count: number) => `${count} unapplied appearance change${count === 1 ? "" : "s"}`;

export function AppearanceDraftBar({ studio, settings, systemDark, onResume }: { studio: AppearanceStudioState; settings: AppSettings; systemDark: boolean; onResume: () => void }) {
  const { pending, draft } = studio;
  const unsaved = editedKeys(draft, settings.appearance?.saved ?? []).length > 0;
  return <section className="appearance-draft-bar" aria-label="Unapplied appearance changes">
    <div className="appearance-draft-copy">
      <strong>{draftCountText(pending.length)}</strong>
      <p>{pending.map((row) => row.label).join(", ")}. Deck stays on {deckLabel(settings, systemDark)} until you apply.{unsaved ? " Includes edits not saved as a preset." : ""}</p>
    </div>
    <div className="appearance-draft-actions">
      <button type="button" className="primary" aria-label="Resume editing appearance" onClick={onResume}>Resume</button>
      <button type="button" aria-label="Apply appearance draft to Deck" onClick={() => { studio.apply(); settleFocus(); }}>Apply</button>
      <button type="button" aria-label="Discard appearance draft" onClick={() => { studio.discard(); settleFocus(); }}>Discard</button>
    </div>
  </section>;
}
