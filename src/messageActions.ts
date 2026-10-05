/** Chevron points toward the actions while closed, toward collapse while open. */
export function actionChevron(speaker: string, expanded: boolean): string {
  return (speaker === "human") !== expanded ? "‹" : "›";
}
