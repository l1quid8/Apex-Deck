/** Chevron points toward the actions while closed, toward collapse while open. */
export function actionChevron(speaker: string, expanded: boolean): string {
  return (speaker === "human") !== expanded ? "‹" : "›";
}

const DAY = 24 * 60 * 60 * 1000;

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** "Saturday 3:11 AM" within the last week, "October 3rd, 2026 @ 3:11 AM" before that. Local time. */
export function messageTime(at: number, now: number = Date.now()): string {
  const when = new Date(at);
  const hour = when.getHours() % 12 || 12;
  const time = `${hour}:${String(when.getMinutes()).padStart(2, "0")} ${when.getHours() < 12 ? "AM" : "PM"}`;
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  // Calendar days, so a weekday never means both today and seven days ago.
  const days = Math.round((midnight(new Date(now)) - midnight(when)) / DAY);
  if (days < 7) return `${when.toLocaleDateString("en-US", { weekday: "long" })} ${time}`;
  const month = when.toLocaleDateString("en-US", { month: "long" });
  return `${month} ${ordinal(when.getDate())}, ${when.getFullYear()} @ ${time}`;
}
