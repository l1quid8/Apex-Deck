# Apex Deck · iOS design review

A standalone React + TypeScript + Vite prototype. All pairing, keys, messages,
permissions, approvals, browser clicks, and terminal input are simulated in
memory. Refresh resets them. No network transport, native bridge, Rust, camera,
keychain, filesystem access, or real host integration is present.

```sh
cd mockups/ios
npm ci
npm run dev -- --port 5187
```

Open http://127.0.0.1:5187. The screen index is always available on a desktop;
on a narrow display focus its controls to expand it. Hash links open each screen
directly, including the notification approval. Dark/light and larger text apply
across the prototype. Screenshots are available in `screenshots/index.html`.

## Design brief

The phone is a remote client of a host, either Electron desktop or apex-daemon.
Select a host, then use the bottom navigation **Agents | Code | Threads | Library**.
Agents shows the host-managed team, models, reasoning, persona, and reply policy.
Code groups workspace files, proposed changes, terminal output, and browser previews.
Threads opens the workspace’s conversations, with shared chat nested inside it.
Library collects saved images, design notes, and build output. The four destinations
retain their active tab while drilling down: terminal/browser belong to Code;
a conversation belongs to Threads. This makes the phone mirror Deck’s main sections
without copying the desktop layout.

Pairing offers QR, SSH, and LAN discovery, followed by identity confirmation.
LAN discovery is not authorization. QR simulates the `apexdeck://pair?…` URI,
with a one-time five-minute token. SSH simulates host, port, user, a key picker,
and key generation. Its confirmation shows an SSH host-key fingerprint.

Chat remains a shared multi-agent transcript. Agents have separate identities,
model hints, and a visible reply policy. Mentioning someone selects the intended
recipient without hiding the message from others. Attachments, outgoing messages,
and a time-based sample streamed reply make the core interaction inspectable.

Approvals show the agent, host, thread, file/command preview, and rule scope.
A request appears inline in chat, with a full-screen notification route for
review. Approve, deny, and a scoped “Always” confirmation have mock feedback.
Terminal output is read-only unless reviewing the explicit full-permission
variant. Browser control is a proposed explicit handoff, with give-back.

Open questions for product review:

- Does v1 need a raw SSH shell, or only a Deck terminal reached through SSH?
- Should browser input require full permission? This design assumes yes.
- Should “Always” be available on a phone for every desktop approval kind?
- How should concurrent browser control be leased or reclaimed by the host?
- Which push-notification detail can appear on a locked device?
- Should an imported SSH key be restricted to one host?

These questions do not select Tauri mobile or Capacitor.

## Decisions made for this review

1. Host-scoped bottom tabs in the requested order: Agents, Code, Threads, Library.
2. Default device access is chat + approvals. The phone cannot promote itself.
3. Identity confirmation follows every pairing path. Sample fingerprints are fake.
4. “Always” uses a second sheet and names its scope before confirmation. Sample
   edit scope is one named file, one agent, one thread, one host; sample command
   scope is the exact command. Production must match the host’s actual rule logic.
5. All room participants can see messages. Default response policy is reply when mentioned.
6. The host owns work while offline; reconnecting replays missed events before live updates.
7. Browser screenshot and attachment artwork are local SVG fixtures, explicitly labeled.
8. Notifications are an on/off preference; permission requests go to the host, not a local upgrade.
9. Unpair is scoped to one host and uses a confirmation sheet.
10. No real haptics or native camera behavior: native handoff notes are source comments.

## Visual handoff

Desktop references: `src/styles.css`, `src/ChatPane.tsx`, `src/ApprovalCard.tsx`,
`src/approvalChoices.ts`, and `src/DeckIcon.tsx`. None are modified.

The public GitHub checkout used for this branch did not yet contain SPEC section
8 or the requested remote spec. They were read from the existing local
`/Users/tylercaldwell/Downloads/apex-deck` checkout; exact review copies are saved
in `reference/`. The remote design remains the authority over mockup assumptions.

| Token      | Dark    | Light   | Use                                |
| ---------- | ------- | ------- | ---------------------------------- |
| `--bg`     | #090d12 | #f2f5f7 | Canvas                             |
| `--panel`  | #0e141b | #ffffff | Cards, sheets                      |
| `--panel2` | #151e28 | #e9eff3 | Human messages, secondary surfaces |
| `--text`   | #e4eaf0 | #12232d | Primary text                       |
| `--muted`  | #91a0af | #526371 | Metadata                           |
| `--mint`   | #71e6b5 | #087552 | Accent, primary buttons            |
| `--amber`  | #f7b74f | #915900 | Requests needing attention         |
| `--red`    | #f87171 | #b42b39 | Deny, error, removed lines         |

Frame: 393 × 852 CSS pixels. Top safe region: 59; home region: 34. Content:
22-point side insets; card radius: 17–18; sheet radius: 26. System font maps to
San Francisco on iOS. Main large titles are 34, body 14–15; metadata is smaller
and should map to native text styles in production. Use rem/native preferred
styles when implementing; the larger-type review mode grows content while
keeping the frame and controls stable. Content scrolls independently of composer,
tool switcher, and safe areas. On real narrow browser viewports, the frame fills
the device and honors `env(safe-area-inset-*)`.

Gestures: an edge swipe right returns one level; visible back buttons provide the
same action. Sheets dismiss with close, backdrop, or Escape. Dialog focus is
contained and restored. No swipe-to-deny or gesture-only destructive actions.
Native haptic handoff: selection on tools; success on pairing; warning on review;
no repeated haptics for streaming tokens. Motion is minimal and reduced-motion
friendly. Native sheet drag and OS push launching are represented by review
routes, not implemented device APIs.

## Verification and capture

```sh
npm run build
# With the dev server running:
npx playwright install chromium
npm run capture
```

`capture` takes dark and light phone screenshots of all 23 routes, the review
index, larger chat text, and the always-allow sheet. It audits WCAG A/AA rules
with axe, phone touch-target dimensions, horizontal overflow, JavaScript errors,
and the core click flows. Its result is `verification.json`. The script reports
failures and exits nonzero if those automated checks fail.

VoiceOver labels, semantic buttons, labeled fields, image alt text, status
announcements, and visible focus indicators are present. Native VoiceOver,
actual Dynamic Type categories, hardware keyboard behavior, and system permission
prompts still need testing when an iOS framework is selected; browser checks do
not establish that native validation.

Source and screenshot artifacts are only in `mockups/ios/`. No product behavior
or host integration is implemented by this branch.
