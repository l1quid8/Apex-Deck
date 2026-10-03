// How panes are arranged in a workspace.
//
// A layout is a tree. A leaf is one pane. A split holds two or more
// children side by side ("row") or stacked ("column"), each with a share of
// the space. Nesting splits gives any arrangement of rectangles: a big pane
// beside a stack of small ones, an even grid, or whatever dragging produces.
//
// Everything here is plain data and pure functions: each change returns a
// new tree and never touches the screen, so it can be tested without one.
// Positions are fractions of the available area (0 to 1), which the
// interface turns into pixels.

export type Dir = "row" | "column";

export type LayoutNode = { kind: "leaf"; id: string } | { kind: "split"; dir: Dir; children: LayoutNode[]; sizes: number[] };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a pane is dropped on another: against one of its sides, or onto
 *  its middle to trade places with it. */
export type Edge = "left" | "right" | "top" | "bottom" | "center";

/** The smallest share of a split one child may be squeezed to. */
export const MIN_SHARE = 0.1;

const leaf = (id: string): LayoutNode => ({ kind: "leaf", id });

function even(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

function split(dir: Dir, children: LayoutNode[], sizes?: number[]): LayoutNode {
  return { kind: "split", dir, children, sizes: sizes ?? even(children.length) };
}

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

/** Take a pane out. The space it had goes to its neighbours. */
export function removeLeaf(node: LayoutNode | null, id: string): LayoutNode | null {
  const strip = (n: LayoutNode): LayoutNode | null => {
    if (n.kind === "leaf") return n.id === id ? null : n;
    const kept = n.children.map(strip);
    return {
      kind: "split",
      dir: n.dir,
      children: kept.filter((c): c is LayoutNode => c !== null),
      sizes: n.sizes.filter((_, i) => kept[i] !== null),
    };
  };
  return node ? normalize(strip(node)) : null;
}

/** Put a new pane against one side of an existing one, halving its space. */
export function insertBeside(node: LayoutNode, targetId: string, newId: string, edge: Exclude<Edge, "center">): LayoutNode {
  const dir: Dir = edge === "left" || edge === "right" ? "row" : "column";
  const first = edge === "left" || edge === "top";
  const place = (n: LayoutNode): LayoutNode => {
    if (n.kind === "leaf") {
      if (n.id !== targetId) return n;
      return split(dir, first ? [leaf(newId), n] : [n, leaf(newId)]);
    }
    return { ...n, children: n.children.map(place) };
  };
  return normalize(place(node)) ?? leaf(newId);
}

/** Every pane's rectangle, as fractions of the whole area. */
export function rects(node: LayoutNode | null, area: Rect = { x: 0, y: 0, w: 1, h: 1 }): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const walk = (n: LayoutNode, r: Rect) => {
    if (n.kind === "leaf") {
      out.set(n.id, r);
      return;
    }
    let offset = 0;
    n.children.forEach((child, i) => {
      const share = n.sizes[i];
      walk(child, n.dir === "row" ? { x: r.x + offset * r.w, y: r.y, w: share * r.w, h: r.h } : { x: r.x, y: r.y + offset * r.h, w: r.w, h: share * r.h });
      offset += share;
    });
  };
  if (node) walk(node, area);
  return out;
}

/**
 * Add a pane by halving the largest one. It is cut across its longer side,
 * so panes stay close to the shape of the window. `aspect` is the width of
 * the whole area divided by its height.
 */
export function addLeaf(node: LayoutNode | null, newId: string, aspect = 1.6): LayoutNode {
  if (!node) return leaf(newId);
  let target = "";
  let largest = -1;
  let wide = true;
  for (const [id, r] of rects(node)) {
    // Ties go to the later pane, so new panes fill in from the end.
    if (r.w * r.h >= largest - 1e-9) {
      largest = r.w * r.h;
      target = id;
      wide = r.w * aspect >= r.h;
    }
  }
  return insertBeside(node, target, newId, wide ? "right" : "bottom");
}

/** Move a pane next to another, or swap the two when dropped on the middle. */
export function moveLeaf(node: LayoutNode, id: string, targetId: string, edge: Edge): LayoutNode {
  if (id === targetId) return node;
  const ids = leafIds(node);
  if (!ids.includes(id) || !ids.includes(targetId)) return node;
  if (edge === "center") {
    const swap = (n: LayoutNode): LayoutNode => {
      if (n.kind === "leaf") return n.id === id ? leaf(targetId) : n.id === targetId ? leaf(id) : n;
      return { ...n, children: n.children.map(swap) };
    };
    return swap(node);
  }
  const without = removeLeaf(node, id);
  return without ? insertBeside(without, targetId, id, edge) : node;
}

/** Make the layout hold exactly `ids`: panes that are gone are removed and
 *  new ones are added. Panes that stay keep their place and size. */
export function sync(node: LayoutNode | null, ids: string[], aspect = 1.6): LayoutNode | null {
  let tree = node;
  for (const id of leafIds(tree)) {
    if (!ids.includes(id)) tree = removeLeaf(tree, id);
  }
  const have = new Set(leafIds(tree));
  for (const id of ids) {
    if (!have.has(id)) {
      tree = addLeaf(tree, id, aspect);
      have.add(id);
    }
  }
  return tree;
}

