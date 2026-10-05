/** A slash command typed in the composer. Commands never reach the models. */
export type Command =
  | { name: "clear" }
  | { name: "compact" }
  | { name: "fork"; title: string }
  | { name: "export"; format: "markdown" | "json" }
  | { name: "diff" }
  | { name: "image"; provider: string; prompt: string }
  | { name: "unknown"; typed: string };

/** Who `/image` can ask; each needs its own API key. */
export const IMAGE_PROVIDERS = ["chatgpt", "openai", "grok", "xai", "venice"];

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
    case "fork":
      return { command: { name: "fork", title: arg } };
    case "export":
      if (arg === "") return { command: { name: "export", format: "markdown" } };
      if (arg.toLowerCase() === "json") return { command: { name: "export", format: "json" } };
      return { command: { name: "unknown", typed: body } };
    case "image": {
      // An optional provider first, "grok" or "venice:model"; ChatGPT otherwise.
      const first = arg.split(/\s/)[0];
      const named = IMAGE_PROVIDERS.includes(first.split(":")[0].toLowerCase());
      const prompt = (named ? arg.slice(first.length) : arg).trim();
      if (!prompt) return { command: { name: "unknown", typed: body } };
      return { command: { name: "image", provider: named ? first.toLowerCase() : "chatgpt", prompt } };
    }
    default:
      return { command: { name: "unknown", typed: `/${match[1]}` } };
  }
}

/** The text to post for a message that may have been escaped with `//`. */
export function postable(message: string): string {
  return message.startsWith("//") ? message.slice(1) : message;
}

/** Parse an edited queued turn with the same rules as the composer. */
export function parseQueueEdit(body: string): Parsed {
  const parsed = parseComposer(body.trim());
  return "text" in parsed ? { text: postable(parsed.text) } : parsed;
}
