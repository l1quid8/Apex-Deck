// A line diff for the artifacts panel's Changes tab: what one version
// changed from the one before it.

export type DiffLine = { sign: " " | "+" | "-"; text: string };
export type DiffRow = DiffLine | { skipped: number };

/** Above this many cells, comparing line by line would take too long and too much memory. */
const CELL_LIMIT = 4_000_000;

/** Removals come before additions where lines changed. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: DiffLine[] = a.slice(0, start).map((text) => ({ sign: " ", text }));
  const n = endA - start;
  const m = endB - start;
  if (n * m > CELL_LIMIT) {
    for (let i = start; i < endA; i++) out.push({ sign: "-", text: a[i] });
    for (let j = start; j < endB; j++) out.push({ sign: "+", text: b[j] });
  } else {
    // table[i][j]: the longest common run of lines from a[start+i] and b[start+j] on.
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        out.push({ sign: " ", text: a[start + i] });
        i++;
        j++;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        out.push({ sign: "-", text: a[start + i++] });
      } else {
        out.push({ sign: "+", text: b[start + j++] });
      }
    }
    while (i < n) out.push({ sign: "-", text: a[start + i++] });
    while (j < m) out.push({ sign: "+", text: b[start + j++] });
  }
  for (let k = endA; k < a.length; k++) out.push({ sign: " ", text: a[k] });
  return out;
}

export function diffCounts(lines: DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.sign === "+").length, removed: lines.filter((l) => l.sign === "-").length };
}

/** Keep `context` unchanged lines on each side of a change; fold the rest into counts. */
export function compact(lines: DiffLine[], context = 3): DiffRow[] {
  const changed = lines.map((line) => line.sign !== " ");
  const rows: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((line, i) => {
    let near = false;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context) && !near; k++) near = changed[k];
    if (near) {
      if (skipped) rows.push({ skipped });
      skipped = 0;
      rows.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped) rows.push({ skipped });
  return rows;
}
