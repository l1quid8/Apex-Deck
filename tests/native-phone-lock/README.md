Native app-lock acceptance uses the production Swift lock and the production command guard with a
counting transport. The Face ID prompt, the cover and the app-switcher snapshot are real; no machine is
paired and no daemon command is executed. It does not prove the paired-phone settings screen on a
physical iPhone.

1. Read `"$APEX_DECK_BIN" phone help`, then get the shared simulator UDID from `phone status`. Respect
   the phone's driver ownership.
2. Run `node tests/native-phone-lock/build.mjs <UDID>`. The current native framework must already
   exist; this does not rebuild Rust mobile sources.
3. Use `phone install <printed App path>`, then `phone launch dev.apexdeck.lockacceptance` and
   `phone look`.

**No prompt on a command**

4. Tap "Send a thread delete". Expect `SENT with no prompt. Sent: 1` — no Face ID sheet, no passcode
   request. This is the whole point of the change: the machine decides, the phone sends.

**The lock**

The lock needs a passcode to exist at all. A fresh simulator usually has none, so:

5. In the simulator: Settings → Face ID & Passcode → Turn Passcode On. Then enable biometric
   enrollment on this Deck simulator:
   `xcrun simctl spawn <UDID> notifyutil -s com.apple.BiometricKit.enrollmentChanged 1`, then
   `notifyutil -p com.apple.BiometricKit.enrollmentChanged` on that simulator.
6. Relaunch the fixture. Tap "Lock status": expect `enabled: true` (on by default) and
   `available: true`. Tapping "Turn the lock on" also locks immediately.
7. Expect an opaque cover with a lock, and the Face ID prompt over it. Use `phone biometric fail`:
   the prompt falls back to the passcode instead of shutting the app out. Cancel: the cover stays and
   shows **Unlock**.
8. Press home, then open the app switcher: the card shows the cover, not the test page. Open the app
   again and use `phone biometric match`: expect the cover to lift.
9. Background the app for more than a minute, return: the cover is back and it asks again. A quick trip
   out and back (under a minute) does not lock.
10. Tap "Unlock" on the cover after cancelling, then `phone biometric match`: the app opens. Tap
    "Lock status" and confirm `locked: false`.

**Turning it off**

11. With the lock on and the app open, turn the switch off (Settings → Lock) — the cover goes and it
    does not ask again until it is turned back on. `Lock status` should read `enabled: false`.
12. Restore the simulator's original enrollment and passcode, return home, and run `phone done`.

The companion `tests/phone-command-guard.test.mjs` covers every daemon raise reaching the real wire with
no native call, and `tests/phoneAppLock.test.mjs` covers the Settings switch and what the app reports.
