// Asking for a folder or file by typing its path, for a host on another
// machine, where this Mac's file dialog can't look. PathPrompt.tsx shows it.

export interface PathRequest {
  kind: "directory" | "file";
  title: string;
}

/** What's wrong with a typed path, or null. */
export function pathProblem(text: string): string | null {
  const path = text.trim();
  if (!path) return "Type a path.";
  if (!path.startsWith("/")) return "Use a full path, starting with /.";
  return null;
}

export function pathPromptStore() {
  let current: (PathRequest & { resolve: (path: string | null) => void }) | null = null;
  const listeners = new Set<() => void>();
  const change = (next: typeof current) => {
    current = next;
    listeners.forEach((cb) => cb());
  };
  return {
    get: (): PathRequest | null => current,
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    /** Resolves with the path, or null when cancelled. */
    ask(request: PathRequest): Promise<string | null> {
      current?.resolve(null);
      return new Promise((resolve) => change({ ...request, resolve }));
    },
    answer(path: string | null) {
      const asked = current;
      if (!asked) return;
      change(null);
      asked.resolve(path === null ? null : path.trim());
    },
  };
}

/** The app's one path prompt. */
export const pathPrompt = pathPromptStore();
