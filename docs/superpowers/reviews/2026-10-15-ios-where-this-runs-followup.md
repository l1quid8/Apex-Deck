# iOS “Where this runs” sheet follow-up

The location sheet now uses a centered title with a circular close target, grouped Project and Machine choices, clearer online/offline metadata, and a subtle accent treatment for the current machine. Lock guidance follows the choices, then a short note clarifies that files stay on each machine. The unavailable “work without a project” placeholder was removed rather than promoted as an action. Existing project and machine selection callbacks and offline-row behavior remain in place.

Implementation commits: `8dab804`, followed by safe-area/close styling correction `3ef899e`.

Validation: Luna's TypeScript, focused tests, phone asset build, and diff checks passed. One artifact-frame-runtime test failed in Luna's full suite and passed standalone. The parent's independent full rerun passed all 1,465 tests. After the final CSS correction, the parent reran TypeScript and 36 destination/phone/composer model checks successfully.

The parent built and installed the signed Debug iPhone simulator app, verified its strict code signature and all 13 web asset hashes, and inspected the final Frost layout on iPhone 17 Pro/iOS 26.5. Native inspection confirmed grouped choices, the current machine's accent/check/status, circular close styling, and clearance above the home indicator. Change project opens the existing project picker; no project/machine change or test message was submitted. The final location sheet remains open in the simulator.

Native before/after captures: `/Users/tylercaldwell/Downloads/apex-deck/release/ios/composer-panel-preview/location-before.png` and `location-after.png`. Logs: `/tmp/apex-ios-location-{sync,build,tests,focused}.log`. Classic/Liquid/short-viewport and multi-machine variants were reviewed through scoped CSS and preserved callback logic, rather than exercised in the paired simulator during this follow-up.

Primary checkout remains on main with its four existing untracked files preserved. No merge, push, DMG rebuild, or TestFlight upload occurred.
