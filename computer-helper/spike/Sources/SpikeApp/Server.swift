import AppKit
import Darwin
import SpikeCore

final class ClientSession {
  let latch = Latch()
  var token: String?
  var target = ""
  var imageScope: ScreenshotScope?
  var snapshot: Snapshot?
  let engine = EngineSession()
  /// The bot chose Deck's own browser. Guarded by the server's `activeLock`.
  var usingBrowser = false
}
final class Server {
  let ax = Accessibility()
  var latch: Latch { activeState.latch }
  let turns = TurnRegistry()
  let browser = BrowserBroker()
  lazy var activity = ActivityTap(latch)
  var input: Input { Input(ax: ax, latch: latch) }
  let queue = DispatchQueue(label: "unified-computer.actions")
  let lease = ActionLease()
  let output = NSLock()
  let activeLock = NSLock()
  var activeID: String?
  var activeState = ClientSession()
  var snapshot: Snapshot? { get { activeState.snapshot } set { activeState.snapshot = newValue } }
  var engineSession: EngineSession { activeState.engine }
  var fd: Int32 = -1
  var showDialog: (() -> Void)?
  var showSetup: (() -> Void)?
  func checkProofHost() throws {
    try turns.check(activeState.token)
    if !activeState.target.isEmpty, let token = activeState.token {
      let identity = try turns.identity(activeState.target, token: token)
      let app = try ax.running(activeState.target)
      try identity.validate(app)
      latch.setTarget(app.processIdentifier)
    }
  }
  func startIsolatedRun() -> Bool { false } // Session authority always comes from the signed daemon.
  func stopIsolatedRun() {
    CursorOverlayIntegration.cleanupOnStop()
    activity.stopAll()
    lease.releaseAll()
    for turn in turns.stopAll() {
      guard let fd = turn["control"] as? Int32, fd >= 0, let params = turn["params"] as? [String: Any] else { continue }
      DispatchQueue.global().async { self.send(["jsonrpc": "2.0", "method": "unified/stop", "params": params], fd); close(fd) }
    }
  }
  /// A failed reply closes the bot's connection, so only Stop or cancellation may fail one.
  func replyCheck(_ state: ClientSession, _ request: String) throws {
    try turns.check(state.token); try state.latch.check(request)
  }
  func start() {
    activity.start()
    DispatchQueue.global().async { self.listen() }
  }
  func status() -> [String: Any] {
    let state = activity.latch.state()
    var cursorOverlayDict = CursorOverlaySettings.toDictionary()
    // Ensure enabled flag mirrors isEnabled
    cursorOverlayDict["enabled"] = CursorOverlaySettings.isEnabled
    cursorOverlayDict["labelsEnabled"] = CursorOverlaySettings.showLabel
    return ["accessibilityTrusted": ax.trusted(), "screenCaptureAccess": CGPreflightScreenCaptureAccess(),
      "listenEventAccess": CGPreflightListenEventAccess(), "tapHealthy": state.2, "stopped": turns.isStopped,
      "cursorOverlayEnabled": CursorOverlaySettings.isEnabled,
      "cursorOverlayLabelsEnabled": CursorOverlaySettings.showLabel,
      "cursorOverlay": cursorOverlayDict,
      "awayMode": AwayMode.shared.status(),
      "pid": ProcessInfo.processInfo.processIdentifier]
  }
  func send(_ value: [String: Any], _ client: Int32) { output.lock(); defer { output.unlock() }; Wire.send(value, fd: client) }
  func response(_ id: Any, _ result: [String: Any], _ client: Int32) { send(["jsonrpc": "2.0", "id": id, "result": result], client) }
  func fail(_ id: Any, _ code: String, _ client: Int32) { response(id, ["isError": true, "content": [["type": "text", "text": code]]], client) }
  func listen() {
    signal(SIGPIPE, SIG_IGN)
    do {
      try FileManager.default.createDirectory(at: Wire.root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      let attrs = try FileManager.default.attributesOfItem(atPath: Wire.root.path)
      guard attrs[.type] as? FileAttributeType == .typeDirectory,
        attrs[.ownerAccountID] as? UInt32 == getuid() else { return }
      chmod(Wire.root.path, 0o700)
    } catch { return }
    // A second instance must never replace a live server's socket.
    let existing = Wire.connect()
    if existing >= 0 { close(existing); return }
    unlink(Wire.socketPath)
    fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return }
    var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(Wire.socketPath.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { return }
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    let ok = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    guard ok == 0, Darwin.listen(fd, 16) == 0 else { return }
    chmod(Wire.socketPath, 0o600)
    while true {
      let client = accept(fd, nil, nil)
      if client < 0 { return }
      DispatchQueue.global().async { self.read(client) }
    }
  }
  func read(_ client: Int32) {
    let state = ClientSession()
    let listener = activity.add(state.latch)
    var controlToken: String?
    let authenticated = TurnRegistry.authenticatedDaemon(client)
    var protocolStarted = false
    defer {
      if let token = controlToken { turns.end(token); if lease.release(token) { activity.invalidateObservations() } }
      state.latch.stop()
      if let token = state.token { _ = lease.release(token) }
      activity.remove(listener)
      shutdown(client, SHUT_RDWR)
      queue.async { state.imageScope = nil; state.snapshot = nil; state.engine.invalidate(); close(client) }
    }
    // Only the daemon sends frames as large as a screenshot.
    Wire.lines(fd: client, limit: authenticated ? Wire.screenshotResponseLineLimit : Wire.requestLineLimit) { data in
      guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let method = object["method"] as? String else { return }
      let params = object["params"] as? [String: Any] ?? [:]
      if method == "notifications/cancelled" { if let id = params["requestId"] { state.latch.cancel(String(describing: id)) }; return }
      if method == "unified/browser-result" {
        if authenticated, controlToken != nil, params["turnToken"] as? String == controlToken { self.browser.deliver(params) }
        return
      }
      guard let id = object["id"] else { return }
      if method == "unified/register-turn" {
        do {
          guard authenticated, !protocolStarted, controlToken == nil, state.token == nil else { throw Refusal("authenticated_daemon_required") }
          controlToken = try self.turns.register(params, control: client)
          if let owner = self.lease.currentOwner, (try? self.turns.check(owner)) == nil,
            self.lease.release(owner) { self.activity.invalidateObservations() }
          self.response(id, ["registered": true], client)
        } catch let error as Refusal { self.fail(id, error.code, client) } catch { self.fail(id, "registration_failed", client) }
        return
      }
      if method == "unified/end-turn" {
        guard authenticated, let token = controlToken, params["turnToken"] as? String == token else { self.fail(id, "authenticated_turn_required", client); return }
        self.turns.end(token); if self.lease.release(token) { self.activity.invalidateObservations() }
        CursorOverlayIntegration.hideAfterAction()
        self.response(id, ["ended": true], client); return
      }
      if method == "unified/bind-turn" {
        do {
          guard !protocolStarted, state.token == nil, controlToken == nil else { throw Refusal("binding_must_precede_protocol") }
          state.token = try self.turns.bind(params, latch: state.latch)
          self.response(id, ["bound": true], client)
        } catch let error as Refusal { self.fail(id, error.code, client) } catch { self.fail(id, "binding_failed", client) }
        return
      }
      if method == "spike/bind-proof" { self.fail(id, "proof_binding_must_precede_protocol", client); return }
      if method == "unified/status" || method == "spike/status" { self.response(id, self.status(), client); return }
      if method == "unified/setup" {
        guard authenticated else { self.fail(id, "authenticated_daemon_required", client); return }
        DispatchQueue.main.async { self.showSetup?() }
        self.response(id, ["shown": true], client); return
      }
      if method == "unified/set-action-labels" {
        guard authenticated else { self.fail(id, "authenticated_daemon_required", client); return }
        guard let enabled = params["enabled"] as? Bool else { self.fail(id, "invalid_request", client); return }
        CursorOverlaySettings.showLabel = enabled
        CursorOverlay.shared.cleanup()
        self.response(id, self.status(), client); return
      }
      if method == "unified/set-cursor-overlay" {
        guard authenticated else { self.fail(id, "authenticated_daemon_required", client); return }
        if let err = CursorOverlaySettings.apply(dict: params) {
          self.fail(id, err, client); return
        }
        // Return full status for host sync
        self.response(id, self.status(), client); return
      }
      if method == "unified/set-cursor-image" {
        guard authenticated else { self.fail(id, "authenticated_daemon_required", client); return }
        // Expect base64 PNG or absolute path – host already saved image, so accept path first
        if let path = params["path"] as? String, !path.isEmpty {
          if let err = CursorOverlaySettings.validateImageFile(at: path) {
            self.fail(id, err, client); return
          }
          UserDefaults.standard.set(path, forKey: CursorOverlaySettings.customImageKey)
          UserDefaults.standard.set("custom", forKey: CursorOverlaySettings.presetKey)
          self.response(id, self.status(), client); return
        }
        if let b64 = params["imageBase64"] as? String ?? params["image_base64"] as? String {
          // For direct base64 via helper – store in temp app support and validate
          guard let data = Data(base64Encoded: b64) else { self.fail(id, "invalid_base64", client); return }
          if data.count > 2*1024*1024 { self.fail(id, "image must be ≤2MiB", client); return }
          // Validate PNG magic
          let pngMagic = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
          if !data.starts(with: pngMagic) { self.fail(id, "cursor images must be PNG", client); return }
          let tmpDir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("Apex Deck/computer-cursor", isDirectory: true)
          if let dir = tmpDir {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let hash = data.hashValue
            let dest = dir.appendingPathComponent("cursor-\(abs(hash)).png")
            do {
              try data.write(to: dest, options: .atomic)
              if let err = CursorOverlaySettings.validateImageFile(at: dest.path) {
                try? FileManager.default.removeItem(at: dest)
                self.fail(id, err, client); return
              }
              UserDefaults.standard.set(dest.path, forKey: CursorOverlaySettings.customImageKey)
              UserDefaults.standard.set("custom", forKey: CursorOverlaySettings.presetKey)
            } catch {
              self.fail(id, "could not save image: \(error.localizedDescription)", client); return
            }
          }
          self.response(id, self.status(), client); return
        }
        self.fail(id, "invalid_request", client); return
      }
      if method == "unified/reset-cursor-overlay" {
        guard authenticated else { self.fail(id, "authenticated_daemon_required", client); return }
        CursorOverlaySettings.resetToDefaults()
        CursorOverlaySettings.showLabel = false
        self.response(id, self.status(), client); return
      }
      if method == "unified/resume" {
        guard authenticated else { self.fail(id, "authenticated_daemon_required", client); return }
        self.turns.resume(); self.response(id, ["resumed": true], client); return
      }
      if method == "unified/stop-all" {
        guard authenticated else { self.fail(id, "authenticated_daemon_required", client); return }
        self.stopIsolatedRun(); self.response(id, ["stopped": true], client); return
      }
      protocolStarted = true
      if method == "initialize" {
        self.queue.async { self.response(id, ["protocolVersion": "2025-06-18", "capabilities": ["tools": [:]], "serverInfo": ["name": "unified-computer-use", "version": "1.0.0"]], client) }; return
      }
      if method == "ping" { self.queue.async { self.response(id, [:], client) }; return }
      if method == "tools/list" { self.queue.async { self.response(id, ["tools": Self.tools], client) }; return }
      guard method == "tools/call", controlToken == nil else { self.fail(id, "unsupported_method", client); return }
      let tool = params["name"] as? String ?? "", toolArguments = params["arguments"] as? [String: Any] ?? [:]
      self.activeLock.lock()
      let brokered = BrowserBroker.routes(tool, toolArguments, active: state.usingBrowser)
      self.activeLock.unlock()
      if brokered { DispatchQueue.global().async { self.browserCall(id, tool, toolArguments, state: state, client: client) }; return }
      // One action runs at a time. A second call waits briefly for its turn
      // instead of failing at once, which bots read as a broken tool.
      DispatchQueue.global().async {
      var busy = true
      let until = ProcessInfo.processInfo.systemUptime + 8
      while true {
        self.activeLock.lock()
        busy = self.activeID != nil
        if !busy { self.activeID = String(describing: id) }
        self.activeLock.unlock()
        if !busy || ProcessInfo.processInfo.systemUptime >= until { break }
        Thread.sleep(forTimeInterval: 0.05)
      }
      if busy { self.queue.async { self.fail(id, "action_busy", client) }; return }
      self.queue.async {
        self.activeState = state
        state.engine.authorization = { [weak server = self, weak clientState = state] in
          guard let server = server, let state = clientState, let token = state.token else { throw Refusal("helper_unavailable") }
          try server.turns.check(token)
          if try server.turns.canControl(token) { try server.lease.check(token) }
        }
        defer { self.activeLock.lock(); self.activeID = nil; self.activeLock.unlock() }
        do {
          try self.turns.check(state.token)
          self.ax.targetBundle = state.target
          self.ax.verifyIdentity = { app in
            try self.turns.check(state.token)
            guard let token = state.token else { throw Refusal("turn_unregistered_or_ended") }
            try self.turns.identity(app.bundleIdentifier ?? "", token: token).validate(app)
          }
          let request = String(describing: id)
          let result = try self.call(params, id: request)
          if tool == "request_app" { self.activeLock.lock(); state.usingBrowser = false; self.activeLock.unlock() }
          _ = Wire.publishScreenshot(["jsonrpc": "2.0", "id": id, "result": result], fd: client, output: self.output,
            check: { try self.replyCheck(state, request) },
            invalidate: { state.imageScope = nil; state.snapshot = nil; state.engine.invalidate(); state.latch.stop() })
        } catch let error as Refusal {
          let code = state.engine.failureCode(error.code)
          if EngineSession.keepsObservation(tool: params["name"] as? String ?? "", code: code) {
            CursorOverlayIntegration.cleanupOnStop()
            self.fail(id, code, client)
            return
          }
          state.imageScope = nil; state.snapshot = nil; state.engine.invalidate()
          if let note = EngineSession.deliveredNote(code, tool: params["name"] as? String ?? "") {
            CursorOverlayIntegration.hideAfterAction()
            self.response(id, ["content": [["type": "text", "text": note]]], client)
            return
          }
          CursorOverlayIntegration.cleanupOnStop()
          self.fail(id, code, client)
        } catch {
          state.imageScope = nil; state.snapshot = nil; state.engine.invalidate()
          CursorOverlayIntegration.cleanupOnStop()
          self.fail(id, "internal_error", client)
        }
      }
      }
    }
  }
  /// Runs off the action queue: the host serialises browser work, and a slow page must not
  /// hold up another bot's desktop action.
  func browserCall(_ id: Any, _ tool: String, _ args: [String: Any], state: ClientSession, client: Int32) {
    let request = String(describing: id)
    do {
      guard let token = state.token else { throw Refusal("turn_unregistered_or_ended") }
      try replyCheck(state, request)
      if tool == "request_app" {
        guard args.count == 1 else { throw Refusal("unexpected_arguments") }
        if (try? turns.identity(BrowserBroker.resource, token: token)) != BrowserBroker.identity {
          try ask(BrowserBroker.identity, name: BrowserBroker.name, detail: "This is Deck's own background browser, not your Chrome or Brave. It has no window, so bots use it without your pointer, keyboard or focus. Each bot works in its own tab, shown in Deck's Browser tab. It can open any site signed in there, and act on it.\n\nAllow Once ends with this bot's turn. Allow for This Work Thread covers every supported bot in this thread until you press Stop or access is revoked. Other threads still ask and can't reach this thread's tabs. Take over keeps every bot out of that tab until you hand it back.", token: token, state: state, request: request)
        }
      }
      _ = try turns.identity(BrowserBroker.resource, token: token)
      let owner = try turns.requester(token)
      let result = try browser.call(tool == "request_app" ? "read_screen" : tool, tool == "request_app" ? [:] : args,
        turn: ["threadId": owner.0, "participantId": owner.1, "turnToken": token],
        send: { message in
          guard let control = self.turns.controlConnection(token) else { return }
          self.send(message, control); close(control)
        }, check: { try self.replyCheck(state, request) })
      let reply = try BrowserBroker.content(result)
      if tool == "request_app" || tool == "navigate" || tool.hasPrefix("browser_") { activeLock.lock(); state.usingBrowser = true; activeLock.unlock() }
      if result["image"] != nil {
        _ = Wire.publishScreenshot(["jsonrpc": "2.0", "id": id, "result": reply], fd: client, output: output,
          check: { try self.replyCheck(state, request) }, invalidate: { state.latch.stop() })
      } else { response(id, reply, client) }
    } catch let error as Refusal { fail(id, error.code, client) } catch { fail(id, "internal_error", client) }
  }
  /// Waits for the person's answer and records it. Throws unless they allowed it.
  func ask(_ identity: AppIdentity, name: String, detail: String, token: String, state: ClientSession, request: String) throws {
    try turns.authorizeApp(identity, token: token) {
      let control = try turns.canControl(token)
      let owner = try turns.requester(token)
      let prompt = AppGrantPrompt(text: "Requested by: \(owner.1.prefix(64))\nThread: \(owner.0.prefix(64))\n\nA bot wants to \(control ? "read and control" : "read") \(name).\n\n\(detail)")
      DispatchQueue.main.async { prompt.show() }
      defer { DispatchQueue.main.async { prompt.dismiss() } }
      let deadline = ProcessInfo.processInfo.systemUptime + 120
      while prompt.decision() == nil {
        try turns.check(token); try state.latch.check(request)
        guard ProcessInfo.processInfo.systemUptime < deadline else { throw Refusal("app_grant_deadline") }
        Thread.sleep(forTimeInterval: 0.02)
      }
      try turns.check(token); try state.latch.check(request)
      return prompt.decision() ?? .denied
    }
  }
  func observe(id: String, epoch: UInt64? = nil) throws -> Snapshot {
    try checkProofHost()
    // Without a held epoch this is a plain reading, which input never refuses. It records
    // the count from its start, so input that overlaps it still blocks acting on it.
    let expected = epoch ?? latch.state().0
    try latch.check(id, epoch: epoch)
    let fresh = try ax.capture(epoch: expected)
    try latch.check(id, epoch: epoch)
    return fresh
  }
  func call(_ params: [String: Any], id: String) throws -> [String: Any] {
    try turns.check(activeState.token)
    try latch.check(id)
    let name = params["name"] as? String ?? ""
    let args = params["arguments"] as? [String: Any] ?? [:]
    guard let token = activeState.token else { throw Refusal("turn_unregistered_or_ended") }
    if name == "click_point" { try lease.check(token) }
    if name != "list_apps", try turns.canControl(token), try lease.claim(token) {
      activity.invalidateObservations()
    }
    if name == "list_apps" {
      guard args.isEmpty else { throw Refusal("unexpected_arguments") }
      let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy != .prohibited && Policy.target($0.bundleIdentifier ?? "") }
      let rows = [["app": BrowserBroker.resource, "name": BrowserBroker.name]] + apps.prefix(100).map { ["app": $0.bundleIdentifier ?? "", "name": $0.localizedName ?? ""] }
      let bytes = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
      return ["content": [["type": "text", "text": String(data: bytes, encoding: .utf8) ?? "[]"]]]
    }
    var launchTookFocus = false
    if name == "request_app" { launchTookFocus = try requestApp(args, token: token, id: id) }
    else { try checkProofHost() }
    if name == "list_windows" {
      guard args.isEmpty else { throw Refusal("unexpected_arguments") }
      let infos = try ax.listWindowInfos()
      let rows: [[String: Any]] = infos.enumerated().map { (idx, info) in
        var row: [String: Any] = ["index": idx+1, "minimized": info.minimized, "focused": info.focused]
        if let t = info.title { row["title"] = t.prefix(200).description }
        if let n = info.windowNumber { row["windowID"] = "w-\(n)" }
        if let f = info.frame { row["frame"] = ["x": f.minX, "y": f.minY, "w": f.width, "h": f.height] }
        return row
      }
      let bytes = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
      return ["content": [["type": "text", "text": String(data: bytes, encoding: .utf8) ?? "[]"]]]
    }
    if name == "get_screenshot" {
      guard args.isEmpty else { throw Refusal("unexpected_arguments") }
      guard #available(macOS 14.2, *) else { throw Refusal("screenshot_requires_macOS_14_2") }
      let session = engineSession
      let (fresh, result, scope) = try WindowScreenshot(ax: ax, latch: latch).capture(id: id) { [ax, latch] in
        try session.capture(native: $0, id: id, latch: latch, ax: ax)
      }
      snapshot = fresh; activeState.imageScope = scope
      return result
    }
    if name == "click_point" {
      guard try turns.canControl(token), Set(args.keys) == ["snapshot", "x", "y"],
        let s = snapshot, args["snapshot"] as? String == s.id, let scope = activeState.imageScope,
        scope.snapshot == s.id, let x = args["x"] as? Double, let y = args["y"] as? Double else { throw Refusal("current_screenshot_and_control_required") }
      latch.beginAction(id); defer { latch.endAction(id) }
      try input.point(x: x, y: y, scope: scope, s: s, id: id)
      activeState.imageScope = nil
      latch.endAction(id)
      engineSession.recordUnverifiedInput()
      snapshot = try observe(id: id)
      CursorOverlayIntegration.hideAfterAction()
    } else if name != "request_app" {
      _ = try callText(params, id: id)
      CursorOverlayIntegration.hideAfterAction()
    }
    activeState.imageScope = nil
    guard let native = snapshot else { throw Refusal("observation_unavailable") }
    let bound = try engineSession.capture(native: native, id: id, latch: latch, ax: ax)
    snapshot = bound
    return ["content": [["type": "text", "text": bound.output + (launchTookFocus ? "launch_took_focus\n" : "")]]]
  }
  /// Never touches a running app. True if starting a stopped one took the front.
  func requestApp(_ args: [String: Any], token: String, id: String) throws -> Bool {
    guard Set(args.keys) == ["app"], let bundle = args["app"] as? String else { throw Refusal("invalid_arguments") }
    guard bundle.allSatisfy(\.isASCII) else { throw Refusal("app_id_not_plain_ascii") }
    guard Policy.target(bundle) else { throw Refusal("protected_or_unavailable_app") }
    let open = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter { !$0.isTerminated && $0.activationPolicy != .prohibited }
    let url = try AppIdentity.source(running: open.map(\.bundleURL), registered: NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle))
    let identity = try AppIdentity.capture(url, bundle: bundle)
    // The permission prompt names exactly what's running, checked before anyone is asked.
    if let app = open.first { try identity.validate(app) }
    if (try? turns.identity(bundle, token: token)) != identity {
      try ask(identity, name: Bundle(url: url)?.object(forInfoDictionaryKey: "CFBundleName") as? String ?? bundle,
        detail: "\(bundle)\n\(identity.path)\n\nAllow Once ends with this bot's turn. Allow for This Work Thread lets every supported bot in this thread use this app, with no more prompts, until you press Stop or access is revoked. Other threads still ask. Bots work in the background, but starting an app that isn't running can bring it forward. Password fields and system security settings are protected.",
        token: token, state: activeState, request: id)
    }
    let control = try turns.canControl(token)
    if control, try lease.claim(token) { activity.invalidateObservations() }
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter { !$0.isTerminated && $0.activationPolicy != .prohibited }
    guard running.count <= 1 else { throw Refusal("target_ambiguous") }
    let launching = running.isEmpty
    guard control || !launching else { throw Refusal("read_access_cannot_launch_app") }
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    if launching {
      let completion = DispatchSemaphore(value: 0)
      DispatchQueue.main.async {
        guard (try? self.turns.check(token)) != nil else { completion.signal(); return }
        let config = NSWorkspace.OpenConfiguration(); config.activates = false
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, _ in completion.signal() }
      }
      let deadline = ProcessInfo.processInfo.systemUptime + 5
      while completion.wait(timeout: .now() + 0.02) != .success {
        try turns.check(token); try latch.check(id)
        guard ProcessInfo.processInfo.systemUptime < deadline else { throw Refusal("launch_deadline") }
      }
    }
    try turns.check(token)
    activeState.target = bundle; ax.targetBundle = bundle
    // A new app takes a moment to have a window the engine can name.
    let deadline = ProcessInfo.processInfo.systemUptime + (launching ? 5 : 0)
    while true {
      do {
        let app = try ax.running(bundle); try identity.validate(app)
        let fresh = try observe(id: id)
        if !launching || fresh.window.flatMap(windowNumber) != nil { snapshot = fresh; break }
      } catch let error as Refusal where ["app_has_no_window", "target_not_running_or_ambiguous"].contains(error.code)
        && ProcessInfo.processInfo.systemUptime < deadline {}
      guard ProcessInfo.processInfo.systemUptime < deadline else { throw Refusal("app_has_no_window") }
      try turns.check(token); try latch.check(id)
      Thread.sleep(forTimeInterval: 0.1)
    }
    let now = NSWorkspace.shared.frontmostApplication?.processIdentifier
    return launching && now != front && now == snapshot?.app.processIdentifier
  }
  func callText(_ params: [String: Any], id: String) throws -> String {
    try latch.check(id)
    try checkProofHost()
    let name = params["name"] as? String ?? ""
    let args = params["arguments"] as? [String: Any] ?? [:]
    if name == "read_screen" { guard args.isEmpty else { throw Refusal("unexpected_arguments") }; snapshot = try observe(id: id); return snapshot!.output }
    guard let token = activeState.token, try turns.canControl(token) else { throw Refusal("observation_only_access") }
    guard let s = snapshot, args["snapshot"] as? String == s.id, engineSession.current?.id == s.id else { throw Refusal("fresh_snapshot_required") }
    latch.beginAction(id); defer { latch.endAction(id) }
    switch name {
    case "click":
      guard Set(args.keys) == ["snapshot", "element"], let number = args["element"] as? Int else { throw Refusal("invalid_arguments") }
      // Blocker 2: Do NOT infer position from native.controls[element-1]. The
      // ref-to-target rect is shown inside EngineCheck.validate via the actual
      // engine-resolved AX element (minimal hook coordinated with Jigga).
      try engineSession.click(element: number, s: s, id: id, latch: latch, ax: ax)
    case "type_text":
      guard Set(args.keys).subtracting(["element"]) == ["snapshot", "text"], let text = args["text"] as? String,
        args["element"] == nil || args["element"] is Int else { throw Refusal("invalid_arguments") }
      // Blocker 3: generic label, no echo of submitted content.
      try engineSession.type(text: text, element: args["element"] as? Int, s: s, id: id, latch: latch, ax: ax)
    case "press_key":
      guard Set(args.keys) == ["snapshot", "key"], let key = args["key"] as? String else { throw Refusal("invalid_arguments") }
      // Generic label for key, show at focus only as fallback before validation
      CursorOverlayIntegration.showForFocus(snapshot: s, label: key == "" ? "Key" : key, action: .generic)
      try input.key(key, s: s, id: id, untethered: turns.isUntethered(activeState.token))
      engineSession.recordUnverifiedInput()
    case "scroll":
      guard Set(args.keys) == ["snapshot", "element", "direction", "amount"], let number = args["element"] as? Int,
        let direction = args["direction"] as? String, let amount = args["amount"] as? Int,
        ["up", "down", "left", "right"].contains(direction), (1...20).contains(amount) else { throw Refusal("invalid_arguments") }
      // Blocker 2: overlay is shown in EngineCheck at actual resolved target.
      try engineSession.scroll(element: number, direction: direction, amount: amount, s: s, id: id, latch: latch, ax: ax)
    case "control":
      guard Set(args.keys).subtracting(["value"]) == ["snapshot", "element", "action"], let number = args["element"] as? Int,
        let action = args["action"] as? String, args["value"] == nil || args["value"] is String else { throw Refusal("invalid_arguments") }
      try engineSession.control(element: number, action: action, value: args["value"] as? String, s: s, id: id, latch: latch, ax: ax)
    case "reveal":
      guard Set(args.keys) == ["snapshot", "element"], let number = args["element"] as? Int else { throw Refusal("invalid_arguments") }
      try engineSession.reveal(element: number, s: s, id: id, latch: latch, ax: ax)
    default: throw Refusal("unknown_tool")
    }
    latch.endAction(id)
    snapshot = try observe(id: id)
    return snapshot!.output
  }
  static var tools: [[String: Any]] {
    func tool(_ name: String, _ description: String, _ properties: [String: Any], _ required: [String], _ read: Bool = false) -> [String: Any] {
      ["name": name, "description": description, "inputSchema": ["type": "object", "properties": properties, "required": required, "additionalProperties": false],
        "annotations": ["readOnlyHint": read, "destructiveHint": false, "openWorldHint": false]]
    }
    let str: [String: Any] = ["type": "string"]
    let snap: [String: Any] = ["snapshot": str]
    let element: [String: Any] = ["type": "integer", "minimum": 1]
    return [tool("list_apps", "List running eligible native apps, plus \(BrowserBroker.resource), Deck's own background browser. Requires an enabled active session.", [:], [], true),
      tool("request_app", "Request a per-app session grant by bundle ID. Never brings a running app forward. Starting a stopped app needs a writable session and can bring it forward, which the reply reports as launch_took_focus. Request \(BrowserBroker.resource) for websites: it has no window, keeps Take over sign-ins, and uses neither the person's pointer nor focus. Once requested, the tools below act on that browser until another app is requested.", ["app": str], ["app"]),
      tool("navigate", "Open an http or https address in Deck's own background browser. Requires the \(BrowserBroker.resource) grant.", ["url": str], ["url"]),
      tool("browser_tabs", "List the tabs of Deck's browser this thread may use, and who holds each. Tabs belonging to the person or other threads aren't shown. Each bot works in its current tab, and bots work at the same time in separate tabs.", [:], [], true),
      tool("browser_new_tab", "Open a new tab in Deck's browser for this thread and work in it. The url is optional.", ["url": str], []),
      tool("browser_use_tab", "Switch to working in another tab this thread may use. If another bot holds it, you can read it but not act on it.", ["tab": str], ["tab"]),
      tool("browser_close_tab", "Close a tab this thread may use, unless someone else holds it.", ["tab": str], ["tab"]),
      tool("read_screen", "Read the granted app's window and retained element references. Works behind other windows and on minimized windows, and reports visibility: frontmost, partly_visible, covered, minimized or hidden. Controls marked offscreen can still be used. While a browser window is fully covered its page can lag, and a page loaded then can return web_content_unavailable. No tool fixes that from the background: the window has to be showing.", [:], [], true),
      tool("list_windows", "List windows of the granted app with minimized/focused state.", [:], [], true),
      ScreenshotPolicy.tool,
      tool("click", "Press one retained numbered control in a fresh snapshot, in the background. The pointer never moves. A disabled control returns element_disabled.", snap.merging(["element": element]) { $1 }, ["snapshot", "element"]),
      tool("control", "Operate one retained numbered control in a fresh snapshot without the pointer or keyboard. action is toggle, check, uncheck, expand, collapse, select (value = the option's label, for pop-up menus, lists and tabs) or set_value (value = the field's full new text; prefer type_text for typing). More reliable than click for checkboxes, switches, disclosure triangles, pop-ups and sliders. Password fields are refused.", snap.merging(["element": element, "action": ["type": "string", "enum": ["toggle", "check", "uncheck", "expand", "collapse", "select", "set_value"]], "value": ["type": "string", "maxLength": 16384]]) { $1 }, ["snapshot", "element", "action"]),
      tool("click_point", "Press the control under a point in the current screenshot. x/y are image pixels; requires its image_snapshot and a writable session. The pointer never moves, so pixel_target_has_no_control is returned where nothing pressable is under the point, such as a canvas.", snap.merging(["x": ["type": "number", "minimum": 0], "y": ["type": "number", "minimum": 0]]) { $1 }, ["snapshot", "x", "y"]),
      tool("type_text", "Type into a numbered text control, or the app's focused field if element is omitted. Works in the background and is verified by reading the field back. Password fields are refused.", snap.merging(["text": ["type": "string", "maxLength": 65536], "element": element]) { $1 }, ["snapshot", "text"]),
      tool("press_key", "Press a named key, such as Return, Tab, Space, PageDown or Shift-Tab, on the app's focused control. Delivery is not verified, so read the screen and never repeat it blindly. Cmd- and Control- shortcuts return shortcut_needs_foreground unless this bot is untethered, which brings the app to the front first; quit and force-quit shortcuts are always blocked. Minimized windows return key_needs_visible_window. Return in a browser's own controls, such as the address bar, returns browser_control_needs_visible_window while the window is fully covered.", snap.merging(["key": str]) { $1 }, ["snapshot", "key"]),
      tool("scroll", "Scroll one retained native control by accessibility. Web pages usually return scroll_not_supported_use_reveal.", snap.merging(["element": element, "direction": ["type": "string", "enum": ["up", "down", "left", "right"]], "amount": ["type": "integer", "minimum": 1, "maximum": 20]]) { $1 }, ["snapshot", "element", "direction", "amount"]),
      tool("reveal", "Scroll a retained numbered control into view. This is the way to scroll a web page.", snap.merging(["element": element]) { $1 }, ["snapshot", "element"])]
  }
}
