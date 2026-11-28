import Capacitor
import Network
import OSLog
import UIKit
import WebKit

/// Route WebKit network traffic to a locally reserved TCP port that never
/// listens. Holding the socket prevents another process from serving it.
private final class WidgetNetworkDeny {
    private let socketFD: Int32
    let proxy: ProxyConfiguration

    init() throws {
        let fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
        guard fd >= 0 else { throw WidgetError.unavailable }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &address) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, length) == 0 && getsockname(fd, $0, &length) == 0
            }
        }
        guard bound, let port = NWEndpoint.Port(rawValue: UInt16(bigEndian: address.sin_port)) else {
            Darwin.close(fd)
            throw WidgetError.unavailable
        }
        socketFD = fd
        var config = ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: port))
        config.allowFailover = false
        proxy = config
    }

    deinit { Darwin.close(socketFD) }
}

private final class WidgetRun {
    let id: String, key: String, revision: String
    let card: [String: Any]
    let clipView = UIView()
    var bounds: CGRect = .zero, clip: CGRect = .zero
    weak var chatScrollView: UIScrollView?
    var scrollObservation: NSKeyValueObservation?
    var viewport: CGRect = .zero
    var measuredOffset: CGFloat = 0
    var previewPending = false, previewDirty = false, hasPreview = false
    var content: WKWebView?
    var childFrame: WKFrameInfo?
    var savedJSON: String?
    var closeWaiters = [() -> Void]()
    var ping: String?
    var acceptedTop = false, acceptedChild = false, initialized = false, ready = false

    init(id: String, key: String, revision: String, card: [String: Any]) {
        self.id = id; self.key = key; self.revision = revision; self.card = card
        clipView.clipsToBounds = true
        clipView.isHidden = true
    }
}

@objc(ApexGeneratedCardsPlugin)
final class ApexGeneratedCardsPlugin: CAPPlugin, CAPBridgedPlugin, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate, UIGestureRecognizerDelegate {
    let identifier = "ApexGeneratedCardsPlugin"
    let jsName = "ApexGeneratedCards"
    let pluginMethods: [CAPPluginMethod] = ["capability", "mount", "layout", "dispose"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    private let log = Logger(subsystem: "dev.apexdeck.phone", category: "generated-cards")
    private var runs = [String: WidgetRun]()
    private var closing = [String: WidgetRun]()
    private lazy var offlineNetwork = try? WidgetNetworkDeny()
    private lazy var store = try? GeneratedWidgetStore()
    private var ownerObservation: NSKeyValueObservation?
    private lazy var template: String? = {
        guard let url = Bundle.main.url(forResource: "generated-widget", withExtension: "html", subdirectory: "public")
        else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }()
    @MainActor private lazy var rules = Task {
        let source = """
        [{"trigger":{"url-filter":".*"},"action":{"type":"block"}},
         {"trigger":{"url-filter":"^about:"},"action":{"type":"ignore-previous-rules"}},
         {"trigger":{"url-filter":"^data:image/"},"action":{"type":"ignore-previous-rules"}}]
        """
        return try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "ApexWidgetOffline1",
                                                                                encodedContentRuleList: source)
    }

