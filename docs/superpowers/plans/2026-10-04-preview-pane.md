# Preview pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third pane kind, on either deck, that shows a web page, usually a dev server: opened from + New or from a chip on the terminal that printed the address or the thread whose bot mentioned it, checked by the desktop side before it loads, expandable to the full window, and saved with the session.

**Architecture:** One pure module, `src/previewAddress.ts`, owns addresses: what you type, and local server addresses found in terminal output (`ServerWatch` handles colour codes and chunk boundaries). A new Rust module, `src-tauri/src/preview.rs`, requests the address with `reqwest` (already in the workspace through `apex-adapters`) and reports `ok`, `refused` (frame-forbidding headers) or `unreachable`; its header rule is a pure function with tests. `PreviewPane.tsx` draws the address bar, the sandboxed `<iframe>`, the empty, stopped and refused states, and full window (CSS `position: fixed` on the same element, so the page never reloads). A Preview remembers its deck (`Pane.deck`, missing means Code) and `paneSection` in `closing.ts` answers which deck any pane is on. `App.tsx` shows previews on their deck, saves them through `closing.ts`, tracks the newest server each terminal printed and each thread's bots mentioned, and opens a Preview right of its source with `insertBeside`.

**Tech Stack:** Tauri 2, React 19, TypeScript, Rust (reqwest 0.13, tokio), node:test with `--experimental-strip-types`, Vite.

**Spec:** docs/superpowers/specs/2026-10-04-preview-and-artifacts.md (section 1)

## Global Constraints

- Branch `feat/preview-pane` from `main`. Commit on it. Don't push and don't merge to `main` unless Tyler asks. No attribution lines in commit messages.
- Never stash, reset or discard edits you didn't make. If the working tree has someone else's uncommitted changes, work in a separate worktree.
- Copy: second person, plain, sentence case, verb-first buttons, "e.g." placeholders, " · " joins facts, no emoji. Glyphs: □ maximize pane, ▣ restore, × close. The four-corners icon means full window.
- No new npm dependencies. No new crates in `Cargo.lock`: `src-tauri` reuses `reqwest` with exactly the version and features `crates/apex-adapters/Cargo.toml` uses.
- The browser preview backend (`src/backend.ts`, stand-in half) gets every new command the native backend gets.
- New file names differ from every existing file name by more than case.
- Checks: `npm test`, `npm run build`, and when Rust changes `cargo test --workspace -- --test-threads=1` from `src-tauri` (the suite only passes serially).
- Shared names are fixed: pane kind `"preview"`; `Pane.url`, `Pane.servedBy`, `Pane.deck`; `paneSection` in `src/closing.ts`; `PreviewProbe`; `Backend.previewProbe`; Rust command `preview_probe`; `AppSettings.preview.openExternally`; CSS variable `--deck-top`.

## Review Focus

1. **A page escaping its frame.** A previewed page must not navigate the app (`top.location = …`), open windows, or call the app's commands. Check: Task 1 in a release build; Task 6 sets the `sandbox` attribute without `allow-top-navigation` or `allow-popups`.
2. **Addresses that aren't web addresses.** `javascript:`, `file:`, `data:`, `about:` and garbage, typed or in a hand-edited session file, must never load. Tests: Task 2, "anything that isn't a web address is refused"; Task 5, "a preview with an address that isn't a web address loads empty".
3. **Server addresses in real terminal output.** Colour codes inside the address (Vite bolds the port), an address split across two output chunks, LAN addresses and repeats. Tests: Task 2, "servers are found in coloured dev server output", "an address split across two chunks is found once it is whole", "the internet, the LAN and repeats are left out".
4. **Slow or silent servers.** A server that never answers must give "Can't connect" within about 4 s, and polling must stop while the pane is off screen. Tests: Task 3, "nothing listening is unreachable"; Task 6's retry effect depends on `visible`.
5. **Full window losing the page.** Going full window and back must not reload the page, and switching section must end full window. Check: Task 7, step 6.

---

## Before you start

- Line numbers are from `main@3d9a428`. Find every edit by the quoted code, not the number.
- Pure modules load under `node --experimental-strip-types`: type-only imports may omit the extension, value imports between pure modules use `.ts` (as `src/closing.ts` imports `./layout.ts`), no enums, no parameter properties, no React.
- React components have no test harness. Logic lives in pure functions with tests; UI tasks end with a browser-preview check: `npm run dev -- --port 1431`, then http://localhost:1431/ (stand-in backend; `localStorage.clear()` and reload to start clean).

## File map

| File | Change | Responsibility |
|---|---|---|
| `docs/preview-embedding-check.md` | Create (Task 1) | What the release-build check found |
| `src/previewAddress.ts` | Create (Task 2) | `normalizeAddress`, `isLocalHost`, `hostLabel`, `findServerUrls`, `ServerWatch` |
| `tests/preview-address.test.mjs` | Create (Task 2) | Tests for the above |
| `src-tauri/src/preview.rs` | Create (Task 3) | `Probe`, `refuses_framing`, `probe`, `client` |
| `src-tauri/Cargo.toml` | Modify (Task 3) | `reqwest`, as `apex-adapters` has it |
| `src-tauri/src/lib.rs` | Modify (Task 3) | `mod preview;`, `preview_probe` command |
| `src/types.ts` | Modify (Tasks 4, 5) | `PreviewProbe`; `PaneKind` gains `"preview"`; `Pane.url`, `Pane.servedBy` |
| `src/backend.ts` | Modify (Task 4) | `previewProbe`, native and stand-in |
| `src/closing.ts` | Modify (Task 5) | Save, load and lay out previews |
| `src/newPaneItems.ts` | Modify (Task 5) | + New › Preview |
| `src/paneMenu.ts` | Modify (Task 5) | A preview's ⋯ menu |
| `src/settings.ts` | Modify (Task 5) | `preview.openExternally` |
| `tests/closing.test.mjs`, `tests/new-pane.test.mjs`, `tests/pane-menu.test.mjs`, `tests/settings.test.mjs` | Modify (Task 5) | Tests for the above |
| `src/PreviewPane.tsx` | Create (Task 6) | The pane's body |
| `src/styles.css` | Append (Tasks 6, 8) | Preview and server chip styles |
| `src/App.tsx` | Modify (Tasks 7, 8) | Render, save, status, menus, full window position, servers, chip |
| `src/TerminalPane.tsx` | Modify (Task 8) | Report server addresses |
| `src/ChatPane.tsx` | Modify (Task 8) | Report the newest server address a bot mentioned |
| `README.md` | Modify (Task 9) | The Preview pane |

---

### Task 1: Check embedding and isolation in a release build

The app is served from `tauri://localhost` in a release build (from `http://localhost:1420` under `tauri dev`), so only a release build tells us whether an `http://localhost` page may sit inside it and whether that page can reach the app. Nothing in this task changes code.

**Files:**
- Create: `docs/preview-embedding-check.md`

- [ ] **Step 1: Build a debug release binary**

Run: `npm run tauri build -- --debug --no-bundle`
Expected: finishes with the path of the binary under `src-tauri/target/debug/`.

- [ ] **Step 2: Start a page to embed**

In another terminal, from the repo: `npm run dev -- --port 5173`
Expected: Vite prints `Local:   http://localhost:5173/`.

- [ ] **Step 3: Embed it from the app's console**

Run the binary from Step 1. Right-click › Inspect Element to open the web inspector. In the console (top frame) run:

```js
const f = document.createElement("iframe");
f.id = "probe-frame";
f.sandbox = "allow-scripts allow-same-origin allow-forms allow-modals allow-downloads";
f.referrerPolicy = "no-referrer";
f.src = "http://localhost:5173/";
f.style = "position:fixed;left:40px;top:80px;width:640px;height:420px;z-index:999;background:#fff";
document.body.append(f);
```

Expected: the Apex Deck stand-in UI renders inside the white box. Write down what you see.

- [ ] **Step 4: Check the page can't reach the app**

In the inspector, switch the console's context to the `localhost:5173` frame and run:

```js
typeof window.__TAURI_INTERNALS__
```

Expected: `"undefined"`. If it is `"object"`, also run `window.__TAURI_INTERNALS__.invoke("data_folder").then(console.log, console.error)` and write down whether it resolved.

