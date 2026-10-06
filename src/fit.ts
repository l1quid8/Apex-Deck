// Rows that give up detail step by step until they fit their space: the bot
// badges in the message box, and the pane's top line. Also the message box
// itself, which grows with its text.

/** Apply each step in order and keep the first that fits. When none fits, the last step stays applied. */
export function fitSteps<T extends string>(steps: readonly T[], apply: (step: T) => void, fits: () => boolean): T {
  for (const step of steps) {
    apply(step);
    if (fits()) return step;
  }
  return steps[steps.length - 1];
}

type TextBox = { style: { height: string }; scrollHeight: number; offsetHeight: number; clientHeight: number; clientWidth: number };

/** Grow a text box to fit its text, up to its CSS max-height. A box in a
 *  hidden pane measures zero, so it is left alone until it shows. */
export function fitHeight(box: TextBox): void {
  if (box.clientWidth === 0) return;
  box.style.height = "auto";
  box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
}
