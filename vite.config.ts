import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// The same commit and dirty flag apex-daemon's build.rs records, so the app
// can tell when a service was built from something else.
function git(args: string[]): string | null {
  try { return execFileSync("git", args, { cwd: new URL(".", import.meta.url).pathname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return null; }
}
const commit = git(["rev-parse", "--short=12", "HEAD"]) || "unknown";
const build = { commit, dirty: commit !== "unknown" && !!git(["status", "--porcelain", "--untracked-files=no"]) };

export default defineConfig({
  plugins: [react()],
  // Shown in Settings › General.
  define: { __APP_VERSION__: JSON.stringify(version), __APP_BUILD__: JSON.stringify(build) },
  clearScreen: false,
  server: { watch: { ignored: ["**/target/**"] } },
  build: {
    rollupOptions: {
      input: {
        main: new URL("./index.html", import.meta.url).pathname,
        phone: new URL("./phone.html", import.meta.url).pathname,
      },
    },
  },
});
