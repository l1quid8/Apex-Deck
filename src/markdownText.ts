// Reading the markdown bots write in their replies.
//
// This is a small reader for the subset models actually use in chat:
// paragraphs, headings, lists, quotes, code blocks, tables, rules, and
// inline bold, italic, strikethrough and code. It is not a full markdown
// implementation and does not try to be. Anything it does not recognise is
// kept as plain text, so a reply is never lost or mangled, only shown less
// prettily. The component that draws the result is in Markdown.tsx. (The two files
// need names that differ by more than capital letters: macOS treats
// markdown.ts and Markdown.tsx as the same module.)

export type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; language: string; text: string }
  | { kind: "list"; ordered: boolean; items: ListItem[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" };

export interface ListItem {
  /** How deeply the item is nested, starting at 0. */
  depth: number;
  /** The number an ordered item was written with. */
  number?: number;
  text: string;
}

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  // A bar written as \| belongs to the cell and does not divide it.
  const BAR = "\u0000";
  return inner
    .replace(/\\\|/g, BAR)
    .split("|")
    .map((cell) => cell.trim().split(BAR).join("|"));
}

/** Split a reply into blocks. */
export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      const body: string[] = [];
      i++;
      // A reply still being written may not have closed its code block yet;
      // everything after the opening line is then code.
      const closing = new RegExp(`^\\s{0,3}\\${marker[0]}{${marker.length},}\\s*$`);
      while (i < lines.length && !closing.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ kind: "code", language: fence[2], text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flush();
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const header = cells(line);
      if (header.length === cells(lines[i + 1]).length) {
        flush();
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
          const row = cells(lines[i]);
          // Short rows are padded and long ones cut so the columns line up.
          rows.push(header.map((_, column) => row[column] ?? ""));
          i++;
        }
        blocks.push({ kind: "table", header, rows });
        continue;
      }
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      flush();
      const ordered = NUMBERED.test(line);
      const items: ListItem[] = [];
      const indents: number[] = [];
      while (i < lines.length) {
        const current = lines[i];
        const bullet = BULLET.exec(current);
        const numbered = NUMBERED.exec(current);
        const match = bullet ?? numbered;
        if (match) {
          const indent = match[1].replace(/\t/g, "    ").length;
          // An item is nested under the nearest earlier item that starts
          // further left.
          while (indents.length > 0 && indent <= indents[indents.length - 1] - 2) indents.pop();
          if (indents.length === 0 || indent >= indents[indents.length - 1] + 2) indents.push(indent);
          items.push({ depth: indents.length - 1, number: numbered && !bullet ? Number(numbered[2]) : undefined, text: match[3] });
          i++;
        } else if (current.trim() !== "" && /^\s+/.test(current) && items.length > 0) {
          // An indented line continues the item above it.
          items[items.length - 1].text += `\n${current.trim()}`;
          i++;
        } else if (current.trim() === "" && i + 1 < lines.length && (BULLET.test(lines[i + 1]) || NUMBERED.test(lines[i + 1]))) {
          // A blank line between items does not end the list.
          i++;
        } else {
          break;
        }
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flush();
      const body: string[] = [];
      while (i < lines.length) {
        const next = QUOTE.exec(lines[i]);
        if (!next) break;
        body.push(next[1]);
        i++;
      }
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }

    paragraph.push(line);
    i++;
  }
  flush();
  return blocks;
}

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; children: Inline[] }
  | { kind: "italic"; children: Inline[] }
  | { kind: "strike"; children: Inline[] };

// What can start a piece of inline formatting. Links come first so that
// underscores and stars inside a path or address are left alone; they are
// passed through as text for the link renderer to handle.
const INLINE =
  /(`+)(?!`)([\s\S]*?[^`])\1(?!`)|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>()\]]+|\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)|__(?=\S)([\s\S]*?\S)__|~~(?=\S)([\s\S]*?\S)~~|\*(?=[^\s*])([^*\n]*?[^\s*])\*|_(?=[^\s_])([^_\n]*?[^\s_])_/g;

const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

/** Split a line of text into plain runs and formatted spans. */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  const text = (value: string) => {
    if (!value) return;
    const last = out[out.length - 1];
    if (last && last.kind === "text") last.text += value;
    else out.push({ kind: "text", text: value });
  };

  let from = 0;
  // Its own copy, because spans nest and each level keeps its own place.
  const pattern = new RegExp(INLINE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    const start = match.index;
    const whole = match[0];
    const end = start + whole.length;
    const single = match[6] ?? match[7];
    const double = match[4];
    // A star or underscore inside a word (snake_case, 2*3*4) is not
    // emphasis. Skip the marker and keep looking after it.
    const marker = whole[0];
    const insideWord =
      (single !== undefined && (marker === "_" ? isWordChar(source[start - 1]) || isWordChar(source[end]) : source[start - 1] === "*" || source[end] === "*")) ||
      (double !== undefined && (isWordChar(source[start - 1]) || isWordChar(source[end])));
    if (insideWord) {
      pattern.lastIndex = start + 1;
      continue;
    }
    text(source.slice(from, start));
    if (match[1] !== undefined) {
      // Code that needs a backtick at its edge is written with a space of
      // padding on each side, which is not part of the code.
      const code = match[2];
      const padded = code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "";
      out.push({ kind: "code", text: padded ? code.slice(1, -1) : code });
    } else if (match[3] !== undefined) {
      out.push({ kind: "bold", children: parseInline(match[3]) });
    } else if (double !== undefined) {
      out.push({ kind: "bold", children: parseInline(double) });
    } else if (match[5] !== undefined) {
      out.push({ kind: "strike", children: parseInline(match[5]) });
    } else if (single !== undefined) {
      out.push({ kind: "italic", children: parseInline(single) });
    } else {
      // A link or web address: left as written for the link renderer.
      text(whole);
    }
    from = end;
  }
  text(source.slice(from));
  return out;
}
