// Rows that give up detail step by step until they fit their space: the bot
// badges in the message box, and the pane's top line.

/** Apply each step in order and keep the first that fits. When none fits, the last step stays applied. */
export function fitSteps<T extends string>(steps: readonly T[], apply: (step: T) => void, fits: () => boolean): T {
  for (const step of steps) {
    apply(step);
    if (fits()) return step;
  }
  return steps[steps.length - 1];
}
