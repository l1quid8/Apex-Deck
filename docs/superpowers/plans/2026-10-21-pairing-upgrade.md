# Pairing upgrade plan (2026-10-21)

Goal: pairing a phone is one action on each side. Click **Pair phone** on the
Mac, scan (real iPhone) or press one button (Phone tab simulator), approve
once. No copying long links, no Remote access switch to find first, no
service restart that stops working bots.

## What's wrong today

1. The link box hides most of the link with no "…" (`src/styles.css:3250`),
   so it looks complete when it isn't. 124 of 432 characters got copied.
2. The phone app registers `apexdeck://` (`iphone/App/App/Info.plist`) and the
   scene passes the URL to Capacitor (`SceneDelegate.swift:57`), but no web
   code listens. A scanned or opened link launches the app and does nothing.
3. Codes expire after 5 minutes and need **Start again** by hand.
4. Two separate checks: compare the code, then approve.
5. Remote access lives in its own Settings section. When it's off, Pair phone
   flips it on (`ensureRemoteAccess`, `src/pairing.ts:86`), and that
   **restarts the background service, which stops every running bot**, with
   only a one-line notice.
6. The phone app shows a leftover **Remote access** card (Automatic / Direct
   only / Copy ID, `src/phone/PairSheet.tsx:61`) from the relay beta.

## Design

```
Settings
  Phones                         (was "Remote access" + "Paired devices")
    [Pair phone]   Phones can reach this Mac from anywhere · Turn off
                   Phone connections are off · Turn on
    ─ phone rows (access, Revoke) ─
    ▸ Advanced: endpoint ID, UDP port, advertised addresses

Pair phone sheet
  big QR ── "Scan with the iPhone camera"
  [Pair the Phone tab]   (only when the simulator's app can open links)
  Copy link (small)      access + threads (collapsed, "Chat · all threads")
  phone claims → one card: "<name> wants to pair · code 673 149 · Approve / Deny"
```

"Off" closes the phone endpoint, which carries direct and relayed
connections alike. So off means **no phone connects at all, even on the same
Wi‑Fi**, and the words say exactly that ("Phone connections are off"). Pairing
turns it on; the Phones section shows the state with **Turn off** / **Turn on**.

Mockup: `mockups/pair-phone-v2.html` (v1 kept as the approved original).

## Who owns the setting (decided before any task starts)

Today two things are tied together: Remote access on means "the LaunchAgent
runs the daemon with `--remote`" (`desktop/main.mjs:68`, `launchAgent.mjs:46`),
off means "the app runs the daemon as its own child". Flipping the setting
therefore swaps who runs the daemon, which is a restart. That coupling goes:

- **Who runs the daemon:** on a packaged Mac build the LaunchAgent always runs
  it, phone connections on or off. Its plist runs `serve` without `--remote`.
  (Dev builds and non-LaunchAgent setups keep the child daemon, unchanged.)
  Side effect: quitting Deck no longer stops the daemon when connections are
  off. It already doesn't when they're on, which is the Human's normal setup.
- **Where the setting lives:** in the daemon's data folder
  (`remote-settings.json`: `{ "enabled": bool }`), written atomically
  (temp file + rename). The daemon is the only reader and writer.
- **Precedence at boot:** `--remote` on the command line forces on (servers
  started by hand, Hetzner). Otherwise the saved file decides. No file = off.
- **Migration, safe to retry:** while `desktop-settings.json` still has
  `remoteAccess`, the app sends `remote_set { enabled, import: true }`. The
  daemon applies an import **only when it has no saved setting**; otherwise it
  ignores it and returns the current state. Applying it writes
  `remote-settings.json` in one atomic write, and that file existing is the
  "migration done" mark, so the setting and the mark can't disagree. The app
  then deletes the key. If the delete fails, the next launch re-sends the
  import and the daemon ignores it, so an old value can never overwrite a
  newer setting. Clean cut-over, no fallback read afterwards.
- **Quit:** app quits, agent daemon keeps running with whatever it saved.
- **Crash:** launchd restarts the daemon; it reads the saved file and comes
  back in the same state. A save that failed never reported success, so there
  is no "UI says off, reboot says on" case.
- **The upgrade itself** moves a child daemon to the LaunchAgent once. That is
  an install-time restart, which installs already cause; nothing after it does.

