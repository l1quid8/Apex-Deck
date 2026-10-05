## 8. Remote control and the Electron shell

Design: `docs/superpowers/specs/2026-10-05-remote-and-electron.md`.

| Feature | State |
|---|---|
| Embedded Chromium browser that agents drive over CDP (Electron spike in `spikes/electron-browser/`) | proven by spike |
| Rust host logic moved out of `src-tauri` into an `apex-host` crate; session and settings owned by Rust | next |
| `apex-daemon` daemon: WebSocket listener and `--stdio` mode, one JSON protocol with event sequence numbers and replay | next |
| Electron desktop shell: React UI unchanged, talks to `apex-daemon`, browser pane as a `WebContentsView` | later |
| QR pairing, device keys, Settings → Devices, per-device permissions | later |
| Phone app: SSH transport, iroh transport across NAT, mobile layout | later |
| Push notifications for approvals; switching between several hosts | later |