Then, still in the frame's context:

```js
try { top.location.href = "https://example.com"; "navigated" } catch (e) { String(e) }
```

Expected: an error mentioning the sandbox, and the app stays where it was.

- [ ] **Step 5: Check an internet page and a refusing page**

In the top frame console: `document.getElementById("probe-frame").src = "https://github.com/";`
Expected: the box stays blank (GitHub sends `X-Frame-Options: deny`). Then `…src = "https://example.com/";` Expected: example.com renders.

- [ ] **Step 6: Record, decide, commit**

Write `docs/preview-embedding-check.md`: date, binary, each step's result in one line, and the decision.

- All as expected: continue with Task 2.
- Step 3 blank for localhost: **stop** and tell Tyler. The fallback is a native child webview (Tauri's `unstable` feature), which needs its own plan.
- Step 4 shows `__TAURI_INTERNALS__` and `invoke` resolves: **stop** and tell Tyler. Page isolation must be solved first.

```bash
git add docs/preview-embedding-check.md
git commit -m "docs: check that a local page embeds safely in a release build"
```

---

### Task 2: Addresses and server detection

**Files:**
- Create: `src/previewAddress.ts`
- Test: `tests/preview-address.test.mjs`

**Interfaces:**
- Produces: `normalizeAddress(input: string): string | null`, `isLocalHost(host: string): boolean`, `hostLabel(address: string): string`, `findServerUrls(output: string): string[]`, `class ServerWatch { feed(chunk: string): string[]; reset(): void }`.

- [ ] **Step 1: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { ServerWatch, findServerUrls, hostLabel, isLocalHost, normalizeAddress } from "../src/previewAddress.ts";

test("a port or a local host:port is a local server over http", () => {
  assert.equal(normalizeAddress("3000"), "http://localhost:3000/");
  assert.equal(normalizeAddress("localhost:5173"), "http://localhost:5173/");
  assert.equal(normalizeAddress(" 127.0.0.1:8000/docs "), "http://127.0.0.1:8000/docs");
  assert.equal(normalizeAddress("[::1]:4000"), "http://[::1]:4000/");
  assert.equal(normalizeAddress("app.localhost:5173"), "http://app.localhost:5173/");
  assert.equal(normalizeAddress("0.0.0.0:3000"), "http://localhost:3000/");
});

test("other bare names get https, and full addresses are kept", () => {
  assert.equal(normalizeAddress("example.com"), "https://example.com/");
  assert.equal(normalizeAddress("http://example.com/a?b=1#c"), "http://example.com/a?b=1#c");
  assert.equal(normalizeAddress("HTTPS://GitHub.com/l1quid8"), "https://github.com/l1quid8");
});

test("anything that isn't a web address is refused", () => {
  for (const input of ["", "   ", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "about:blank", "ftp://example.com", "two words", "http://"]) {
    assert.equal(normalizeAddress(input), null, input);
  }
});

test("the host label is what the pane head and chip show", () => {
  assert.equal(hostLabel("http://localhost:5173/"), "localhost:5173");
  assert.equal(hostLabel("https://github.com/l1quid8/Apex-Deck"), "github.com");
  assert.equal(hostLabel("not an address"), "");
  assert.equal(isLocalHost("LOCALHOST"), true);
  assert.equal(isLocalHost("192.168.1.5"), false);
});

test("servers are found in coloured dev server output", () => {
  const vite = "\n  \u001b[32m\u001b[1mVITE\u001b[22m v6\u001b[39m  ready in 412 ms\n\n  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m\n  \u001b[32m➜\u001b[39m  \u001b[1mNetwork\u001b[22m: http://192.168.1.5:5173/\n";
  assert.deepEqual(findServerUrls(vite), ["http://localhost:5173/"]);
  assert.deepEqual(findServerUrls("   - Local:        http://localhost:3000\n"), ["http://localhost:3000/"]);
  assert.deepEqual(findServerUrls("Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...\n"), ["http://localhost:8000/"]);
});

test("the internet, the LAN and repeats are left out", () => {
  assert.deepEqual(findServerUrls("docs at https://vitejs.dev and http://10.0.0.2:3000/\n"), []);
  assert.deepEqual(findServerUrls("http://localhost:3000/ and again http://localhost:3000/.\n"), ["http://localhost:3000/"]);
});

test("an address split across two chunks is found once it is whole", () => {
  const watch = new ServerWatch();
  assert.deepEqual(watch.feed("  Local:   http://localhost:51"), []);
  assert.deepEqual(watch.feed("73/\n"), ["http://localhost:5173/"]);
  assert.deepEqual(watch.feed("hmr update /src/App.tsx\n  Local:   http://localhost:5173/\n"), []);
  watch.reset();
  assert.deepEqual(watch.feed("Local: http://localhost:5173/\n"), ["http://localhost:5173/"]);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --experimental-strip-types --test tests/preview-address.test.mjs`
Expected: FAIL, cannot find module `../src/previewAddress.ts`.

- [ ] **Step 3: Write the module**

```ts
// Addresses for the Preview pane: what you type in its address field, and the
// local servers a terminal says it started. See the spec, section 1.

/** Terminal escape sequences: colours, titles and the like. */
const ESCAPES = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-_])/gu;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/** Whether a host is this computer. */
export function isLocalHost(host: string): boolean {
  const name = host.toLowerCase();
  return LOOPBACK.has(name) || name.endsWith(".localhost");
}

/**
 * The address to load for what was typed, or null when it isn't a web
 * address. "3000" and "localhost:3000" are local servers over http; other
 * bare names get https. Only http and https load, so javascript:, file: and
 * data: never do.
 */
export function normalizeAddress(input: string): string | null {
  let text = input.trim();
  if (!text || /\s/.test(text)) return null;
  if (/^\d{2,5}$/.test(text)) text = `localhost:${text}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = text.startsWith("[") ? text.slice(0, text.indexOf("]") + 1) : text.split(/[/:?#]/)[0];
    const local = isLocalHost(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    text = `${local ? "http" : "https"}://${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
  if (url.hostname === "0.0.0.0") url.hostname = "localhost";
  return url.href;
}

/** "localhost:5173" or "github.com"; "" for something that isn't an address. */
export function hostLabel(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return "";
  }
}

