# Browser extensions: what's possible

The docked browser is Electron (Chromium), not WKWebView, so extensions aren't ruled out by the engine.

**What Electron allows.** `session.extensions.loadExtension` loads an unpacked extension folder into a session. It supports only part of the Chrome extension API: content scripts and basic background workers work, but tab, popup and browser-action behaviour mostly does not. There's no Chrome Web Store install; a Deck feature would have to download and unpack each one.

**The iPhone.** The phone's shared browser shows a page running on the machine, so a page's extensions would live on that machine. Native iOS web views can't run Chrome extensions.

**Options.**
1. Build what's wanted into Deck: an ad blocker (Chromium request filtering on the shared profile) and password fill (via a native password manager integration). Small, works, and the set is ours to test.
2. "Load unpacked extension" in Settings, for technical use only, labelled as partly working. Cheap, but ones that rely on missing APIs fail silently.
3. Full Web Store support. Not recommended: it means filling the API gaps ourselves and keeping up with Chromium.

**Recommendation.** Option 1, starting with the ad blocker. Add option 2 only if a specific extension is needed.

**Security.** Any extension can read every page in the shared profile, including signed-in sessions, so option 2 should stay off by default.

This pass builds none of it.