/** A line between two neighbours in a split that can be dragged. */
export interface Divider {
  /** Which split it belongs to: the child index to follow at each level. */
  path: number[];
  /** It sits between child `index` and child `index + 1`. */
  index: number;
  dir: Dir;
  /** The rectangle of the split it belongs to. */
  parent: Rect;
  /** Its position across the whole area, along `dir`. */
  at: number;
}

export function dividers(node: LayoutNode | null): Divider[] {
  const out: Divider[] = [];
  const walk = (n: LayoutNode, r: Rect, path: number[]) => {
    if (n.kind === "leaf") return;
    let offset = 0;
    n.children.forEach((child, i) => {
      const share = n.sizes[i];
      const childRect: Rect = n.dir === "row" ? { x: r.x + offset * r.w, y: r.y, w: share * r.w, h: r.h } : { x: r.x, y: r.y + offset * r.h, w: r.w, h: share * r.h };
      offset += share;
      if (i < n.children.length - 1) {
        out.push({ path, index: i, dir: n.dir, parent: r, at: n.dir === "row" ? r.x + offset * r.w : r.y + offset * r.h });
      }
      walk(child, childRect, [...path, i]);
    });
  };
  if (node) walk(node, { x: 0, y: 0, w: 1, h: 1 }, []);
  return out;
}

/**
 * Drag a divider to `position`, a place across the whole area. Only the
 * two panes or groups either side of it change size, and neither can be
 * squeezed below `MIN_SHARE` of the split.
 */
export function resize(node: LayoutNode, divider: Pick<Divider, "path" | "index">, position: number): LayoutNode {
  const walk = (n: LayoutNode, r: Rect, path: number[]): LayoutNode => {
    if (n.kind === "leaf") return n;
    if (path.length > 0) {
      const [next, ...rest] = path;
      let offset = 0;
      return {
        ...n,
        children: n.children.map((child, i) => {
          const share = n.sizes[i];
          const childRect: Rect = n.dir === "row" ? { x: r.x + offset * r.w, y: r.y, w: share * r.w, h: r.h } : { x: r.x, y: r.y + offset * r.h, w: r.w, h: share * r.h };
          offset += share;
          return i === next ? walk(child, childRect, rest) : child;
        }),
      };
    }
    const i = divider.index;
    if (i < 0 || i >= n.children.length - 1) return n;
    const start = n.dir === "row" ? r.x : r.y;
    const extent = n.dir === "row" ? r.w : r.h;
    if (extent <= 0) return n;
    const before = n.sizes.slice(0, i).reduce((a, b) => a + b, 0);
    const pair = n.sizes[i] + n.sizes[i + 1];
    const min = Math.min(MIN_SHARE, pair / 2);
    const wanted = (position - start) / extent - before;
    const first = Math.min(pair - min, Math.max(min, wanted));
    const sizes = [...n.sizes];
    sizes[i] = first;
    sizes[i + 1] = pair - first;
    return { ...n, sizes };
  };
  return walk(node, { x: 0, y: 0, w: 1, h: 1 }, divider.path);
}

/** An even grid: as close to square cells as the count allows, with any
 *  short last row sharing the full width. */
export function grid(ids: string[], aspect = 1.6): LayoutNode | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) return leaf(ids[0]);
  // Pick the column count whose cells are closest to the window's shape.
  let columns = 1;
  let best = Infinity;
  for (let c = 1; c <= ids.length; c++) {
    const rowCount = Math.ceil(ids.length / c);
    const cell = (aspect / c) * rowCount;
    const score = Math.abs(Math.log(cell / 1.2)) + (c * rowCount - ids.length) * 0.15;
    if (score < best - 1e-9) {
      best = score;
      columns = c;
    }
  }
  const rows: LayoutNode[] = [];
  for (let i = 0; i < ids.length; i += columns) {
    rows.push(normalize(split("row", ids.slice(i, i + columns).map(leaf)))!);
  }
  return normalize(split("column", rows));
}

/** One large pane with the rest in a strip beside or below it. */
export function mainAndStack(ids: string[], main: "top" | "left"): LayoutNode | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) return leaf(ids[0]);
  const rest = ids.slice(1).map(leaf);
  return main === "top"
    ? normalize(split("column", [leaf(ids[0]), split("row", rest)], [0.6, 0.4]))
    : normalize(split("row", [leaf(ids[0]), split("column", rest)], [0.6, 0.4]));
}

/** Which side of `rect` the point is nearest, or its middle. */
export function edgeAt(rect: Rect, x: number, y: number): Edge {
  const fx = (x - rect.x) / rect.w;
  const fy = (y - rect.y) / rect.h;
  if (fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7) return "center";
  const distances: [Edge, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ];
  return distances.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
}

/** The part of `rect` a pane dropped on `edge` would take. */
export function dropArea(rect: Rect, edge: Edge): Rect {
  switch (edge) {
    case "left":
      return { ...rect, w: rect.w / 2 };
    case "right":
      return { ...rect, x: rect.x + rect.w / 2, w: rect.w / 2 };
    case "top":
      return { ...rect, h: rect.h / 2 };
    case "bottom":
      return { ...rect, y: rect.y + rect.h / 2, h: rect.h / 2 };
    case "center":
      return rect;
  }
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