const SERVER = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9-]+\.localhost)(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?/giu;

/** Local server addresses in text already stripped of escapes, with where each ends. */
function matches(plain: string): { address: string; end: number }[] {
  const found: { address: string; end: number }[] = [];
  for (const match of plain.matchAll(SERVER)) {
    const address = normalizeAddress(match[0].replace(/[.,;:!]+$/, ""));
    if (address) found.push({ address, end: (match.index ?? 0) + match[0].length });
  }
  return found;
}

/** Local server addresses in terminal output, once each, in order. LAN and internet addresses are left out. */
export function findServerUrls(output: string): string[] {
  const found: string[] = [];
  for (const { address } of matches(output.replace(ESCAPES, ""))) if (!found.includes(address)) found.push(address);
  return found;
}

/**
 * Watches one run of a terminal's output for local server addresses. Output
 * arrives in chunks that can cut an address in two, so the end of each chunk
 * is kept, and an address that runs to the very end of what has arrived waits
 * for the next chunk.
 */
export class ServerWatch {
  private tail = "";
  private seen = new Set<string>();

  /** Addresses that appeared for the first time with this chunk. */
  feed(chunk: string): string[] {
    const text = this.tail + chunk;
    this.tail = text.slice(-256);
    const plain = text.replace(ESCAPES, "");
    const fresh: string[] = [];
    for (const { address, end } of matches(plain)) {
      if (end >= plain.length || this.seen.has(address)) continue;
      this.seen.add(address);
      fresh.push(address);
    }
    return fresh;
  }

  /** Forget everything, for a new run of the program. */
  reset(): void {
    this.tail = "";
    this.seen.clear();
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `node --experimental-strip-types --test tests/preview-address.test.mjs`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/previewAddress.ts tests/preview-address.test.mjs
git commit -m "feat: preview addresses and server detection in terminal output"
```

---

### Task 3: Look at an address before loading it (Rust)

**Files:**
- Create: `src-tauri/src/preview.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: Tauri command `preview_probe(address: String) -> Result<Probe, String>`, where `Probe` serializes as `{"kind":"ok"}`, `{"kind":"refused"}` or `{"kind":"unreachable","reason":"…"}`.

- [ ] **Step 1: Add reqwest to the desktop crate**

In `src-tauri/Cargo.toml`, under `[dependencies]`, after `futures.workspace = true`, add the same line `crates/apex-adapters/Cargo.toml` has:

```toml
reqwest = { version = "0.13", features = ["json", "stream"] }
```

- [ ] **Step 2: Write the module with its tests**

`src-tauri/src/preview.rs`:

```rust
//! The Preview pane's look before it loads a page: is anything answering at
//! the address, and does the site allow being shown inside another app.
//! See docs/superpowers/specs/2026-10-04-preview-and-artifacts.md, 1.4.

use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Probe {
    /// Something answered, and it may be shown in a frame.
    Ok,
    /// The site asks browsers not to show it inside other apps.
    Refused,
    /// Nothing answered.
    Unreachable { reason: String },
}

/// Whether a response's headers forbid showing it in a frame owned by another
/// site: `X-Frame-Options` of DENY, SAMEORIGIN or ALLOW-FROM (values browsers
/// don't know are ignored, as browsers do), or a `frame-ancestors` directive
/// that doesn't list `*`.
pub fn refuses_framing(x_frame_options: &[&str], policies: &[&str]) -> bool {
    let by_header = x_frame_options.iter().flat_map(|value| value.split(',')).any(|value| {
        let value = value.trim().to_ascii_lowercase();
        value == "deny" || value == "sameorigin" || value.starts_with("allow-from")
    });
    let by_policy = policies.iter().flat_map(|policy| policy.split(';')).any(|directive| {
        let mut parts = directive.split_whitespace();
        parts.next().is_some_and(|name| name.eq_ignore_ascii_case("frame-ancestors")) && !parts.any(|source| source == "*")
    });
    by_header || by_policy
}

/// A client for looking: 4 s at most, up to 5 redirects, never through a proxy.
pub fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .redirect(reqwest::redirect::Policy::limited(5))
        .no_proxy()
        .build()
        .expect("the preview client has no settings that can fail")
}

pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(build_client)
}

/// Request the address and judge the answer by its headers. The body is never
/// read. HTTP error statuses still count as answering.
pub async fn probe(client: &reqwest::Client, address: &str) -> Result<Probe, String> {
    let url = reqwest::Url::parse(address).map_err(|_| "That isn't a web address.".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Only web addresses can be previewed.".into());
    }
    match client.get(url).send().await {
        Ok(response) => {
            let headers = response.headers();
            let frame: Vec<&str> = headers.get_all("x-frame-options").iter().filter_map(|v| v.to_str().ok()).collect();
            let policy: Vec<&str> = headers.get_all("content-security-policy").iter().filter_map(|v| v.to_str().ok()).collect();
            Ok(if refuses_framing(&frame, &policy) { Probe::Refused } else { Probe::Ok })
        }
        Err(error) => Ok(Probe::Unreachable {
            reason: if error.is_timeout() { "It took too long to answer.".into() } else { "Nothing is answering there.".into() },
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_rules_follow_the_headers() {
        assert!(!refuses_framing(&[], &[]));
        assert!(refuses_framing(&["DENY"], &[]));
        assert!(refuses_framing(&["sameorigin"], &[]));
        assert!(refuses_framing(&["ALLOW-FROM https://example.com"], &[]));
        assert!(refuses_framing(&["SAMEORIGIN, SAMEORIGIN"], &[]));
        assert!(!refuses_framing(&["ALLOWALL"], &[]), "browsers ignore values they don't know");
        assert!(refuses_framing(&[], &["default-src 'self'; frame-ancestors 'self'"]));
        assert!(refuses_framing(&[], &["frame-ancestors 'none'"]));
        assert!(!refuses_framing(&[], &["frame-ancestors *"]));
        assert!(!refuses_framing(&[], &["default-src 'self'"]));
        assert!(refuses_framing(&[], &["default-src *", "frame-ancestors https://a.example"]));
    }

    /// Answer one request with a fixed response, from a port picked by the system.
    fn serve_once(response: &'static str) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0u8; 2048];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        address
    }

    #[tokio::test]
    async fn a_page_that_forbids_frames_is_refused_and_one_that_allows_them_is_ok() {
        let client = build_client();
        let refused = serve_once("HTTP/1.1 200 OK\r\nX-Frame-Options: DENY\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        assert_eq!(probe(&client, &refused).await.unwrap(), Probe::Refused);
        let missing = serve_once("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        assert_eq!(probe(&client, &missing).await.unwrap(), Probe::Ok);
    }

    #[tokio::test]
    async fn nothing_listening_is_unreachable() {
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let result = probe(&build_client(), &format!("http://127.0.0.1:{port}/")).await.unwrap();
        assert!(matches!(result, Probe::Unreachable { .. }), "{result:?}");
    }

    #[tokio::test]
    async fn only_web_addresses_are_looked_at() {
        let client = build_client();
        assert!(probe(&client, "file:///etc/passwd").await.is_err());
        assert!(probe(&client, "not an address").await.is_err());
    }

    #[test]
    fn probes_serialize_the_way_the_frontend_reads_them() {
        assert_eq!(serde_json::to_value(Probe::Ok).unwrap(), serde_json::json!({"kind":"ok"}));
        assert_eq!(serde_json::to_value(Probe::Unreachable { reason: "x".into() }).unwrap(), serde_json::json!({"kind":"unreachable","reason":"x"}));
    }
}
```

- [ ] **Step 3: Register the module and the command**

In `src-tauri/src/lib.rs`, after `mod pty;` add `mod preview;`. After the `env_present` function (the block ending with `names.iter().map(|name| env_is_set(name)).collect()` and its closing brace), add:

```rust
/// Look at a web address before the Preview pane loads it. See preview.rs.
#[tauri::command]
async fn preview_probe(address: String) -> Result<preview::Probe, String> {
    preview::probe(preview::client(), &address).await
}
```

In `tauri::generate_handler![`, after `settings_save,` add `preview_probe,`.

- [ ] **Step 4: Run the Rust tests**

Run (from `src-tauri`): `cargo test --workspace -- --test-threads=1 preview`
Expected: PASS, 5 tests in `preview::tests`. Then `git diff --stat Cargo.lock` from the repo root.
Expected: `Cargo.lock` changes only by adding `reqwest` to `apex-deck`'s dependency list, with no new `[[package]]` entries. If a new package appears, the features differ from `apex-adapters`; match them.

- [ ] **Step 5: Run the whole Rust suite**

Run (from `src-tauri`): `cargo test --workspace -- --test-threads=1`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml Cargo.lock src-tauri/src/preview.rs src-tauri/src/lib.rs
git commit -m "feat: look at a preview address before loading it"
```

---

### Task 4: The probe in both backends

**Files:**
- Modify: `src/types.ts`, `src/backend.ts`

**Interfaces:**
- Produces: `type PreviewProbe = { kind: "ok" } | { kind: "refused" } | { kind: "unreachable"; reason: string }` in `src/types.ts`; `Backend.previewProbe(address: string): Promise<PreviewProbe>`.

- [ ] **Step 1: Add the type**

In `src/types.ts`, after `export type PaneKind = "terminal" | "chat";` add:

```ts
/** What the desktop side found at a Preview address before loading it. */
export type PreviewProbe = { kind: "ok" } | { kind: "refused" } | { kind: "unreachable"; reason: string };
```

- [ ] **Step 2: Add it to the interface**

In `src/backend.ts`, add `PreviewProbe` to the `import type { … } from "./types";` list. In `interface Backend`, after `envPresent(names: string[]): Promise<boolean[]>;` add:

```ts
  /** Look at a web address before the Preview pane loads it: does anything answer, and may it be framed. */
  previewProbe(address: string): Promise<PreviewProbe>;
```

- [ ] **Step 3: Native**

After `envPresent: (names) => invoke<boolean[]>("env_present", { names }),` add:

```ts
    previewProbe: (address) => invoke<PreviewProbe>("preview_probe", { address }),
```

- [ ] **Step 4: Stand-in**

In the stand-in backend, after its `settingsSave` entry, add:

```ts
    // A browser can't read another site's headers, so a few well-known sites
    // stand in for "refused", and anything that fails to fetch is unreachable.
    previewProbe: async (address) => {
      const host = new URL(address).hostname;
      if (/(^|\.)(github\.com|google\.com)$/.test(host)) return { kind: "refused" };
      try {
        await fetch(address, { mode: "no-cors", cache: "no-store" });
        return { kind: "ok" };
      } catch {
        return { kind: "unreachable", reason: "Nothing is answering there." };
      }
    },
```

- [ ] **Step 5: Check and commit**

Run: `npm run build`
Expected: PASS.

```bash
git add src/types.ts src/backend.ts
git commit -m "feat: preview probe in the native and stand-in backends"
```

---

### Task 5: Preview panes in the model, the session, the menus and settings

**Files:**
- Modify: `src/types.ts`, `src/closing.ts`, `src/newPaneItems.ts`, `src/paneMenu.ts`, `src/settings.ts`
- Test: `tests/closing.test.mjs`, `tests/new-pane.test.mjs`, `tests/pane-menu.test.mjs`, `tests/settings.test.mjs`

**Interfaces:**
- Consumes: `normalizeAddress` (Task 2).
- Produces: `PaneKind = "terminal" | "chat" | "preview"`; `Pane.url?: string`, `Pane.servedBy?: string`, `Pane.deck?: "code" | "threads"`; `paneSection(pane: Pick<Pane, "kind" | "deck">): "code" | "threads"` in `src/closing.ts`; `paneMenuItems(kind, terminal, preview?: { address: string })` and action `"copy_address"`; `NewMenuItem.kind` gains `"preview"`; `AppSettings.preview: { openExternally: string[] }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/closing.test.mjs`:

```js
const preview = (id, extra = {}) => ({ id, workspaceId: "w", kind: "preview", title: id, url: "http://localhost:5173/", ...extra });

test("a preview is saved and read back with its address and source terminal", () => {
  const saved = savedPanes([preview("p", { servedBy: "t", stray: 1 })]);
  assert.deepEqual(saved, [{ id: "p", workspaceId: "w", kind: "preview", title: "p", url: "http://localhost:5173/", servedBy: "t" }]);
  assert.deepEqual(loadedPanes(saved, ["w"]), saved);
});

test("a preview with an address that isn't a web address loads empty, and a nameless one is left out", () => {
  const [loaded] = loadedPanes([preview("p", { url: "javascript:alert(1)" })], ["w"]);
  assert.equal(loaded.url, "");
  assert.deepEqual(loadedPanes([preview("q", { title: " " })], ["w"]), []);
});

test("previews keep their place in the Code layout", () => {
  const tree = row([leaf("t"), leaf("p")], [0.5, 0.5]);
  assert.deepEqual(restoredLayouts({ "w:code": tree }, [term("t"), preview("p")])["w:code"], tree);
});

test("a preview remembers which deck it is on, and one without a deck is on Code", () => {
  const saved = savedPanes([preview("p", { deck: "threads" })]);
  assert.equal(saved[0].deck, "threads");
  assert.equal(loadedPanes(saved, ["w"])[0].deck, "threads");
  assert.equal(loadedPanes([preview("q", { deck: "elsewhere" })], ["w"])[0].deck, undefined);
  assert.equal(paneSection(preview("q")), "code");
  assert.equal(paneSection(preview("r", { deck: "threads" })), "threads");
  assert.equal(paneSection(chat("c")), "threads");
  assert.equal(paneSection(term("t")), "code");
});

test("a preview on the Threads deck keeps its place beside threads, not terminals", () => {
  const tree = row([leaf("c"), leaf("p")], [0.5, 0.5]);
  const panes = [chat("c"), preview("p", { deck: "threads" })];
  assert.deepEqual(restoredLayouts({ "w:threads": tree }, panes)["w:threads"], tree);
  assert.equal(restoredLayouts({ "w:code": tree }, panes)["w:code"], undefined);
});
```

Add `paneSection` to the test file's import from `../src/closing.ts`.

Append to `tests/pane-menu.test.mjs`:

```js
test("a preview's menu renames, copies its address and closes", () => {
  const terminal = { running: false, installed: true, tool: "", folder: "" };
  const items = paneMenuItems("preview", terminal, { address: "http://localhost:5173/" });
  assert.deepEqual(items.map((i) => i.action), ["rename", "copy_address", "close"]);
  assert.equal(items[1].disabled, false);
  const empty = paneMenuItems("preview", terminal, { address: "" });
  assert.equal(empty[1].disabled, true);
  assert.equal(empty[1].reason, "No page yet.");
});
```

In `tests/new-pane.test.mjs`, in "the + New menu lists installed tools first, then the shell, then missing tools", change the expected labels to:

```js
  assert.deepEqual(items.map((i) => i.label), ["Claude Code", "Codex", "Terminal", "Preview", "Gemini CLI"]);
```

in the same test change `["chat"]` to `["chat", "preview"]` in the `newMenuItems("threads", …)` line, and append:

```js
test("+ New offers a Preview on both decks", () => {
  const item = { key: "preview", label: "Preview", detail: "a web page", kind: "preview", installed: true };
  assert.deepEqual(newMenuItems("code", agents, on([]), "preview")[0], item);
  assert.deepEqual(newMenuItems("threads", agents, on([]), "preview")[0], item);
});
```

In `tests/settings.test.mjs`, in "saved values are kept", add `preview: { openExternally: ["github.com"] }` to the `saved` object, and append:

```js
test("hosts to open in the browser are kept lower case, once each", () => {
  assert.deepEqual(readSettings({ preview: { openExternally: ["GitHub.com", "github.com", 4, " "] } }).preview.openExternally, ["github.com"]);
  assert.deepEqual(readSettings({ preview: "broken" }).preview.openExternally, []);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm test`
Expected: FAIL in closing, pane-menu, new-pane and settings tests (unknown kind, missing item, missing `preview`).

- [ ] **Step 3: The pane type**

In `src/types.ts`, change `export type PaneKind = "terminal" | "chat";` to:

```ts
export type PaneKind = "terminal" | "chat" | "preview";
```

In `interface Pane`, after the `agent?: string;` line and its comment, add:

```ts
  /** A Preview pane's address; "" before one is chosen. */
  url?: string;
  /** The terminal or thread whose server a Preview shows, when it was opened from one. */
  servedBy?: string;
  /** The deck a Preview is on. Missing means Code. */
  deck?: "code" | "threads";
```

- [ ] **Step 4: Saving, loading, and which deck a pane is on**

In `src/closing.ts`, after `openPanes`, add:

```ts
/** The deck a pane sits on: threads on Threads, terminals on Code, a preview wherever it was added. */
export function paneSection(pane: Pick<Pane, "kind" | "deck">): "code" | "threads" {
  if (pane.kind === "chat") return "threads";
  if (pane.kind === "preview") return pane.deck === "threads" ? "threads" : "code";
  return "code";
}
```

In `src/closing.ts`, add after `import { leafIds, removeLeaf, validate } from "./layout.ts";`:

```ts
import { normalizeAddress } from "./previewAddress.ts";
```

In `savedPanes`, after `if (p.kind === "chat") return p;` add:

```ts
    if (p.kind === "preview") {
      const preview: Pane = { id: p.id, workspaceId: p.workspaceId, kind: "preview", title: p.title, url: p.url ?? "" };
      if (p.servedBy) preview.servedBy = p.servedBy;
      if (p.deck === "threads") preview.deck = "threads";
      return preview;
    }
```

In `loadedPanes`, before `if (p.kind !== "terminal" || typeof p.title !== "string" || !p.title.trim()) return [];` add:

```ts
    if (p.kind === "preview") {
      if (typeof p.title !== "string" || !p.title.trim()) return [];
      seen.add(p.id);
      const preview: Pane = { id: p.id, workspaceId: p.workspaceId, kind: "preview", title: p.title, url: typeof p.url === "string" ? normalizeAddress(p.url) ?? "" : "" };
      if (typeof p.servedBy === "string" && p.servedBy) preview.servedBy = p.servedBy;
      if (p.deck === "threads") preview.deck = "threads";
      return [preview];
    }
```

Update the doc comments of both functions to mention previews ("each terminal and preview as a descriptor"; "a preview comes back with its address, if it is a web address").

In `restoredLayouts`, replace

```ts
    const kind = section === "code" ? "terminal" : "chat";
    const loaded = new Set(panes.filter((p) => p.workspaceId === workspace && p.kind === kind).map((p) => p.id));
```

with

```ts
    const loaded = new Set(panes.filter((p) => p.workspaceId === workspace && paneSection(p) === section).map((p) => p.id));
```

- [ ] **Step 5: + New › Preview, on both decks**

In `src/newPaneItems.ts`, change `kind: "terminal" | "chat";` to `kind: "terminal" | "chat" | "preview";`. Above `newMenuItems` add:

```ts
const PREVIEW: NewMenuItem = { key: "preview", label: "Preview", detail: "a web page", kind: "preview", installed: true };
```

Change the threads list to `[{ key: "chat", label: "Group chat", detail: "new thread", kind: "chat", installed: true }, PREVIEW]`, and after `{ key: "shell", label: "Terminal", detail: "your shell", kind: "terminal", installed: true },` add `PREVIEW,`.

- [ ] **Step 6: A preview's ⋯ menu**

In `src/paneMenu.ts`, change the action type to:

```ts
export type PaneMenuAction = "rename" | "start" | "copy_path" | "copy_address" | "close" | "fork" | "export" | "delete";
```

Change `export function paneMenuItems(kind: PaneKind, terminal: TerminalMenuState): PaneMenuItem[] {` to take a third argument, and add the preview branch right after the chat branch:

```ts
export function paneMenuItems(kind: PaneKind, terminal: TerminalMenuState, preview: { address: string } = { address: "" }): PaneMenuItem[] {
  if (kind === "chat") {
    return [item("rename", "Rename"), item("fork", "Fork"), item("export", "Export"), item("delete", "Delete thread…", { danger: true, separated: true })];
  }
  if (kind === "preview") {
    return [
      item("rename", "Rename"),
      item("copy_address", "Copy address", { disabled: !preview.address, reason: preview.address ? "" : "No page yet." }),
      item("close", "Close", { separated: true }),
    ];
  }
```

- [ ] **Step 7: Settings**

In `src/settings.ts`, add to `interface AppSettings` after `terminal: …;`:

```ts
  /** Hosts whose pages open in your browser instead of the Preview pane. */
  preview: { openExternally: string[] };
```

Add `preview: { openExternally: [] },` to `DEFAULT_SETTINGS` after `terminal`. In `readSettings`, after the `terminal: { … },` entry add:

```ts
    preview: {
      openExternally: [...new Set((strings(record(saved.preview).openExternally) ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean))],
    },
```

- [ ] **Step 8: Run the tests**

Run: `npm test`
Expected: PASS. Then `npm run build`. Expected: errors only where `App.tsx` reads `pane.kind` exhaustively, if any; fix none yet if they are only warnings. If `tsc` reports an error in `App.tsx`, note it for Task 7 and make the smallest fix that keeps today's behaviour (treat `"preview"` like `"terminal"` there).

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/closing.ts src/newPaneItems.ts src/paneMenu.ts src/settings.ts tests/closing.test.mjs tests/new-pane.test.mjs tests/pane-menu.test.mjs tests/settings.test.mjs src/App.tsx
git commit -m "feat: preview panes in the session, + New, the pane menu and settings"
```

---

### Task 6: The Preview pane

**Files:**
- Create: `src/PreviewPane.tsx`
- Modify: `src/styles.css` (append)

**Interfaces:**
- Consumes: `normalizeAddress`, `hostLabel` (Task 2); `Backend.previewProbe` (Task 4); `Pane.url` (Task 5).
- Produces: `PreviewPane` with the props below and `type ServerChoice = { address: string; source: string; sourceId: string }`.

- [ ] **Step 1: Write the component**

```tsx
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import type { Backend } from "./backend";
import { hostLabel, normalizeAddress } from "./previewAddress";
import type { Pane, PreviewProbe } from "./types";

// A web page beside your terminals. The desktop side looks at the address
// before the page loads (preview.rs), so a stopped server or a site that
// refuses frames gets words instead of a blank box. See the spec, section 1.

/** A local server a terminal printed or a thread's bot mentioned, for the empty page. */
export interface ServerChoice {
  address: string;
  /** The terminal's or thread's name. */
  source: string;
  sourceId: string;
}

interface Props {
  pane: Pane;
  backend: Backend;
  /** False while the pane's section is off screen: polling stops and full window ends. */
  visible: boolean;
  servers: ServerChoice[];
  /** The terminal or thread this page's address came from, while it is still open. A thread counts as running. */
  source: { title: string; kind: "terminal" | "chat"; running: boolean } | null;
  /** Hosts you chose to always open in your browser. */
  openExternally: string[];
  onOpenExternallyChange: (hosts: string[]) => void;
  onAddress: (paneId: string, address: string, servedBy?: string) => void;
  /** The muted words for the pane head. */
  onStatus: (paneId: string, text: string) => void;
  onStartSource: () => void;
  onShowSource: () => void;
  onOpenInBrowser: (address: string) => void;
}

type Look = { kind: "checking" } | PreviewProbe | { kind: "invalid"; reason: string };

const RETRY_MS = 2000;
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-downloads";

const svg = (paths: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>
);
const RELOAD = svg(<><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>);
const CORNERS = svg(<><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></>);

export function PreviewPane({ pane, backend, visible, servers, source, openExternally, onOpenExternallyChange, onAddress, onStatus, onStartSource, onShowSource, onOpenInBrowser }: Props) {
  const address = pane.url ?? "";
  const host = address ? hostLabel(address) : "";
  const [typed, setTyped] = useState(address);
  const [error, setError] = useState("");
  const [look, setLook] = useState<Look>({ kind: "checking" });
  /** Bumped by Reload: a new frame, and a new look first. */
  const [frame, setFrame] = useState(0);
  const [full, setFull] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  /** The address the browser was last opened for by itself, so it opens once. */
  const openedFor = useRef("");

  // Keep the field in step when the address changes from outside, e.g. a terminal's chip.
  useEffect(() => {
    setTyped(address);
    setError("");
  }, [address]);

  // Look before loading, once per address and per Reload.
  useEffect(() => {
    if (!address) return;
    let live = true;
    setLook({ kind: "checking" });
    backend.previewProbe(address).then(
      (result) => { if (live) setLook(result); },
      (reason) => { if (live) setLook({ kind: "invalid", reason: String(reason) }); },
    );
    return () => { live = false; };
  }, [backend, address, frame]);

  // While nothing answers and the pane is on screen, look again every 2 s.
  useEffect(() => {
    if (look.kind !== "unreachable" || !visible || !address) return;
    let live = true;
    const timer = setTimeout(() => {
      backend.previewProbe(address).then((result) => { if (live) setLook(result); }, () => {});
    }, RETRY_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [look, visible, backend, address]);

  // Hosts you chose to always open in your browser: open it once per address.
  useEffect(() => {
    if (look.kind === "refused" && openExternally.includes(host) && openedFor.current !== address) {
      openedFor.current = address;
      onOpenInBrowser(address);
    }
  }, [look, host, address, openExternally, onOpenInBrowser]);

  const status = !address ? "No page yet"
    : look.kind === "checking" ? "Checking…"
    : look.kind === "ok" ? (source ? `From ${source.title}` : "")
    : look.kind === "refused" ? "Won't load here"
    : "Can't connect";
  useEffect(() => { onStatus(pane.id, status); }, [onStatus, pane.id, status]);

  // Full window ends when the pane leaves the screen, and on Esc. Esc pressed
  // inside the page stays with the page; ▣ always works.
  useEffect(() => { if (!visible) setFull(false); }, [visible]);
  useEffect(() => {
    if (!full) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setFull(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [full]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = normalizeAddress(typed);
    if (!next) {
      setError("That isn't a web address. Try e.g. localhost:3000.");
      return;
    }
    setError("");
    if (next === address) setFrame((n) => n + 1);
    else onAddress(pane.id, next);
  };

  return (
    <div className={full ? "preview full-window" : "preview"}>
      <div className="preview-bar">
        {full && <span className="preview-full-title">{pane.title}</span>}
        <button className="icon small" disabled={!address} onClick={() => setFrame((n) => n + 1)} aria-label="Reload" title="Reload">{RELOAD}</button>
        <form onSubmit={submit}>
          <input ref={field} aria-label="Address" value={typed} placeholder="e.g. localhost:3000" spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => setTyped(event.target.value)} />
        </form>
        <button className="icon small" disabled={!address} onClick={() => setFull((on) => !on)} aria-label={full ? "Back to the deck" : "Full window"} title={full ? "Back to the deck (Esc)" : "Full window (Esc to go back)"}>
          {full ? "▣" : CORNERS}
        </button>
        <button className="small" disabled={!address} onClick={() => onOpenInBrowser(address)}>Open in browser</button>
      </div>
      {error && <p className="preview-error" role="alert">{error}</p>}
      <div className="preview-body">
        {!address && <EmptyPage servers={servers} onPick={(server) => onAddress(pane.id, server.address, server.sourceId)} />}
        {address && look.kind === "ok" && (
          <iframe key={frame} src={address} title={`Preview of ${host}`} sandbox={SANDBOX} referrerPolicy="no-referrer" />
        )}
        {address && look.kind === "checking" && <p className="preview-checking" role="status">Checking {host}…</p>}
        {address && (look.kind === "unreachable" || look.kind === "invalid") && (
          <div className="preview-notice" role="status">
            <h2>Nothing is answering at {host}.</h2>
            <p>
              {look.kind === "invalid" ? look.reason
                : source?.kind === "terminal" && !source.running ? `${source.title} has stopped. The page comes back by itself once the server answers again.`
                : "The page comes back by itself once the server answers."}
            </p>
            {source && (
              <div className="preview-actions">
                {source.kind === "terminal" && !source.running && <button className="primary" onClick={onStartSource}>Start {source.title} again</button>}
                <button onClick={onShowSource}>{source.kind === "chat" ? "Show thread" : "Show terminal"}</button>
              </div>
            )}
            {look.kind === "unreachable" && <span className="preview-retry">Checking every 2 s</span>}
          </div>
        )}
        {address && look.kind === "refused" && (
          <div className="preview-notice" role="status">
            <h2>{host} won't load inside the deck.</h2>
            <p>The site tells browsers not to show it inside other apps. Most sites with a sign-in do this.</p>
            <div className="preview-actions">
              <button className="primary" onClick={() => onOpenInBrowser(address)}>Open in browser</button>
              <button onClick={() => field.current?.select()}>Change address</button>
            </div>
            <label className="preview-always">
              <input
                type="checkbox"
                checked={openExternally.includes(host)}
                onChange={(event) => onOpenExternallyChange(event.target.checked ? [...openExternally, host] : openExternally.filter((h) => h !== host))}
              />
              Always open {host} in my browser
            </label>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyPage({ servers, onPick }: { servers: ServerChoice[]; onPick: (server: ServerChoice) => void }) {
  return (
    <div className="preview-empty">
      <h2>Open a page.</h2>
      <p>{servers.length > 0 ? "Pick a server from a terminal or thread, or type an address above." : "Type an address above. Servers your terminals start, and ones bots mention, show up here."}</p>
      {servers.length > 0 && (
        <>
          <span className="preview-label">Servers in this workspace</span>
          <div className="preview-servers">
            {servers.map((server) => (
              <button key={`${server.sourceId} ${server.address}`} onClick={() => onPick(server)}>
                <span className="dot working" aria-hidden="true" />
                <span className="preview-server"><span className="mono">{hostLabel(server.address)}</span><small>{server.source}</small></span>
                <span className="preview-open">Open</span>
              </button>
            ))}
          </div>
        </>
      )}
      <p className="preview-foot">Pages from the internet often refuse to load inside another app. Those open in your browser instead.</p>
    </div>
  );
}
```
- [ ] **Step 2: Styles**

Append to `src/styles.css`:

```css
/* Preview: a web page beside your terminals. */
.preview { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--panel); }
.preview-bar { display: flex; align-items: center; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
.preview-bar form { flex: 1; min-width: 0; display: flex; }
.preview-bar input { flex: 1; min-width: 0; padding: 5px 10px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
.preview-full-title { padding: 0 8px; font-weight: 600; white-space: nowrap; }
.preview-error { margin: 0; padding: 6px 12px; font-size: 12px; color: var(--danger); border-bottom: 1px solid var(--line); }
.preview-body { position: relative; flex: 1; min-height: 0; display: flex; overflow: auto; }
.preview-body iframe { flex: 1; border: 0; background: #fff; }
.preview-checking { margin: auto; color: var(--muted); }
.preview-notice, .preview-empty { margin: auto; max-width: 420px; padding: 32px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.preview-empty { margin: 0; max-width: none; width: 100%; box-sizing: border-box; padding: 28px 32px; align-items: stretch; }
.preview-notice h2, .preview-empty h2 { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: -0.035em; }
.preview-notice p, .preview-empty p { margin: 0; color: var(--muted); max-width: 46ch; }
.preview-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.preview-retry { margin-top: 6px; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
.preview-always { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; color: var(--muted); }
.preview-label { margin-top: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
.preview-servers { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); overflow: hidden; }
.preview-servers button { display: flex; align-items: center; gap: 12px; padding: 10px 12px; text-align: left; border: 0; border-radius: 0; border-top: 1px solid var(--line); background: transparent; }
.preview-servers button:first-child { border-top: 0; }
.preview-servers button:hover { background: var(--panel-2); }
.preview-server { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.preview-server small { font-size: 12px; color: var(--muted); }
.preview-open { font-size: 12px; padding: 3px 10px; border: 1px solid var(--line); border-radius: 6px; }
.preview-foot { margin-top: auto !important; padding-top: 16px; font-size: 12px; }
/* Full window: the same element, fixed over the rail and deck, so the page keeps its state. */
.preview.full-window { position: fixed; top: var(--deck-top, 0px); left: 0; right: 0; bottom: 0; z-index: 35; background: var(--bg); }
```

- [ ] **Step 3: Check and commit**

Run: `npm run build`
Expected: PASS (the component isn't mounted yet).

```bash
git add src/PreviewPane.tsx src/styles.css
git commit -m "feat: Preview pane body with its address bar, states and full window"
```

---

### Task 7: Previews on the deck

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: everything above.
- Produces: CSS variable `--deck-top` on `document.documentElement` (the top of `.body` in px), used by every full-window element.

- [ ] **Step 1: Imports and state**

Add `import { PreviewPane } from "./PreviewPane";` after `import { TerminalPane } from "./TerminalPane";` and `import { hostLabel } from "./previewAddress";` after the `terminalTitle` import.

After `const onRunStart = useCallback(…)` add:

```ts
  /** The muted words each Preview shows in its pane head. */
  const [previewStatus, setPreviewStatus] = useState<Record<string, string>>({});
  const onPreviewStatus = useCallback((paneId: string, text: string) => {
    setPreviewStatus((all) => (all[paneId] === text ? all : { ...all, [paneId]: text }));
  }, []);
```

- [ ] **Step 2: Name, status and visibility**

In `programOf`, before `if (pane.kind !== "terminal") return "";` add:

```ts
    if (pane.kind === "preview") return pane.url ? hostLabel(pane.url) : "";
```

In `statusOf`, as its first line add `if (pane.kind === "preview") return "idle";`.

Add `paneSection` to the import from `./closing`. In `visiblePanes`, replace `(section === "code" ? p.kind === "terminal" : section === "threads" && p.kind === "chat")` with `paneSection(p) === section`.

In `addPane`, replace the `const name = …` and `const pane: Pane = …` lines, and the `setSection(…)` line, with:

```ts
    const name = kind === "chat" ? title : nextTitle(title, panes.filter((p) => p.workspaceId === activeWorkspace && p.kind === kind).map((p) => p.title));
    const pane: Pane = { id: newId("pane"), workspaceId: activeWorkspace, kind, title: name, agent };
    // A Preview stays on the deck it was added from.
    if (kind === "preview" && section === "threads") pane.deck = "threads";
```

and, where `setSection(kind === "chat" ? "threads" : "code");` was, `setSection(paneSection(pane));`. Update the comment above `name`: "A second terminal or preview of the same name in a workspace is numbered: "Codex 2", "Preview 2"."

In `focusPane`, change `setSection(pane.kind === "chat" ? "threads" : "code");` to `setSection(paneSection(pane));`.

- [ ] **Step 3: Address, source, browser and menu**

After `addPane`, add:

```ts
  /** A Preview's address changed. A typed address has no source terminal. */
  const setPreviewAddress = useCallback((paneId: string, address: string, servedBy?: string) => {
    setPanes((list) => list.map((p) => {
      if (p.id !== paneId) return p;
      const next: Pane = { ...p, url: address };
      if (servedBy) next.servedBy = servedBy;
      else delete next.servedBy;
      return next;
    }));
  }, []);

  /** The terminal or thread a Preview's address came from, while it is open. */
  const sourceOf = (pane: Pane) => {
    const source = pane.servedBy ? panes.find((p) => p.id === pane.servedBy && !p.closed && (p.kind === "terminal" || p.kind === "chat")) : undefined;
    if (!source) return null;
    const kind: "terminal" | "chat" = source.kind === "chat" ? "chat" : "terminal";
    return { pane: source, title: source.title, kind, running: kind === "chat" || isRunning(runs[source.id]) };
  };

  const openInBrowser = useCallback((address: string) => {
    backend?.openTarget(address, null, false).catch(() => {});
  }, [backend]);
```

In `runPaneMenu`, after the `copy_path` branch's closing brace add:

```ts
    else if (action === "copy_address") {
      if (pane.url) navigator.clipboard?.writeText(pane.url).catch(() => {});
    }
```

so the chain reads `… } else if (action === "copy_address") { … } else if (action === "close") …`.

In the pane head's menu, change `paneMenuItems(pane.kind, { running: …, folder: workspace?.path ?? "" })` to pass `{ address: pane.url ?? "" }` as a third argument.

In both `ThreadName` uses, change `label={pane.kind === "chat" ? "Thread name" : "Terminal name"}` to:

```tsx
label={pane.kind === "chat" ? "Thread name" : pane.kind === "preview" ? "Preview name" : "Terminal name"}
```

In the pane head's `pane-folder` span, change its text expression to:

```tsx
{pane.kind === "chat" ? threadStatus[pane.id]?.text ?? "" : pane.kind === "preview" ? previewStatus[pane.id] ?? "" : status === "working" ? workingFor(runStart.current.get(pane.id) ?? Date.now(), Date.now()) : stateWord(runs[pane.id], false)}
```

- [ ] **Step 4: Render it**

Replace `{pane.kind === "terminal" ? (` … `) : (` (the line that opens the `ChatPane` branch) so the body reads:

```tsx
                    {pane.kind === "terminal" ? (
                      <TerminalPane … unchanged … />
                    ) : pane.kind === "preview" ? (
                      <PreviewPane
                        pane={pane}
                        backend={backend}
                        visible={visible}
                        servers={[]}
                        source={sourceOf(pane)}
                        openExternally={settings.preview.openExternally}
                        onOpenExternallyChange={(hosts) => setSettings({ ...settings, preview: { openExternally: hosts } })}
                        onAddress={setPreviewAddress}
                        onStatus={onPreviewStatus}
                        onStartSource={() => { const source = sourceOf(pane); if (source) setStartRequests((all) => ({ ...all, [source.pane.id]: (all[source.pane.id] ?? 0) + 1 })); }}
                        onShowSource={() => { const source = sourceOf(pane); if (source) focusPane(source.pane); }}
                        onOpenInBrowser={openInBrowser}
                      />
                    ) : (
                      <ChatPane … unchanged … />
                    )}
```

`servers={[]}` is filled in Task 8.

- [ ] **Step 5: Where the deck starts, for full window**

After the `focusPane` function add:

```ts
  // Where the deck starts, for things that expand to the full window (the
  // Preview pane, the artifacts panel). Kept current as the title bar wraps.
  const deckTopWatch = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || deckTopWatch.current) return;
    const set = () => document.documentElement.style.setProperty("--deck-top", `${body.getBoundingClientRect().top}px`);
    set();
    deckTopWatch.current = new ResizeObserver(set);
    deckTopWatch.current.observe(body);
  });
  useEffect(() => () => deckTopWatch.current?.disconnect(), []);
```

If the artifacts plan landed first and this block already exists, skip this step.

- [ ] **Step 6: Check in the browser preview**

Run: `npm test` and `npm run build`. Expected: PASS.
Run `npm run dev -- --port 1431` and, in another terminal, `npx vite --port 5174` from any folder with an `index.html` (or a second `npm run dev -- --port 5174` of this repo). In http://localhost:1431/:

1. Code section › + New › Preview. Expected: a pane "Preview" with "Open a page." and the head reading "No page yet". Then Threads section › + New › Preview. Expected: a Preview beside the thread; switch to Code and back: each Preview stays on its own deck, and both come back there after reloading the app.
2. Type `5174` and press Return. Expected: head "Preview · localhost:5174", the page loads.
3. Type `javascript:alert(1)`. Expected: "That isn't a web address. Try e.g. localhost:3000." and nothing loads.
4. Type `github.com`. Expected: "github.com won't load inside the deck." Tick "Always open github.com in my browser"; reload the app; open github.com again. Expected: a new tab opens once, the box stays.
5. Stop the 5174 server. Reload in the Preview. Expected: "Nothing is answering at localhost:5174." and "Checking every 2 s". Start it again. Expected: the page comes back within about 2 s.
6. Click the full-window button. Expected: the page covers rail and deck below the title bar and does **not** reload (type something into a field on the page first; it is still there). Press Esc with focus outside the page (click the bar first). Expected: back in the pane, page unchanged. Go full window again, switch to Threads and back. Expected: no longer full window.
7. ⋯ › Copy address, Rename, Close. Expected: each works; reload the app with a Preview open. Expected: it comes back with its address and loads.
8. + New › Preview twice. Expected: "Preview" and "Preview 2".

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat: Preview panes on the Code deck"
```

---

### Task 8: Servers from terminals and threads, and the chip that opens them

**Files:**
- Modify: `src/TerminalPane.tsx`, `src/ChatPane.tsx`, `src/App.tsx`, `src/styles.css` (append)

**Interfaces:**
- Consumes: `ServerWatch`, `findServerUrls`, `hostLabel` (Task 2); `ServerChoice` (Task 6); `paneSection` (Task 5); `insertBeside(node, targetId, newId, "right")` from `src/layout.ts`.
- Produces: `TerminalPane` and `ChatPane` prop `onServer?: (paneId: string, address: string) => void`.

- [ ] **Step 1: Report addresses from the terminal**

In `src/TerminalPane.tsx`:

- Add `import { ServerWatch } from "./previewAddress";` after the `terminalTitle` import.
- In `interface Props`, after `onRunStart?`, add:

```ts
  /** A local server address the program printed, once per address per run. */
  onServer?: (paneId: string, address: string) => void;
```

- Add `onServer` to the destructured props, and to both `latest` lines: `useRef({ onActivity, onRun, onTitle, onSignal, onRunStart, onServer, cwd, installed })` and the assignment below it.
- In the terminal effect, after `const burst = new Burst();` add `const servers = new ServerWatch();`.
- In `start.current`, after `const id = ptyIdFor(pane.id, next.generation);` add `servers.reset();`.
- In `onData`, after `latest.current.onActivity(pane.id);` add:

```ts
          for (const address of servers.feed(data)) latest.current.onServer?.(pane.id, address);
```

- [ ] **Step 1b: Report the newest server a thread's bots mentioned**

In `src/ChatPane.tsx`:

- Add `import { findServerUrls } from "./previewAddress";` with the other local imports, and `useMemo` to the `react` import if it isn't there.
- In `interface Props`, after `onApprovals?`, add:

```ts
  /** The newest local server address a bot mentioned in a finished reply. */
  onServer?: (paneId: string, address: string) => void;
```

- Add `onServer` to the destructured props in `export function ChatPane({ … })`.
- After the `menuRequest` effect (the block that starts `const lastMenu = useRef(menuRequest?.n ?? 0);` and ends `}, [menuRequest]);`), add:

```ts
  // The newest local server address a bot mentioned, for the chip in the pane head.
  const newestServer = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.kind !== "message" || entry.message.speaker.kind !== "bot") continue;
      const found = findServerUrls(entry.message.text);
      if (found.length > 0) return found[found.length - 1];
    }
    return "";
  }, [entries]);
  useEffect(() => {
    if (newestServer && !profileMode) onServer?.(pane.id, newestServer);
  }, [newestServer, onServer, pane.id, profileMode]);
```

Only finished replies are in `entries` as messages; text still streaming is not, so a half-written address never makes a chip.

- [ ] **Step 2: Keep each terminal's and thread's newest server in App**

In `src/App.tsx`, add `insertBeside` to the `./layout` import and `type ServerChoice` to the `./PreviewPane` import. After the `previewStatus` state add:

```ts
  /** The newest local server address each running terminal printed, and each open thread's bots mentioned. */
  const [servers, setServers] = useState<Record<string, string>>({});
  const onServer = useCallback((paneId: string, address: string) => {
    setServers((all) => (all[paneId] === address ? all : { ...all, [paneId]: address }));
  }, []);
  const forgetServer = useCallback((paneId: string) => {
    setServers((all) => {
      if (!(paneId in all)) return all;
      const rest = { ...all };
      delete rest[paneId];
      return rest;
    });
  }, []);
```

Change `onRun` to forget a terminal's server when its program stops or ends:

```ts
  const onRun = useCallback((paneId: string, run: TerminalRun) => {
    setRuns((all) => (all[paneId] === run ? all : { ...all, [paneId]: run }));
    if (run.state !== "running") forgetServer(paneId);
  }, [forgetServer]);
```

In `closePane`'s `end` function, after `lastOutput.current.delete(id);` add `forgetServer(id);`. In its chat branch, before `takeOff(id);`, add `forgetServer(id);` (the thread reports again when it is opened).

- [ ] **Step 3: Open a server beside its terminal or thread**

After `setPreviewAddress` add:

```ts
  /** Servers from a workspace's terminals and open threads, for a Preview's empty page. */
  const serversFor = (workspaceId: string): ServerChoice[] =>
    Object.entries(servers).flatMap(([id, address]) => {
      const source = panes.find((p) => p.id === id && p.workspaceId === workspaceId && !p.closed);
      return source ? [{ address, source: source.title, sourceId: id }] : [];
    });

  /**
   * Show a server in a Preview right of the terminal or thread it came from,
   * on that pane's deck, or focus the Preview already showing it there.
   */
  const openPreview = (address: string, sourceId: string) => {
    const source = panes.find((p) => p.id === sourceId);
    if (!source) return;
    const deck = paneSection(source);
    const existing = panes.find((p) => p.kind === "preview" && p.workspaceId === source.workspaceId && paneSection(p) === deck && p.url === address);
    if (existing) {
      focusPane(existing);
      return;
    }
    const id = newId("pane");
    const title = nextTitle("Preview", panes.filter((p) => p.workspaceId === source.workspaceId && p.kind === "preview").map((p) => p.title));
    const preview: Pane = { id, workspaceId: source.workspaceId, kind: "preview", title, url: address, servedBy: sourceId };
    if (deck === "threads") preview.deck = "threads";
    const key = layoutKey(source.workspaceId, deck);
    setPanes((list) => [...list, preview]);
    setLayouts((all) => (all[key] && leafIds(all[key]).includes(sourceId) ? { ...all, [key]: insertBeside(all[key], sourceId, id, "right") } : all));
    setActiveWorkspace(source.workspaceId);
    setSection(deck);
    setPicking(false);
    setFocusedPane(id);
    setMaximized(null);
  };
```

(If no layout is stored yet, `sync` adds the new pane as it does for any new pane.)

- [ ] **Step 4: The chip, and the servers list**

In the pane head, after the line that renders the attention `flag` span, add:

```tsx
                    {(pane.kind === "terminal" || pane.kind === "chat") && servers[pane.id] && (
                      <button className="server-chip" onPointerDown={(event) => event.stopPropagation()} onClick={() => openPreview(servers[pane.id], pane.id)} title={pane.kind === "chat" ? "Open in Preview, beside this thread" : "Open in Preview, beside this terminal"}>
                        {hostLabel(servers[pane.id])}
                      </button>
                    )}
```

Pass `onServer={onServer}` to `TerminalPane` and to `ChatPane`, and change `servers={[]}` on `PreviewPane` to `servers={serversFor(pane.workspaceId)}`.

Append to `src/styles.css`:

```css
/* A local server a terminal printed; opens it in a Preview beside the terminal. */
.server-chip { flex: none; padding: 0 8px; border-radius: 999px; background: transparent; color: var(--brand-cyan); font: 11px/20px ui-monospace, SFMono-Regular, Menlo, monospace; }
.server-chip:hover { border-color: var(--button-hover-line, #2b3a4a); }
```

- [ ] **Step 5: Make the stand-in terminal print a server**

The stand-in PTY (search `src/backend.ts` for the stand-in `ptySpawn`) echoes what you type. Check by typing `echo http://localhost:5174/` in a stand-in terminal. If the stand-in doesn't echo typed text back through `onPtyData`, add to its `ptySpawn` a first line of output: `Local:   http://localhost:5174/\r\n` when the agent is undefined (a plain shell), so the chip can be seen in the browser preview.

- [ ] **Step 6: Check in the browser preview**

Run: `npm test` and `npm run build`. Expected: PASS. With a server on 5174 as in Task 7:

1. In a terminal, make `http://localhost:5174/` appear (Step 5). Expected: the head shows a cyan `localhost:5174` chip.
2. Click it. Expected: a Preview opens right of that terminal, head "Preview · localhost:5174 · From Terminal" (the terminal's name), the page loads.
3. Click the chip again. Expected: focus moves to the same Preview; no second one.
4. + New › Preview. Expected: "Servers in this workspace" lists `localhost:5174` with the terminal's name.
5. ⋯ › Close the terminal. Expected: the chip and the list entry go away; the Preview stays.
6. Drag the terminal by its head. Expected: the chip doesn't start a drag when clicked.
7. In a thread, add a Scripted bot whose line is `The site is running at http://localhost:5174/` and send a message. Expected: when its reply finishes, the thread's head shows the `localhost:5174` chip. Click it. Expected: a Preview opens right of the thread on the Threads deck, head "… · From <thread name>". Stop the server and reload the Preview. Expected: "Show thread", and no Start button.

- [ ] **Step 7: Commit**

```bash
git add src/TerminalPane.tsx src/ChatPane.tsx src/App.tsx src/styles.css src/backend.ts
git commit -m "feat: open a terminal's or thread's server in a Preview beside it"
```

---

### Task 9: README and the desktop check

**Files:**
- Modify: `README.md`, `docs/preview-embedding-check.md`

- [ ] **Step 1: README**

In `README.md`, beside the description of terminals, add:

```markdown
- **Preview.** + New › Preview shows a web page beside your terminals or threads. When a terminal prints a local server address, or a bot mentions one in a thread, a chip in its head opens it right of that pane. Stopped servers and sites that refuse to be shown inside another app get words, not a blank box. The full-window button gives the page the whole window; Esc returns.
```

- [ ] **Step 2: Desktop check**

Run `npm run tauri dev` and repeat Task 7 Step 6 and Task 8 Step 6 with a real terminal running `npm run dev` in a real project. Then build as in Task 1 and repeat steps 2, 4, 5 and 6 of Task 7 in the release build. Append each result in one line to `docs/preview-embedding-check.md`.

- [ ] **Step 3: Full checks and commit**

Run: `npm test`, `npm run build`, and from `src-tauri` `cargo test --workspace -- --test-threads=1`.
Expected: all PASS.

```bash
git add README.md docs/preview-embedding-check.md
git commit -m "docs: the Preview pane"
```