    override func load() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            for notification in [UIScene.didEnterBackgroundNotification, Notification.Name("ApexGeneratedCardsLocked")] {
                NotificationCenter.default.addObserver(self, selector: #selector(self.suspend),
                                                       name: notification, object: nil)
            }
            for notification in [UIScene.didActivateNotification, Notification.Name("ApexGeneratedCardsUnlocked")] {
                NotificationCenter.default.addObserver(self, selector: #selector(self.resume),
                                                       name: notification, object: nil)
            }
            self.ownerObservation = self.webView?.observe(\.isLoading, options: [.new]) { [weak self] _, change in
                guard change.newValue == true else { return }
                DispatchQueue.main.async { self?.disposeAll() }
            }
        }
    }

    @objc private func suspend() {
        for run in Array(runs.values) {
            remove(run)
            notifyListeners("cardEvent", data: ["runId": run.id, "type": "suspended"])
        }
    }

    @objc private func resume() {
        if !AppLock.shared.locked {
            notifyListeners("cardEvent", data: ["runId": "", "type": "resumed"])
        }
    }

    private func disposeAll() {
        for run in Array(runs.values) { remove(run) }
    }

    private lazy var guidance: [String: Any]? = {
        guard #available(iOS 18.4, *), let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        else { return nil }
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x64"
        #endif
        #if targetEnvironment(simulator)
        let deviceClass = "simulator"
        #else
        let deviceClass = "device"
        #endif
        let version = ProcessInfo.processInfo.operatingSystemVersion
        let osVersion = "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
        let tuple = ["arch": arch, "deviceClass": deviceClass, "osVersion": osVersion, "appBuild": build]
        let adapter = "open-intelligent-ui-8391a94-deck-3"
        let policy = "generated-ui-deny-all-3"
        guard let url = Bundle.main.url(forResource: "generated-ui-runtime", withExtension: "json"),
              let bytes = try? Data(contentsOf: url),
              let registry = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              registry["protocolVersion"] as? Int == 1, registry["adapterVersion"] as? String == adapter,
              registry["securityPolicyVersion"] as? String == policy,
              let reviewed = registry["verifiedWebKitBuilds"] as? [[String: String]]
        else { return nil }
        #if !APEX_GENERATED_CARD_ACCEPTANCE
        guard reviewed.contains(tuple) else { return nil }
        #endif
        var result: [String: Any] = tuple
        result["platform"] = "ios"
        result["runtime"] = "ios-webkit"
        result["protocolVersion"] = 1
        result["adapterVersion"] = adapter
        result["securityPolicyVersion"] = policy
        return result
    }()

    @objc func capability(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let guidance = self.guidance, self.template != nil, self.store != nil, self.offlineNetwork != nil else {
                return call.resolve(["enabled": false])
            }
            call.resolve(["enabled": true, "guidance": guidance])
        }
    }

    private func card(_ value: Any?) -> [String: Any]? {
        guard let object = value as? [String: Any], object.count == 9,
              let version = object["schemaVersion"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(),
              version.doubleValue == 1, object["kind"] as? String == "generated",
              let id = object["cardId"] as? String,
              id.range(of: #"\A[a-z0-9][a-z0-9_-]{0,39}\z"#, options: .regularExpression) != nil else { return nil }
        for (name, limit) in [("title",80), ("summary",280), ("fallback",4000)] {
            guard let text = object[name] as? String, text.utf16.count <= limit,
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        }
        var total = 0
        for (name, limit) in [("html",49152), ("css",16384), ("js",32768)] {
            guard let text = object[name] as? String, text.utf8.count <= limit,
                  name != "html" || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            total += text.utf8.count
        }
        return total <= 65536 ? object : nil
    }

    private func rect(_ value: Any?) -> CGRect? {
        guard let object = value as? [String: Any], object.count == 4 else { return nil }
        var values = [Double]()
        for field in ["x", "y", "width", "height"] {
            guard let n = object[field] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
                  n.doubleValue.isFinite, abs(n.doubleValue) <= 1_000_000 else { return nil }
            values.append(n.doubleValue)
        }
        guard values[2] >= 0, values[3] >= 0 else { return nil }
        return CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
    }

    // The DOM measures the slot in viewport coordinates, but WebKit can keep
    // scrolling while that measurement is crossing the Capacitor bridge.
    @MainActor private func bindScroll(_ run: WidgetRun, call: CAPPluginCall, owner: WKWebView) {
        guard let viewport = rect(call.options["viewport"]), let offset = call.getDouble("scrollTop"),
              offset.isFinite else { return }
        run.viewport = viewport
        run.measuredOffset = offset
        func matches(_ scroll: UIScrollView) -> Bool {
            let frame = scroll.convert(scroll.bounds, to: owner)
            return scroll.isDescendant(of: owner.scrollView) && scroll !== owner.scrollView
                && abs(frame.minX - viewport.minX) <= 1 && abs(frame.minY - viewport.minY) <= 1
                && abs(frame.width - viewport.width) <= 1 && abs(frame.height - viewport.height) <= 1
                && scroll.contentSize.height > viewport.height
        }
        if let scroll = run.chatScrollView, matches(scroll) { return }
        run.scrollObservation = nil
        run.chatScrollView = nil
        var views = owner.scrollView.subviews
        var match: UIScrollView?
        while let view = views.popLast() {
            if let scroll = view as? UIScrollView, matches(scroll) {
                guard match == nil else { return }
                match = scroll
            }
            views.append(contentsOf: view.subviews)
        }
        guard let scroll = match else { return }
        run.chatScrollView = scroll
        let update: @MainActor @Sendable () -> Void = { [weak self, weak run, weak owner] in
            if let self, let run, let owner { self.position(run, in: owner) }
        }
        run.scrollObservation = scroll.observe(\.contentOffset, options: [.new]) { _, _ in
            // Apply UIKit's offset in the same main-thread scroll callback.
            MainActor.assumeIsolated { update() }
        }
    }

    @MainActor private func position(_ run: WidgetRun, in owner: WKWebView) {
        var bounds = run.bounds
        var clip = run.clip
        if let scroll = run.chatScrollView {
            let delta = run.measuredOffset - scroll.contentOffset.y
            bounds.origin.y += delta
            // Keep both the authorized card pixels and the authorized screen
            // region. A scroll must not uncover pixels over a floating control.
            clip = clip.offsetBy(dx: 0, dy: delta).intersection(run.clip).intersection(run.viewport)
        }
        let visible = owner.bounds.intersection(clip).intersection(bounds)
        guard !visible.isNull, !visible.isEmpty, bounds.width <= 4096, bounds.height <= 800 else {
            run.clipView.frame = .zero
            run.clipView.isHidden = true
            return
        }
        run.clipView.frame = visible
        run.content?.frame = bounds.offsetBy(dx: -visible.minX, dy: -visible.minY)
        run.clipView.isHidden = !run.ready
    }

    @objc func mount(_ call: CAPPluginCall) {
        Task { @MainActor [self] in
            guard !AppLock.shared.locked, webView?.window?.windowScene?.activationState != .background else {
                return call.reject("The app is suspended.", "SUSPENDED")
            }
            guard let guidance, let adapter = guidance["adapterVersion"] as? String,
                  let policy = guidance["securityPolicyVersion"] as? String, let owner = webView, let template, let offlineNetwork, store != nil,
                  let id = call.getString("runId"), id.range(of: #"\A[a-zA-Z0-9_-]{1,100}\z"#, options: .regularExpression) != nil,
                  runs[id] == nil, runs.count + closing.count < 8, let card = card(call.options["card"]),
                  let bounds = rect(call.options["bounds"]), let clip = rect(call.options["clip"]),
                  let cardId = card["cardId"] as? String else { return call.reject("Invalid generated card mount.") }
            var identity = [String]()
            for field in ["hostId", "threadId", "messageId"] {
                guard let text = call.getString(field), !text.isEmpty, text.utf8.count <= 512
                else { return call.reject("Missing generated card identity.") }
                identity.append(text)
            }
            let fields = ["kind", "cardId", "title", "summary", "html", "css", "js", "fallback"]
            let revision = widgetDigest(["1", adapter, policy] + fields.compactMap { card[$0] as? String })
            let key = widgetDigest(identity + [cardId, revision])
            if let previous = runs.values.first(where: { $0.key == key }) { remove(previous) }
            let run = WidgetRun(id: id, key: key, revision: revision, card: card)
            run.bounds = bounds
            run.clip = clip
            bindScroll(run, call: call, owner: owner)
            runs[id] = run

            do {
                if let previous = closing[key] {
                    await withCheckedContinuation { continuation in
                        previous.closeWaiters.append { continuation.resume() }
                    }
                }
                guard let list = try await rules.value, runs[id] === run, webView === owner else { throw WidgetError.unavailable }
                let config = WKWebViewConfiguration()
                config.websiteDataStore = .nonPersistent()
                config.websiteDataStore.proxyConfigurations = [offlineNetwork.proxy]
                config.preferences.isTextInteractionEnabled = false
                config.preferences.javaScriptCanOpenWindowsAutomatically = false
                config.allowsAirPlayForMediaPlayback = false
                config.allowsPictureInPictureMediaPlayback = false
                config.mediaTypesRequiringUserActionForPlayback = .all
                let controller = config.userContentController
                controller.add(list)
                installWidgetBridge(in: controller, handler: self)
                let view = WKWebView(frame: .zero, configuration: config)
                view.navigationDelegate = self
                view.uiDelegate = self
                view.allowsLinkPreview = false
                view.scrollView.isScrollEnabled = false
                view.scrollView.contentInsetAdjustmentBehavior = .never
                view.isOpaque = false
                view.backgroundColor = .clear
                run.content = view
                let pan = UIPanGestureRecognizer(target: self, action: #selector(scrollChat(_:)))
                pan.delegate = self
                run.clipView.addGestureRecognizer(pan)
                owner.addSubview(run.clipView)
                run.clipView.addSubview(view)
                position(run, in: owner)
                let wrapper = template.replacingOccurrences(of: "APEX_NATIVE_RUN_ID", with: id)
                    .replacingOccurrences(of: String(repeating: "0", count: 64), with: revision)
                log.debug("Loading bundled widget wrapper")
                view.loadHTMLString(wrapper, baseURL: nil)
                DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self, weak run] in
                    if let self, let run, self.runs[id] === run, !run.ready { self.fault(run) }
                }
                call.resolve()
            } catch {
                if runs[id] === run { remove(run) }
                log.error("Widget sandbox startup failed")
                call.reject("The generated card sandbox could not start.")
            }
        }
    }

    @objc private func scrollChat(_ pan: UIPanGestureRecognizer) {
        guard [.began, .changed, .ended].contains(pan.state), let run = runs.values.first(where: { $0.clipView === pan.view }) else { return }
        let delta = -pan.translation(in: webView).y
        pan.setTranslation(.zero, in: webView)
        if let scroll = run.chatScrollView {
            let top = -scroll.adjustedContentInset.top
            let bottom = max(top, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            let y = min(bottom, max(top, scroll.contentOffset.y + delta))
            scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: y), animated: false)
        } else {
            notifyListeners("cardEvent", data: ["runId": run.id, "type": "scroll", "deltaY": delta])
        }
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
        let velocity = pan.velocity(in: pan.view)
        return abs(velocity.y) > abs(velocity.x)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

    @objc func layout(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = call.getString("runId"), let run = self.runs[id], let owner = self.webView,
                  let bounds = self.rect(call.options["bounds"]), let clip = self.rect(call.options["clip"])
            else { return call.reject("Invalid generated card layout.") }
            if run.bounds.size != bounds.size { self.schedulePreview(run) }
            run.bounds = bounds
            run.clip = clip
            self.bindScroll(run, call: call, owner: owner)
            self.position(run, in: owner)
            call.resolve()
        }
    }

    @objc func dispose(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = call.getString("runId"), let run = self.runs[id] else { return call.resolve() }
            self.remove(run) { call.resolve() }
        }
    }

    private func remove(_ run: WidgetRun, capture: Bool = true, completion: @escaping () -> Void = {}) {
        run.scrollObservation = nil
        runs.removeValue(forKey: run.id)
        run.clipView.removeFromSuperview()
        guard let view = run.content else { return completion() }
        view.configuration.userContentController.removeScriptMessageHandler(forName: "widget", contentWorld: widgetWorld)
        run.closeWaiters.append(completion)
        guard capture, run.ready, let frame = run.childFrame else { return destroy(run) }
        // Hide and revoke all message admission immediately. The one remaining
        // operation reads a frozen API's cached primitive from the original frame.
        // A remount of this identity waits for the read or its bounded timeout.
        closing[run.key] = run
        view.evaluateJavaScript("window.generatedUI.editedSnapshotJSON", in: frame, in: .page) { [weak self, weak run] result in
            if let run { self?.finishClose(run, json: (try? result.get()) as? String) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self, weak run] in
            if let run { self?.finishClose(run, json: nil) }
        }
    }

    private func finishClose(_ run: WidgetRun, json: String?) {
        guard closing[run.key] === run else { return }
        closing.removeValue(forKey: run.key)
        if let json, json != run.savedJSON {
            do { try store?.save(json, for: run.key) }
            catch { log.error("Could not retain the final widget edit") }
        }
        destroy(run)
    }

    private func destroy(_ run: WidgetRun) {
        run.content?.stopLoading()
        run.content?.removeFromSuperview()
        run.content = nil
        run.childFrame = nil
        let waiters = run.closeWaiters
        run.closeWaiters.removeAll()
        for done in waiters { done() }
    }

    // A bounded raster stays in the DOM slot while native clipping catches up or
    // the live view remounts. Capture after startup and edits, never per scroll.
    private func schedulePreview(_ run: WidgetRun) {
        run.previewDirty = true
        guard run.ready, !run.previewPending else { return }
        run.previewPending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self, weak run] in
            guard let self, let run, self.runs[run.id] === run, let view = run.content else { return }
            run.previewDirty = false
            let config = WKSnapshotConfiguration()
            config.snapshotWidth = NSNumber(value: Double(min(480, max(1, view.bounds.width))))
            view.takeSnapshot(with: config) { [weak self, weak run] image, _ in
                guard let self, let run, self.runs[run.id] === run else { return }
                run.previewPending = false
                if run.previewDirty { return self.schedulePreview(run) }
                guard let image, let data = image.jpegData(compressionQuality: 0.8), data.count <= 256 * 1024 else { return }
                run.hasPreview = true
                self.notifyListeners("cardEvent", data: ["runId": run.id, "type": "preview",
                    "image": "data:image/jpeg;base64," + data.base64EncodedString()])
            }
        }
    }

    private func fault(_ run: WidgetRun) {
        log.error("Widget stopped: top=\(run.acceptedTop), child=\(run.acceptedChild), initialized=\(run.initialized), ready=\(run.ready)")
        remove(run, capture: false)
        notifyListeners("cardEvent", data: ["runId": run.id, "type": "fault"])
    }

    private func session(_ view: WKWebView?) -> WidgetRun? {
        guard let view else { return nil }
        return runs.values.first { $0.content === view }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.world == widgetWorld, let run = session(message.webView) else { return }
        if !message.frameInfo.isMainFrame {
            if run.childFrame == nil, message.body as? String == "snapshot-frame" { run.childFrame = message.frameInfo }
            return
        }
        guard let text = message.body as? String, text.utf8.count <= 16384,
              let body = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              body["runId"] as? String == run.id, body["revisionDigest"] as? String == run.revision,
              body["protocolVersion"] as? Int == 1, let type = body["type"] as? String else { return }
        switch type {
        case "bootstrap" where !run.initialized:
            guard let store, let state = try? store.restore(run.key) else { return fault(run) }
            run.initialized = true
            run.acceptedChild = true
            var command = body
            command["type"] = "init"; command["card"] = run.card; command["widgetState"] = state
            run.content?.callAsyncJavaScript("window.apexWidgetCommand(command)", arguments: ["command": command],
                                             in: nil, in: .page) { [weak self, weak run] result in
                if case .failure = result, let self, let run, self.runs[run.id] === run { self.fault(run) }
            }
        case "ready" where run.initialized && !run.ready:
            guard run.childFrame != nil else { return fault(run) }
            run.ready = true
            scheduleHeartbeat(run)
            schedulePreview(run)
            run.clipView.isHidden = run.clipView.frame.isEmpty
            notifyListeners("cardEvent", data: ["runId": run.id, "type": type])
        case "widget-state" where run.initialized:
            guard let json = body["widgetState"] as? String, let store else { return fault(run) }
            do {
                try store.save(json, for: run.key)
                run.savedJSON = json
                if run.hasPreview {
                    run.hasPreview = false
                    notifyListeners("cardEvent", data: ["runId": run.id, "type": "preview", "image": ""])
                }
                schedulePreview(run)
            } catch { fault(run) }
        case "resize" where run.ready:
            guard let height = body["height"] as? Int, (200...800).contains(height) else { return }
            notifyListeners("cardEvent", data: ["runId": run.id, "type": type, "height": height])
        case "discuss" where run.ready:
            if let text = body["text"] as? String, text.utf16.count <= 4000 {
                notifyListeners("cardEvent", data: ["runId": run.id, "type": type, "text": text])
            }
        case "pong" where run.ready:
            if let nonce = body["nonce"] as? String, nonce == run.ping { run.ping = nil }
        case "fault": fault(run)
        default: break
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let run = session(webView), let target = action.targetFrame, action.navigationType == .other
        else { return decisionHandler(.cancel) }
        let url = action.request.url?.absoluteString
        if target.isMainFrame, !run.acceptedTop, url == "about:blank" {
            run.acceptedTop = true
            return decisionHandler(.allow)
        }
        if !target.isMainFrame, !run.acceptedChild, url == "about:srcdoc" {
            run.acceptedChild = true
            return decisionHandler(.allow)
        }
        decisionHandler(.cancel)
    }

    private func scheduleHeartbeat(_ run: WidgetRun) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self, weak run] in
            guard let self, let run, self.runs[run.id] === run else { return }
            guard run.ping == nil else { return self.fault(run) }
            let nonce = UUID().uuidString
            run.ping = nonce
            let command: [String: Any] = ["protocolVersion": 1, "runId": run.id, "revisionDigest": run.revision,
                                          "type": "ping", "nonce": nonce]
            run.content?.callAsyncJavaScript("window.apexWidgetCommand(command)", arguments: ["command": command],
                                             in: nil, in: .page, completionHandler: nil)
            self.scheduleHeartbeat(run)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let run = session(webView) { fault(run) }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }

    func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    @available(iOS 18.4, *)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        completionHandler(nil)
    }
}
