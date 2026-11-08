Native command-boundary acceptance uses the production Swift plugin and
TypeScript guard with a counting transport. Authentication is real; no machine
is paired and no daemon command is executed. This does not prove the complete
paired-phone settings UI or physical-device Face ID.

1. Read `"$APEX_DECK_BIN" phone help`, then get the shared simulator UDID from
   `phone status`. Respect the phone's driver ownership.
2. Run `node tests/native-phone-biometric/build.mjs <UDID>`. The current native
   framework must already exist; this does not rebuild Rust mobile sources.
3. Use `phone install <printed App path>`, then
   `phone launch dev.apexdeck.biometricacceptance` and `phone look`.
4. With enrollment off, tap Send: expect BLOCKED and Sent: 0.
5. Enable simulator biometric enrollment. On this Deck simulator the notification
   is `xcrun simctl spawn <UDID> notifyutil -s com.apple.BiometricKit.enrollmentChanged 1`,
   then `notifyutil -p com.apple.BiometricKit.enrollmentChanged` on that simulator.
6. Tap Send: expect a native Face ID prompt and Sent: 0. Use `phone biometric fail`:
   the native retry/cancel dialog must have no passcode fallback. Cancel: expect
   BLOCKED and Sent: 0.
7. Tap Send again, observe its fresh prompt, and use `phone biometric match`:
   expect AUTHENTICATED and Sent: 1.
8. Tap Send again: expect a fresh prompt and Sent: 1. Fail and cancel: expect
   BLOCKED and Sent: 1. Disable enrollment and repeat: still BLOCKED and Sent: 1.
9. Restore the simulator's original enrollment, return home, and run `phone done`.

The companion `tests/phone-biometric-transport.test.mjs` covers typed/raw routes,
the real phone backend/daemon framing, intent capture, concurrent attempts, and
classification drift with simulated native responses.
