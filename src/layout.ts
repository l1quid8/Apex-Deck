// Legacy split-tree data is read only to migrate saved sessions.
// Live pane placement is computed by paneArrangement.ts.

export type LayoutNode = { kind: "leaf"; id: string } | { kind: "split"; dir: "row" | "column"; children: LayoutNode[]; sizes: number[] };

const leaf = (id: string): LayoutNode => ({ kind: "leaf", id });

/** The panes in a layout, in reading order. */
export function leafIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  return node.kind === "leaf" ? [node.id] : node.children.flatMap(leafIds);
}

/**
 * Tidy a tree after a change: drop empty splits, replace a split of one by
 * its child, fold a split into a parent that runs the same way, and make
 * each split's shares add up to one.
 */
export function normalize(node: LayoutNode | null): LayoutNode | null {
  if (!node || node.kind === "leaf") return node;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const tidy = normalize(child);
    if (!tidy) return;
    const share = Number.isFinite(node.sizes[i]) && node.sizes[i] > 0 ? node.sizes[i] : 1 / node.children.length;
    if (tidy.kind === "split" && tidy.dir === node.dir) {
      tidy.children.forEach((grandchild, j) => {
        children.push(grandchild);
        sizes.push(share * tidy.sizes[j]);
      });
    } else {
      children.push(tidy);
      sizes.push(share);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0);
  return { kind: "split", dir: node.dir, children, sizes: sizes.map((s) => s / total) };
}

/** Check a layout read from disk. Anything malformed gives `null`, and the
 *  caller builds a fresh layout instead. */
export function validate(value: unknown, depth = 0): LayoutNode | null {
  if (!value || typeof value !== "object" || depth > 12) return null;
  const node = value as Record<string, unknown>;
  if (node.kind === "leaf") return typeof node.id === "string" && node.id ? leaf(node.id) : null;
  if (node.kind !== "split" || (node.dir !== "row" && node.dir !== "column")) return null;
  if (!Array.isArray(node.children) || !Array.isArray(node.sizes) || node.children.length !== node.sizes.length) return null;
  const children = node.children.map((child) => validate(child, depth + 1));
  if (children.some((child) => child === null)) return null;
  if (!node.sizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0)) return null;
  const tidy = normalize({ kind: "split", dir: node.dir, children: children as LayoutNode[], sizes: node.sizes as number[] });
  // The same pane twice would draw one pane in two places.
  const ids = leafIds(tidy);
  return new Set(ids).size === ids.length ? tidy : null;
}
