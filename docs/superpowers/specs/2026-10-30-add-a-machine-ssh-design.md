# Add a machine over SSH: design

Status: design approved by the Human on the mockup `mockups/local-chat-jigga.html`
(source `mockups/local-chat-jigga/main.tsx`). Not started. Null cleared the mockup.

## Goal

From the iPhone, a person turns any Linux server they can SSH into into a
paired Deck machine with one Connect button. SSH is used once, to set up. After
that the phone uses the normal paired link, and chats never touch SSH.

The desktop shares the setup code but keeps SSH as its live link
(`ssh <host> apex-daemon --stdio --attach`, `src/ConnectionDialog.tsx`).

## Screen

Add a machine has two choices: **QR code | Remote SSH**. This replaces the
Mac/Server selector, the `h-…` Id box and the Address/token fields
(`src/phone/PhoneApp.tsx`, the "Add a machine" form).

**QR code:** Scan, or "Or paste the pairing link". The name comes from the code,
then a 6-digit match and Approve on the machine.

**Remote SSH:**

- Label (optional). Becomes the machine's name everywhere.
- IP or host. Strips `https://`. Parses `host:port` and `[addr]:port` for IPv6.
  Refuses malformed values and ports outside 1-65535.
- User, and Port (22).
- Password (optional; also used for sudo).
- Import private key from Files. The phone can't read `~/.ssh`, so the person
  AirDrops the key to Files. A passphrase box appears only for encrypted keys.
- After setup: **Forget sign-in** (default; wipes Deck's copy, the original file
  is untouched) or Keep with Face ID.
- No startup snippet, and no "Where is apex-daemon?" box.

## Connect flow

No prompts. One Connect button, then a list that runs by itself. It stops only
for a real failure.

1. Reached server.
2. Server key checked, before any credentials are sent. First use trusts the
   fingerprint. A changed key stops the flow.
3. Signed in.
4. Found OS and architecture.
5. Installed, updated or already up to date. Downloads are checked against the
   release checksums (`apex-daemon-linux-x86_64`, `-arm64`). An existing service
   is updated in place.
6. Bubblewrap installed, if sudo is available.
7. Started Deck, set to start on boot.
8. AI tools installed. Any that need signing in are marked.
9. Paired and saved. This happens before Done, survives the sheet being
   dismissed, and a retry reuses the same request.
10. Signed out and sign-in wiped.

Cases:

- **No password, or sudo refused:** user-only install, bubblewrap skipped.
- **Updating while bots reply:** the new version installs but switches only when
  idle. The machine shows "Updating Deck" and messages wait.
- **Bots not ready:** they show "needs sign-in" (with a Sign in button) or "needs
  bubblewrap (admin)". They never receive messages, and a notice appears under
  the message.

## What the machine must already do

- Linux room actions over SSH work in a plain release. That is
  `fix/platform-close-out`; before it, only the updater's carried patch on
  Apex-Terminal had this.
- The updater's guard in `scripts/vps_update_compat.py` hashes the admission
  code. Any change to `call_with_client_capability`, `admit`, `is_room_admin` or
  the Linux prefix of `call_from_device` makes machines running the installed
  updater refuse the release. Change them together with the updater recipe.

## Open decision: phones on Linux

A paired phone has no protected room actions on Linux. Allow, answering a
question, new Work threads and changing a bot's model, reasoning or Speed all
need a receipt, and Linux has no broker to give one, so `call_from_device` refuses
them. Chats avoid this with their own `chat_*` commands. Work threads don't.
A bot below Full access in a Work thread on a headless machine therefore waits
for an approval the phone can't give.

Recommendation: let a phone do what its tier already allows for Allow, answers,
plans, and model, reasoning and Speed. Keep anything that picks a folder or raises
a bot's access behind the machine's own folder list or a Mac over SSH.

This is the Human's call and needs Null's review. It was a deliberate gate: the
updater's installed test `scripts/vps-update-allow-test.rs` asserts these phone
calls are refused, so the release that changes it must change the recipe on the
server first. `Host::device_folder_command` is the place for it, because it sits
outside the hashed admission code.

## Known unknowns

1. **Headless pairing.** `apex-daemon pair` (`crates/apex-daemon/src/pair_cli.rs`)
   prints the link, waits for a claim, and asks `Approve? [y/N]`. The phone can
   answer over SSH, but it needs machine-readable output, and remote access must
   be on.
2. **User-only install after sign-out.** Whether a user-only service survives SSH
   sign-out (lingering). Test with a throwaway user on Apex-Terminal once the
   Human says yes; otherwise setup checks and reports it.

## Evidence so far

A throwaway "SSH Key Test" app on the iPhone 16 Pro, using the Human's ed25519
key (OpenSSH format, with a passphrase), passed on the Human's report: key
unlocked, server key matched, signed in, Linux x86_64 and the daemon path shown,
signed out, and a wrong passphrase sent nothing. The test app has been removed.

## Build order

Each part goes on its own branch with Null's review.

1. Phone screens.
2. SSH sign-in, using the library that passed the key test.
3. Silent setup.
4. Machine-readable pair output.
5. AI-tool sign-in, after the rest.
