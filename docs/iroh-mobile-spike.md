# iPhone iroh spike

Milestone 1 test harness, not production remote access. Uses iroh 1.3.0 and
only `https://relay.apex-terminal.xyz`. It does not implement pairing,
permissions, recovery, or daemon command transport.

## Build

From the repository root:

```sh
scripts/build-iroh-mobile.sh
scripts/iroh-mobile-local-wiring.sh enable
VITE_IROH_SPIKE=1 node scripts/build-phone.mjs
npx cap copy ios
xcodebuild -project iphone/App/App.xcodeproj -scheme App -configuration Debug -destination 'generic/platform=iOS Simulator' build
```

The normal Xcode project has no dependency on the spike package or generated
XCFramework, so fresh checkouts build without Rust. The explicit local wiring
patch enables the package and test controller only for hardware testing. Its
Swift compile guard rejects Release builds, including archives. Disable it before
committing or preparing a normal build:

```sh
scripts/iroh-mobile-local-wiring.sh disable
npm run iphone:sync
```

Do not commit the locally patched project or SceneDelegate. The generated
XCFramework is ignored; device and arm64 Simulator slices are included, while
Intel Simulator is unsupported. The web screen also requires `VITE_IROH_SPIKE=1`.
`iphone/IrohSpike` remains a separate local Swift package.
A small C ABI wraps Rust instead
of duplicating all of iroh's generated Swift bindings. Calls run on a serial
background queue, with bounded connection (20s) and ping (5s) timeouts. The
Rust runtime persists for the process; stop closes the endpoint.

The secret key is generated natively and stored in device-only, when-unlocked
Keychain storage under a spike-specific service. Only the public endpoint ID
is shown to JavaScript. This is not the production paired identity. Every
endpoint disables automatic router port mapping. Automatic uses only our
relay, with no default discovery service. Direct only disables the relay and
strips relay hints from the host address. Switching modes closes the previous
endpoint and imports the same Keychain key.

`libc` is pinned to 0.2.186, matching the upstream iroh Swift release lockfile:
0.2.190 removes iOS BSD definitions still referenced by netwatch and netdev.
There are no vendored dependency changes. Revisit this pin with upstream fixes.

## On-device test

1. Start the phone endpoint. Copy its ID and approve it on the beta relay
   allowlist using the existing operator procedure.
2. Run the existing `iroh-spike listen --key <owner-only-key-file> --relay
   https://relay.apex-terminal.xyz` on the Mac or VPS. Keep its address JSON.
3. Paste that JSON into the test screen, connect, and watch Direct/Relayed and
   ping latency. The listener must stay running. This is a manual address input
   for the networking spike; the production flow will use QR pairing.
4. Repeat on cellular, switch Wi-Fi/cellular, test relay rejection for an
   unapproved ID, and measure relay memory/CPU/bandwidth.
5. For Direct only use `--relay none --port <UDP-port>` on the listener and an
   address containing a reachable IP and port. Test identity continuity, forced
   path changes, relay-side packet captures and absence of router mappings.
6. Test an Automatic listener with a Direct only phone before deciding the
   production host listener architecture. Passing a loopback test does not
   establish that mixed-mode path selection is safe on real networks.

Do not upload this encryption-enabled build to TestFlight until export
compliance is assessed for the bundled Rust crypto. Do not assume that adding
iroh automatically changes the exemption answer, or retain the previous answer
without checking. Normal Release builds do not link iroh; locally enabled spike wiring rejects
Release compilation.

## Verification record

Verified locally: five Rust tests passed (invalid keys, stripping relay hints,
requiring a direct address, rejecting other relays, and authenticated direct echo
with identity retained on mode change); the main web app TypeScript/build passed.
The generated iPhone and arm64 Simulator libraries built, and complete Debug
Xcode builds passed for both generic iOS (unsigned) and the iPhone 17 Simulator.
The Simulator app installed and launched. UI interaction was not verified:
computer-use could not attach to Simulator. Physical cellular/path-switch
and relay load tests remain outstanding; this does not complete milestone 1.

Implementation ruling: the thin bridge uses a two-function C ABI rather than
uniffi for this echo-only spike. This avoids generating an entire binding surface;
the cost is that a production message/event API will need a reviewed, versioned
bridge with explicit ownership and cancellation. No production transport uses
this spike. A separate fresh-context reviewer could not be started because the
collaboration tool returned a thread-context error; an independent review remains
outstanding before promotion into production.
