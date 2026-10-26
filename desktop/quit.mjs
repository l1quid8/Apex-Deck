// Asking before quitting, the same way apex-host/src/quit.rs does.
// The window's close button, ⌘W, ⌘Q and Quit in the menu come here first: the
// window gets `quit-requested` with a number and answers at once with
// `quitHeard`, then asks the person or calls `quitApp`. A window that hasn't
// answered within ANSWER_TIME (still loading, or stuck) doesn't keep the app open.

export const ANSWER_TIME = 2000;

export class QuitGate {
  constructor({ letThrough, timers = globalThis, answerTime = ANSWER_TIME }) {
    this.letThrough = letThrough;
    this.timers = timers;
    this.answerTime = answerTime;
    this.confirmed = false;
    this.asked = 0;
    this.answered = 0;
  }

  /** A close or quit arrived: the number to send the window, or null to let it through. */
  request() {
    if (this.confirmed) return null;
    const request = ++this.asked;
    this.timers.setTimeout(() => {
      if (!this.confirmed && this.answered < request) {
        this.confirm();
        this.letThrough();
      }
    }, this.answerTime);
    return request;
  }

  /** The window got request `request` and is asking the person. */
  heard(request) {
    this.answered = Math.max(this.answered, request);
  }

  /** Quitting is decided; nothing holds it from now on. */
  confirm() {
    this.confirmed = true;
  }
}

/**
 * Why quitting, or "Restart to update", asked from window `asking` must wait,
 * or null. Deck exits without the file editor's unload warning; the asking
 * window has asked about its own edits, so only another open window's stop it.
 */
export function editsElsewhere(edits, asking, isOpen) {
  for (const [id, file] of edits) if (id !== asking && isOpen(id)) return `${file} has unsaved changes in another Deck window. Save or discard them there first.`;
  return null;
}