## Tasks

### Task 0. Remove the phone's Remote access card

- Delete `RemoteSettings` from `src/phone/PairSheet.tsx` and its use at
  `src/phone/PhoneApp.tsx:1498`.
- **Keep QR pairing working.** Today the `remote` prop on `Machines`
  (`PhoneApp.tsx:2505`) doubles as "QR pairing is possible": it picks the
  default `how` (`qr` vs `address`) and shows the QR/address selector. Replace
  it with a separate `pairing: boolean` flag (native plugin present), and drop
  the `remote` prop.
- Phone always runs Automatic: drop `mode` state, `changeMode`,
  `loadRemoteMode`/`remoteModeKey` (`src/phoneRules.ts:266-275`). On launch,
  remove `apex-deck.phone.remote-mode.v1` and call `plugin.setMode("automatic")`
  once, held in one `automaticReady` promise.
- **Every connect and pair call awaits `automaticReady`.** If `setMode` fails,
  connecting and pairing show "Couldn't set up phone connections: <reason>"
  instead of silently running in whatever mode the library had.
- The mode key is deleted, not read, so Direct only can't come back; nothing
  writes it any more.
- Keep the native `setMode` for now (one call site); removing Direct only from
  `crates/iroh-mobile` is a follow-up.
- Remove the "Switch to Automatic" line in `src/daemon/irohLink.ts:23`, and the
  stale relay-beta words in `src/phone/pairing.ts:77` ("this phone has to be on
  the relay's list first"). The relay is open to everyone.
- Fix the hint at `PhoneApp.tsx:2615` to "Settings → Phones → Pair phone".
- Tests: QR stays the default and the selector shows with the card gone; a
  failed `setMode` blocks connect and pair with the message; the old key is
  removed on launch.

### Task 1a. Daemon owns the setting; LaunchAgent always runs it

Implements "Who owns the setting" above. No live switching yet.

- Daemon: read/write `remote-settings.json`; boot precedence as above.
- **1a and 1b merge and ship together.** 1a alone would boot the agent
  daemon with no saved file (off) and nothing to import the old value live.
  They stay separate branches and reviews; the integrator merges 1a then 1b in
  one go, and no build is made between them.
- Desktop: `agentWanted()` no longer depends on `remoteAccess`; the plist drops
  `--remote`; `startAgent`'s "is it the agent" check (`launchAgent.mjs:191`)
  stops requiring `remote.endpoint_id`.
- Migration is **not** here; it uses `remote_set`, so it lives in 1b.
- Tests: boot with file on / off / missing / `--remote` + file off.

### Task 1b. One endpoint controller, switched live

Replaces `Daemon.endpoint: OnceLock<iroh::Endpoint>`
(`crates/apex-daemon/src/protocol.rs:74`), which can be set once and never
cleared, with one controller:

```
RemoteController { state: tokio::sync::Mutex<Option<Running>> }
Running { endpoint, accept: JoinHandle, info }
```

- **Serialized:** every `remote_set`, `remote_info`, `pair_start` takes the
  same lock, so on/off requests run one at a time in order.
- **on while on:** returns the current info. Same endpoint, connected phones
  untouched.
- **off while off:** returns off. No work.
- **off**, all under the controller lock: save `enabled: false` **first**.
  If the save fails, return the error with the endpoint and every open
  invitation untouched. Only after the save: cancel open invitations (claims
  in flight get `ended: "cancelled"`), `accept.abort()` then await the
  aborted `JoinHandle` so the task is really gone, `endpoint.close().await`,
  drop the `Running`. Only then report off. Phones are disconnected on
  purpose.
- **on:** bind the endpoint on the saved port, then save `enabled: true`, then
  spawn `accept` and store `Running`. If the bind fails, the state stays off and
  the error names the cause ("UDP port 41641 is in use"). If the save fails
  after binding, close the new endpoint and return the error.
- **Rebinding the same port:** off awaits `close()` and drops every clone the
  daemon holds (`pair_commands.rs:78,159` take a clone under the lock and
  don't keep it) before returning, so a following on can bind the port. One
  short retry on "address in use", then fail as above.
- **Truthful `remote_info`:** reads the controller, never a cached value;
  reports `enabled`, and endpoint/port/addresses only while on.
- `pair_start` while off returns `not_remote`, as today.
- `remote_set` is refused from a phone, like the other pair commands.
- **Migration** (see "Who owns the setting"): `remote_set` takes an optional
  `import: true`, applied only when no `remote-settings.json` exists. Desktop
  sends it while its old `remoteAccess` key exists, then deletes the key.
- Desktop: `remoteAccess.set` (`desktop/remoteSwitch.mjs`) calls `remote_set`
  instead of restarting; `restarting` and `NOT_OWNED_WORDS` go away. Keep
  `serve --remote` for servers started by hand.
- Unit tests: on/on keeps the same endpoint id and a connected test peer stays
  connected; off then on rebinds the same port; off cancels an open invitation;
  bind failure and save failure each leave state and file unchanged;
  concurrent on/off/on settles in request order; a failed "off" save leaves
  both the endpoint and an open invitation alive; an import with a saved file
  present changes nothing; an import, a failed key delete, then a later user
  "off" and a re-sent import ends off.
- **Acceptance on the real app** (the reason the task exists; a mocked
  "restart wasn't called" test isn't enough): with a bot mid-reply and a phone
  connected, toggle off → on → off → on from Settings. Record `boot_id` from
  `daemon.json` before and after (must match), confirm the bot's reply finished,
  and confirm the phone reconnects after each on. Done on a throwaway daemon
  first, then once on the Human's Mac only with their go.

### Task 2. Fold Remote access into Phones

- Merge `RemoteAccessSettings` into `PairedDevicesSettings`; rename the
  section `devices` → `phones`, label **Phones**. Remove the `remote`
  section id outright (clean cut-over, no alias). Settings links that pointed
  at `remote` point at `phones`.
- Top row: **Pair phone** button, then one status line:
  - on: "Phones can reach this Mac from anywhere." + **Turn off**
  - off: "Phone connections are off." + **Turn on**. With saved phones, a
    second line: "Paired phones stay saved but can't connect, even on the
    same Wi‑Fi." With none: "Pairing turns them on." and no button.
- Endpoint ID, UDP port and advertised addresses move into a closed
  **Advanced** disclosure under the phone list, shown only while on. Same
  controls, same calls.
- Revoking the last phone asks once: "No phones are paired. Turn off phone
  connections too?" with **Turn off** / **Keep on**.
- `ensureRemoteAccess` stays the one place Pair phone turns it on, now instant
  (Task 1b). Success shows "Turned on phone connections so your phone can
  reach this Mac. Nothing was restarted." Failure shows the daemon's reason
  with **Try again**, and the QR is not shown.
- `endedWords("not_remote")` becomes "Phone connections are off. Turn them on
  in Settings → Phones."
- Depends on 1a + 1b.

### Task 3. The phone app opens pairing links

- Add `@capacitor/app` (matching the project's Capacitor major) and one small
  module, `incomingLinks`, as the only place links enter the app:
  - **Listener first:** register the `appUrlOpen` listener *before*
    awaiting anything, so a link that arrives during startup isn't lost.
  - **Cold start:** then `await App.getLaunchUrl()` *before* deciding
    `autoScan`. If there's a pairing link, the camera scanner does not open.
  - **Duplicates:** iOS can deliver the same cold-start link through both.
    Keep the link currently in flight; the same link arriving while it's in
    flight is dropped. A **different** link while one is in flight is refused
    ("Already pairing; finish or cancel that first.").
  - **Retry allowed:** when an attempt ends without pairing (cancelled,
    denied, connection failed), it's released, so tapping the same
    still-valid link again works. Only a link that paired successfully is
    remembered and dropped if it shows up again this session.
  - **From any screen:** a link switches to Machines, opens Add a machine with
    kind Mac, and calls the existing `pairWith` (`PhoneApp.tsx:2526`). No
    second validation or pairing path.
- `pairWith` already goes through `parsePairingLink` and the Mac's claim +
  approval, so a scanned or opened link can never pair without the Human
  pressing Approve on the Mac. Nothing in this task touches that.
- Result: on a real iPhone the **Camera app** can scan the QR too.
- Needs a phone build. Bump `CFBundleVersion`; Task 4 reads it.
- Tests: cold-start link (scanner stays closed, pairing starts); warm link
  from Threads and from Settings; same link via both sources at once pairs
  once; a link delivered during startup (before `getLaunchUrl` resolves) is
  handled; cancel then the same link again starts a new attempt; a temporary
  connection failure then the same link again works; a second link
  mid-pairing is refused; malformed link → existing "not a
  pairing link" words; expired link → existing expired words.
- Can run in parallel with the daemon work.

### Task 4. Pair the Phone tab

- In the Pair phone sheet, show **Pair the Phone tab** only when Deck's
  simulator is booted **and** its Apex Deck app's `CFBundleVersion` is at
  least the Task 3 build. If the app is older, show the button disabled with
  "Its Apex Deck app can't open pairing links yet. Install the latest build on
  the simulator first." No typing fallback: `simctl openurl` succeeding
  doesn't prove the app acted on the link.
- The button is a human phone action: it takes the phone the same way the
  Human's taps do (bot pauses, Human wins), then calls the host's `open URL`
  (`crates/apex-host/src/phone/mod.rs:513`) through a new renderer → host call.
- **The link is a secret.** The new call returns only ok/error, never echoes
  the link. Host and phone logs record "opened a pairing link", not the URL.
  It must not appear in the phone activity bots can read.
- After opening, the sheet waits for the claim as usual; success is the
  claim arriving, not the openurl result.
- Depends on Task 3 being built and installed on the simulator.
- Tests: hidden when no simulator; disabled with the words on an old build;
  the call's result and logs carry no link text; it takes the phone from a
  driving bot.

### Task 5. Sheet polish

- QR becomes the hero: 260px, centred, "Scan with the iPhone camera or the
  Apex Deck app."
- Hide the link text. Keep a small **Copy link** button. Never show a
  truncated link again.
- Access + threads collapse to one line ("Chat · All threads · Change"),
  expanded on click. Same controls as now.
- **Auto-renew**, without races:
  - Renew only when the daemon reports the invitation **expired and
    unclaimed**. A claim that arrived before expiry is claimed; the sheet shows
    the approval card, never a new code. The daemon is the judge, not the
    sheet's timer.
  - Each renewal gets an attempt number; a response from an older attempt is
    ignored in the UI **and its invitation is cancelled**, so a slow reply
    can't replace a newer code or leave a live code nobody shows.
  - The new invitation uses the same tier and threads.
  - The 30-minute limit counts from when the sheet opened, across all
    renewals; after it, show **Start again**.
  - Closing the sheet cancels the timer and any open invitation, including a
    renewal still in flight (cancelled when its reply lands).
- One approval card: phone name, the 6-digit code large, the access it gets,
  **Approve** / **Deny**. Text: "Approve if your phone shows the same code."
  Keeps today's `revokedWarning` line ("You revoked this phone on … Approving
  lets it back in.").
- A **Paired** state: "<name> is paired", its access, **Done**.
- Tests: expiry with no claim renews with the same tier/threads; a claim
  landing at the expiry instant shows the approval card and no renewal; a
  stale renewal reply is dropped and its invitation cancelled; close during renewal cancels both
  invitations; renewals stop at 30 minutes.

### Task 6 (optional, later). Short code via the relay

For a phone with no camera and no Deck driving it. The Mac stores the full
link on the relay under a 6-digit code for 5 minutes; the phone fetches it.
Needs relay work and its own security review. Not started unless asked.

## Order and ownership

```
0 ─────────────────────────────┐
[1a + 1b, merged together] → 2 → 5  ├→ 4 (after the Task 3 build is on the simulator)
3 (phone, in parallel) ────────┘
```

1a and 1b are the risky part (daemon lifetime, endpoint restart); each gets a
Rust review and the real-app acceptance check before merge. Every task is its
own branch; one integrator merges.

## Out of scope

- Changing what a paired phone may do (tiers, threads).
- The server (`apex-daemon pair`) flow.
- Removing Direct only from the native iroh library.

## Open checks before building

- Confirm an iroh endpoint can be closed and a new one bound on the same UDP
  port in one process (Task 1b), with a small spike test. If it can't, off
  must still drop every phone connection (close each connection and stop
  `accept`) while the endpoint stays bound; the words stay the same.
- Confirm `@capacitor/app` matches the project's Capacitor major version.
