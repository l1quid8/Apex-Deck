/** A slash command typed in the composer. Commands never reach the models. */
export type Command =
  | { name: "clear" }
  | { name: "compact" }
  | { name: "pin"; fact: string }
  | { name: "fork"; title: string }
  | { name: "export"; format: "markdown" | "json" }
  | { name: "diff" }
  | { name: "unknown"; typed: string };

/** Composer text is either a command to run or a message to send. */
export type Parsed = { command: Command } | { text: string };

/** Decide what `body` (already trimmed) is. A command is `/word` at the very
 *  start, followed by whitespace or nothing, so paths like `/Users/me` stay
 *  messages. Text that starts with `//` is a message; `postable` drops one slash. */
export function parseComposer(body: string): Parsed {
  if (body.startsWith("//")) return { text: body };
  const match = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(body);
  if (!match) return { text: body };
  const name = match[1].toLowerCase();
  const arg = (match[2] ?? "").trim();
  switch (name) {
    case "clear":
    case "compact":
    case "diff":
      return arg ? { command: { name: "unknown", typed: body } } : { command: { name } as Command };
    case "pin":
      return { command: { name: "pin", fact: arg } };
    case "fork":
      return { command: { name: "fork", title: arg } };
    case "export":
      if (arg === "") return { command: { name: "export", format: "markdown" } };
      if (arg.toLowerCase() === "json") return { command: { name: "export", format: "json" } };
      return { command: { name: "unknown", typed: body } };
    default:
      return { command: { name: "unknown", typed: `/${match[1]}` } };
  }
}

/** The text to post for a message that may have been escaped with `//`. */
export function postable(message: string): string {
  return message.startsWith("//") ? message.slice(1) : message;
}
