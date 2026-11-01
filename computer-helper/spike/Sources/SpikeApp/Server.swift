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
}
final class Server {
  let ax = Accessibility()
  var latch: Latch { activeState.latch }
  let turns = TurnRegistry()
  lazy var activity = ActivityTap(latch)
  var input: Input { Input(ax: ax, latch: latch, activity: activity) }
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
  func start() {
    activity.start()
    DispatchQueue.global().async { self.listen() }
  }
  func status() -> [String: Any] {
    let state = activity.latch.state()
    return ["accessibilityTrusted": ax.trusted(), "screenCaptureAccess": CGPreflightScreenCaptureAccess(),
      "listenEventAccess": CGPreflightListenEventAccess(), "tapHealthy": state.2, "stopped": turns.isStopped,
      "cursorOverlayEnabled": CursorOverlaySettings.isEnabled,
      "cursorOverlayLabelsEnabled": CursorOverlaySettings.showLabel,
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
    Wire.lines(fd: client) { data in
      guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let method = object["method"] as? String else { return }
      let params = object["params"] as? [String: Any] ?? [:]
      if method == "notifications/cancelled" { if let id = params["requestId"] { state.latch.cancel(String(describing: id)) }; return }
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
        self.response(id, ["cursorOverlayLabelsEnabled": enabled], client); return
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
      self.activeLock.lock()
      let busy = self.activeID != nil
      if !busy { self.activeID = String(describing: id) }
      self.activeLock.unlock()
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
          let epoch = params["name"] as? String == "list_apps" ? state.latch.state().0 : (self.snapshot?.epoch ?? state.latch.state().0)
          _ = Wire.publishScreenshot(["jsonrpc": "2.0", "id": id, "result": result], fd: client, output: self.output,
            check: { try self.turns.check(state.token); try state.latch.check(request, epoch: epoch) },
            invalidate: { state.imageScope = nil; state.snapshot = nil; state.engine.invalidate(); state.latch.stop() })
        } catch let error as Refusal {
          let code = state.engine.failureCode(error.code)
          if EngineSession.keepsObservation(tool: params["name"] as? String ?? "", code: code) {
            CursorOverlayIntegration.cleanupOnStop()
            self.fail(id, code, client)
            return
          }
          state.imageScope = nil; state.snapshot = nil; state.engine.invalidate()
          if let note = EngineSession.deliveredNote(code) {
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
  func observe(id: String, epoch: UInt64? = nil) throws -> Snapshot {
    try checkProofHost()
    let expected = epoch ?? latch.state().0
    try latch.check(id, epoch: expected)
    let fresh = try ax.capture(epoch: expected)
    try latch.check(id, epoch: expected)
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
      let rows = apps.prefix(100).map { ["app": $0.bundleIdentifier ?? "", "name": $0.localizedName ?? ""] }
      let bytes = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
      return ["content": [["type": "text", "text": String(data: bytes, encoding: .utf8) ?? "[]"]]]
    }
    if name == "request_app" { try requestApp(args, token: token, id: id) }
    else { try checkProofHost() }
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
      // Visual overlay: show target before physical click
      CursorOverlayIntegration.showAtImagePoint(x: x, y: y, scope: scope, label: "Click (\(Int(x)),\(Int(y)))", action: .point)
      activeState.imageScope = nil
      try input.point(x: x, y: y, scope: scope, s: s, id: id)
      engineSession.recordUnverifiedInput()
      snapshot = try observe(id: id, epoch: s.epoch)
      CursorOverlayIntegration.hideAfterAction()
    } else if name != "request_app" {
      _ = try callText(params, id: id)
      CursorOverlayIntegration.hideAfterAction()
    }
    activeState.imageScope = nil
    guard let native = snapshot else { throw Refusal("observation_unavailable") }
    let bound = try engineSession.capture(native: native, id: id, latch: latch, ax: ax)
    snapshot = bound
    return ["content": [["type": "text", "text": bound.output]]]
  }
  func requestApp(_ args: [String: Any], token: String, id: String) throws {
    guard Set(args.keys) == ["app"], let bundle = args["app"] as? String, Policy.target(bundle),
      let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { throw Refusal("protected_or_unavailable_app") }
    let identity = try AppIdentity.capture(url, bundle: bundle)
    if (try? turns.identity(bundle, token: token)) != identity {
      let control = try turns.canControl(token)
      let owner = try turns.requester(token)
      let prompt = AppGrantPrompt(text: "Requested by: \(owner.1.prefix(64))\nThread: \(owner.0.prefix(64))\n\nA bot wants to \(control ? "read and control" : "read") \(Bundle(url: url)?.object(forInfoDictionaryKey: "CFBundleName") as? String ?? bundle).\n\n\(bundle)\n\(identity.path)\n\nAllow Once ends with this bot's turn. Allow for This Work Thread lets every supported bot in this thread use this app, with no more prompts, until you press Stop or access is revoked. Other threads still ask. Password fields and system security settings are protected.")
      DispatchQueue.main.async { prompt.show() }
      defer { DispatchQueue.main.async { prompt.dismiss() } }
      let deadline = ProcessInfo.processInfo.systemUptime + 120
      while prompt.decision() == nil {
        try turns.check(token); try latch.check(id)
        guard ProcessInfo.processInfo.systemUptime < deadline else { throw Refusal("app_grant_deadline") }
        Thread.sleep(forTimeInterval: 0.02)
      }
      let decision = prompt.decision()
      try turns.check(token)
      guard decision != .denied else { throw Refusal("app_grant_denied") }
      try turns.grant(identity, token: token, forThread: decision == .thread)
    }
    let control = try turns.canControl(token)
    if control, try lease.claim(token) { activity.invalidateObservations() }
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter { !$0.isTerminated }
    guard running.count <= 1 else { throw Refusal("target_ambiguous") }
    if control {
      let completion = DispatchSemaphore(value: 0)
      DispatchQueue.main.async {
        guard (try? self.turns.check(token)) != nil else { completion.signal(); return }
        let config = NSWorkspace.OpenConfiguration(); config.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: config) { _, _ in completion.signal() }
      }
      let deadline = ProcessInfo.processInfo.systemUptime + 5
      while completion.wait(timeout: .now() + 0.02) != .success {
        try turns.check(token); try latch.check(id)
        guard ProcessInfo.processInfo.systemUptime < deadline else { throw Refusal("launch_deadline") }
      }
    } else if running.isEmpty { throw Refusal("read_access_cannot_launch_app") }
    try turns.check(token)
    activeState.target = bundle; ax.targetBundle = bundle
    let app = try ax.running(bundle); try identity.validate(app)
    // User grant/focus changes deliberately require a fresh activity epoch.
    snapshot = try observe(id: id)
  }
  func callText(_ params: [String: Any], id: String) throws -> String {
    try latch.check(id)
    try checkProofHost()
    let name = params["name"] as? String ?? ""
    let args = params["arguments"] as? [String: Any] ?? [:]
    if name == "read_screen" { guard args.isEmpty else { throw Refusal("unexpected_arguments") }; snapshot = try observe(id: id); return snapshot!.output }
    guard let token = activeState.token, try turns.canControl(token) else { throw Refusal("observation_only_access") }
    guard let s = snapshot, args["snapshot"] as? String == s.id, engineSession.current?.id == s.id else { throw Refusal("fresh_snapshot_required") }
    switch name {
    case "click":
      guard Set(args.keys) == ["snapshot", "element"], let number = args["element"] as? Int else { throw Refusal("invalid_arguments") }
      // Blocker 2: Do NOT infer position from native.controls[element-1]. The
      // ref-to-target rect is shown inside EngineCheck.validate via the actual
      // engine-resolved AX element (minimal hook coordinated with Jigga).
      try engineSession.click(element: number, s: s, id: id, latch: latch, ax: ax)
    case "type_text":
      guard Set(args.keys) == ["snapshot", "text"], let text = args["text"] as? String else { throw Refusal("invalid_arguments") }
      // Blocker 3: generic label, no echo of submitted content.
      try engineSession.type(text: text, s: s, id: id, latch: latch, ax: ax)
    case "press_key":
      guard Set(args.keys) == ["snapshot", "key"], let key = args["key"] as? String else { throw Refusal("invalid_arguments") }
      // Generic label for key, show at focus only as fallback before validation
      CursorOverlayIntegration.showForFocus(snapshot: s, label: key == "" ? "Key" : key, action: .generic)
      try input.key(key, s: s, id: id)
      engineSession.recordUnverifiedInput()
    case "scroll":
      guard Set(args.keys) == ["snapshot", "element", "direction", "amount"], let number = args["element"] as? Int,
        let direction = args["direction"] as? String, let amount = args["amount"] as? Int,
        ["up", "down", "left", "right"].contains(direction), (1...20).contains(amount) else { throw Refusal("invalid_arguments") }
      // Blocker 2: overlay is shown in EngineCheck at actual resolved target.
      try engineSession.scroll(element: number, direction: direction, amount: amount, s: s, id: id, latch: latch, ax: ax)
    default: throw Refusal("unknown_tool")
    }
    snapshot = try observe(id: id, epoch: s.epoch)
    return snapshot!.output
  }
  static var tools: [[String: Any]] {
    func tool(_ name: String, _ description: String, _ properties: [String: Any], _ required: [String], _ read: Bool = false) -> [String: Any] {
      ["name": name, "description": description, "inputSchema": ["type": "object", "properties": properties, "required": required, "additionalProperties": false],
        "annotations": ["readOnlyHint": read, "destructiveHint": false, "openWorldHint": false]]
    }
    let str: [String: Any] = ["type": "string"]
    let snap: [String: Any] = ["snapshot": str]
    return [tool("list_apps", "List running eligible native apps. Requires an enabled active session.", [:], [], true),
      tool("request_app", "Request a native per-app session grant by bundle ID. Observation-only sessions cannot launch or focus apps.", ["app": str], ["app"]),
      tool("read_screen", "Read the granted app's current verified window and retained element references.", [:], [], true), ScreenshotPolicy.tool,
      tool("click", "Activate one retained numbered control in a fresh snapshot.", snap.merging(["element": ["type": "integer", "minimum": 1]]) { $1 }, ["snapshot", "element"]),
      tool("click_point", "Click a point in the current granted window screenshot. x/y are image pixels; requires its image_snapshot and a writable session.", snap.merging(["x": ["type": "number", "minimum": 0], "y": ["type": "number", "minimum": 0]]) { $1 }, ["snapshot", "x", "y"]),
      tool("type_text", "Type text into the verified focused field. Reports element delivery; application commit is not verified.", snap.merging(["text": ["type": "string", "maxLength": 65536]]) { $1 }, ["snapshot", "text"]),
      tool("press_key", "Press a named key on the verified app, such as Return, PageDown or Cmd-T. Modifiers are Cmd-, Shift-, Alt- and Control-.", snap.merging(["key": str]) { $1 }, ["snapshot", "key"]),
      tool("scroll", "Scroll one retained native control in a fresh snapshot.", snap.merging(["element": ["type": "integer", "minimum": 1], "direction": ["type": "string", "enum": ["up", "down", "left", "right"]], "amount": ["type": "integer", "minimum": 1, "maximum": 20]]) { $1 }, ["snapshot", "element", "direction", "amount"])]
  }
}
