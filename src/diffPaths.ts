/** Compare a `changed`-event path with a `room_diff` path.
 *
 *  The two sides never share one shape: adapters report whatever the model
 *  wrote (absolute paths and leading `./` both occur), while `room_diff`
 *  returns git-relative paths (`--relative`). The daemon already normalizes
 *  for its `by` attribution (`normalized_path` in `changes.rs`); the panel
 *  compared raw strings, so a click on a file the strip listed could match
 *  nothing in the loaded diff and auto-expand silently did nothing. */

function split(path: string): { absolute: boolean; parts: string[] } {
  const fwd = path.replace(/\\/g, "/");
  const absolute = fwd.startsWith("/");
  const parts: string[] = [];
  for (const seg of fwd.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
    } else {
      parts.push(seg);
    }
  }
  return { absolute, parts };
}

/** One canonical form for both path shapes, relative to `cwd` when possible. */
export function normalizeDiffPath(cwd: string | null, path: string): string {
  const norm = split(path);
  const joined = norm.parts.join("/");
  if (!norm.absolute) return joined;
  if (cwd) {
    const base = split(cwd);
    if (base.absolute) {
      const root = base.parts.join("/");
      if (joined === root) return "";
      if (joined.startsWith(`${root}/`)) return joined.slice(root.length + 1);
    }
  }
  return `/${joined}`;
}

/** Whether two paths name the same file in the thread's workspace folder. */
export function sameDiffPath(cwd: string | null, a: string, b: string): boolean {
  return normalizeDiffPath(cwd, a) === normalizeDiffPath(cwd, b);
}
