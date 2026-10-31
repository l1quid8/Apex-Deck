// Shared path and platform helpers so Windows (`\`) and POSIX (`/`) paths split
// the same way across the UI, and file-manager labels match the host OS.

/** Non-empty segments of a POSIX or Windows path. */
export function pathParts(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean);
}

/** Trailing slashes and backslashes removed. */
export function trimTrailingSlash(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

/** The last segment of a file or folder path, or `path` when none is found. */
export function pathBase(path: string): string {
  const trimmed = trimTrailingSlash(path);
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut < 0 ? (trimmed || path) : (trimmed.slice(cut + 1) || path);
}

/** Everything before the last `/` or `\`, or `""` when there is no separator. */
export function pathDir(path: string): string {
  const trimmed = trimTrailingSlash(path);
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut < 0 ? "" : trimmed.slice(0, cut);
}

/** Split a path into its file name and the folder immediately above it. */
export function splitPathName(path: string): { name: string; folder: string } {
  const parts = pathParts(path);
  return {
    name: parts[parts.length - 1] ?? path,
    folder: parts.length > 1 ? parts[parts.length - 2] : "",
  };
}

/** True when running in a Windows browser/Electron window (or when `platform` is Windows). */
export function isWindowsPlatform(platform?: string): boolean {
  const value = platform ?? (typeof window !== "undefined" && typeof navigator !== "undefined" ? (navigator.platform || navigator.userAgent) : "");
  return /Win/i.test(value);
}

export const isWindows: boolean = isWindowsPlatform();

/** "Show in Explorer" on Windows; "Reveal in Finder" elsewhere. */
export function revealInFileManagerLabel(windows = isWindows): string {
  return windows ? "Show in Explorer" : "Reveal in Finder";
}

/** "Show in Explorer" on Windows; "Show in Finder" elsewhere. */
export function showInFileManagerLabel(windows = isWindows): string {
  return windows ? "Show in Explorer" : "Show in Finder";
}

Object.assign(globalThis, {
  pathParts,
  trimTrailingSlash,
  pathBase,
  pathDir,
  splitPathName,
  isWindowsPlatform,
  isWindows,
  revealInFileManagerLabel,
  showInFileManagerLabel,
});
