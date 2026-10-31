import AppKit
import Darwin
import SpikeCore

final class Server {
  let ax = Accessibility()
  let latch = Latch()
  lazy var activity = ActivityTap(latch)
  lazy var input = Input(ax: ax, latch: latch, activity: activity)
  let queue = DispatchQueue(label: "spike.actions")
  let connection = NSLock()
  var connectionOpen = false
  let output = NSLock()
  let activeLock = NSLock()
  var activeID: String?
  var snapshot: Snapshot?
  var fd: Int32 = -1
  var showDialog: (() -> Void)?
  let probeLock = NSLock()
  var probePresses = 0
  var probeCenter: [Double]?
  func recordProbe(center: [Double]? = nil, pressed: Bool = false) {
    probeLock.lock()
    defer { probeLock.unlock() }
    if let center = center { probeCenter = center }
    if pressed { probePresses += 1 }
  }
  func start() {
    activity.start()
    DispatchQueue.global().async { self.listen() }
  }
  func status() -> [String: Any] {
    let state = latch.state()
    probeLock.lock()
    let probe: [String: Any] = ["presses": probePresses, "center": probeCenter as Any? ?? NSNull()]
    probeLock.unlock()
    return [
      "eventCounts": latch.counts(), "syntheticDialog": probe, "accessibilityTrusted": ax.trusted(),
      "listenEventAccess": CGPreflightListenEventAccess(), "tapHealthy": state.2,
      "stopped": state.1, "pid": ProcessInfo.processInfo.processIdentifier,
    ]
  }
  func send(_ value: [String: Any], _ client: Int32) {
    output.lock()
    defer { output.unlock() }
    Wire.send(value, fd: client)
  }
  func response(_ id: Any, _ result: [String: Any], _ client: Int32) {
    send(["jsonrpc": "2.0", "id": id, "result": result], client)
  }
  func fail(_ id: Any, _ code: String, _ client: Int32) {
    response(id, ["isError": true, "content": [["type": "text", "text": code]]], client)
  }
  func listen() {
    signal(SIGPIPE, SIG_IGN)
    unlink(Wire.socketPath)
    fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(Wire.socketPath.utf8) + [0]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { return }
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    let ok = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard ok == 0, Darwin.listen(fd, 2) == 0 else { return }
    chmod(Wire.socketPath, 0o600)
    while true {
      let client = accept(fd, nil, nil)
      if client < 0 { return }
      connection.lock()
      let admitted = !connectionOpen
      if admitted { connectionOpen = true }
      connection.unlock()
      guard admitted else {
        close(client)
        continue
      }
      DispatchQueue.global().async { self.read(client) }
    }
  }
  func read(_ client: Int32) {
    defer {
      latch.stop()
      queue.async {
        close(client)
        self.connection.lock()
        self.connectionOpen = false
        self.connection.unlock()
      }
    }
    Wire.lines(fd: client) { data in
      guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        let method = object["method"] as? String
      else { return }
      let params = object["params"] as? [String: Any] ?? [:]
      if method == "notifications/cancelled" {
        if let id = params["requestId"] { self.latch.cancel(String(describing: id)) }
        return
      }
      guard let id = object["id"] else { return }
      if method == "spike/status" {
        self.response(id, self.status(), client)
        return
      }
      if method == "spike/show-test-dialog" {
        self.queue.async {
          DispatchQueue.main.sync { self.showDialog?() }
          self.response(id, self.status(), client)
        }
        return
      }
      if method == "spike/probe-ds4" {
        self.queue.async {
          do { self.response(id, try self.ax.probeDS4(), client) } catch let error as Refusal {
            self.fail(id, error.code, client)
          } catch { self.fail(id, "probe_failed", client) }
        }
        return
      }
      if method == "initialize" {
        self.response(
          id,
          [
            "protocolVersion": "2025-06-18", "capabilities": ["tools": [:]],
            "serverInfo": ["name": "apex-computer", "version": "0.1.0-spike"],
          ], client)
        return
      }
      if method == "ping" {
        self.response(id, [:], client)
        return
      }
      if method == "tools/list" {
        self.response(id, ["tools": Self.tools], client)
        return
      }
      if method != "tools/call" {
        self.send(
          ["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "Method not found"]],
          client)
        return
      }
      self.activeLock.lock()
      let busy = self.activeID != nil
      if !busy { self.activeID = String(describing: id) }
      self.activeLock.unlock()
      if busy {
        self.fail(id, "action_busy", client)
        return
      }
      self.queue.async {
        defer {
          self.activeLock.lock()
          self.activeID = nil
          self.activeLock.unlock()
        }
        do {
          let result = try self.call(params, id: String(describing: id))
          self.response(id, result, client)
        } catch let error as Refusal {
          self.snapshot = nil
          // A screenshot refusal must not do an extra AX read after Stop or
          // a missing permission; only a successful request exports its pair.
          let screenshot = params["name"] as? String == "get_screenshot"
          let fresh = screenshot ? nil : (try? self.ax.capture(epoch: self.latch.state().0))?.output
          self.fail(
            id,
            error.code
              + (fresh.map { "\nFresh reading (control still requires a new request):\n" + $0 }
                ?? ""),
            client)
        } catch {
          self.snapshot = nil
          self.fail(id, "internal_error", client)
        }
      }
    }
  }
  func call(_ params: [String: Any], id: String) throws -> [String: Any] {
    if params["name"] as? String == "get_screenshot" {
      guard (params["arguments"] as? [String: Any] ?? [:]).isEmpty else {
        throw Refusal("get_screenshot_takes_no_arguments")
      }
      try latch.check(id)
      guard #available(macOS 14.2, *) else { throw Refusal("single_window_screenshot_requires_macOS_14_2") }
      let (fresh, result) = try WindowScreenshot(ax: ax, latch: latch).capture(id: id)
      try latch.check(id, epoch: fresh.epoch)
      snapshot = fresh
      return result
    }
    return ["content": [["type": "text", "text": try callText(params, id: id)]]]
  }
  func callText(_ params: [String: Any], id: String) throws -> String {
    let name = params["name"] as? String ?? ""
    let args = params["arguments"] as? [String: Any] ?? [:]
    if name == "read_screen" {
      let s = try ax.capture(epoch: latch.state().0)
      snapshot = s
      return s.output
    }
    try latch.check(id)
    guard ax.trusted() else { throw Refusal("accessibility_not_trusted") }
    if name == "request_app" {
      guard let bundle = args["app"] as? String, Policy.target(bundle),
        let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle)
      else { throw Refusal("only_TextEdit_allowed") }
      guard
        NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter({
          !$0.isTerminated
        }).count <= 1
      else { throw Refusal("target_ambiguous") }
      let semaphore = DispatchSemaphore(value: 0)
      var launched: NSRunningApplication?
      DispatchQueue.main.async {
        guard (try? self.latch.check(id)) != nil else {
          semaphore.signal()
          return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: config) { app, _ in
          launched = app
          semaphore.signal()
        }
      }
      guard semaphore.wait(timeout: .now() + 5) == .success, launched != nil else {
        throw Refusal("launch_failed")
      }
      try latch.check(id)
      let end = ProcessInfo.processInfo.systemUptime + 2
      while NSWorkspace.shared.frontmostApplication?.bundleIdentifier != bundle
        && ProcessInfo.processInfo.systemUptime < end
      {
        try latch.check(id)
        Thread.sleep(forTimeInterval: 0.02)
      }
    } else {
      guard let s = snapshot, args["snapshot"] as? String == s.id else {
        throw Refusal("fresh_snapshot_required")
      }
      switch name {
      case "click":
        guard let number = args["element"] as? Int else { throw Refusal("element_required") }
        try input.click(number, s: s, id: id)
      case "type_text":
        guard let text = args["text"] as? String else { throw Refusal("text_required") }
        let count = try input.text(text, s: s, id: id)
        let fresh = try ax.capture(epoch: latch.state().0)
        snapshot = fresh
        return "delivered_clusters: \(count)\n" + fresh.output
      case "press_key":
        guard let key = args["key"] as? String else { throw Refusal("key_required") }
        try input.key(key, s: s, id: id)
      default: throw Refusal("unknown_tool")
      }
    }
    let s = try ax.capture(epoch: latch.state().0)
    snapshot = s
    return s.output
  }
  static var tools: [[String: Any]] {
    func tool(
      _ name: String, _ description: String, _ properties: [String: Any], _ required: [String],
      _ read: Bool = false
    ) -> [String: Any] {
      [
        "name": name, "description": description,
        "inputSchema": [
          "type": "object", "properties": properties, "required": required,
          "additionalProperties": false,
        ], "annotations": ["readOnlyHint": read, "destructiveHint": false, "openWorldHint": false],
      ]
    }
    let str: [String: Any] = ["type": "string"]
    let snapshot: [String: Any] = ["snapshot": str]
    return [
      tool(
        "request_app", "Launch/focus only com.apple.TextEdit for this isolated native proof.",
        ["app": ["type": "string", "enum": ["com.apple.TextEdit"]]], ["app"]),
      tool(
        "read_screen", "Read bounded TextEdit AX list without launching/focusing it.", [:], [], true
      ),
      ScreenshotPolicy.tool,
      tool(
        "click", "Activate one current numbered AX control.",
        snapshot.merging(["element": ["type": "integer", "minimum": 1]]) { $1 },
        ["snapshot", "element"]),
      tool(
        "type_text", "Type at most 256 grapheme clusters; no clipboard or control characters.",
        snapshot.merging(["text": ["type": "string", "maxLength": 2048]]) { $1 },
        ["snapshot", "text"]),
      tool(
        "press_key", "Fixed TextEdit task shortcut only.",
        snapshot.merging([
          "key": [
            "type": "string",
            "enum": [
              "Cmd-N", "Shift-Cmd-T", "Cmd-S", "Shift-Cmd-G", "Return", "Escape", "Tab", "Left",
              "Right", "Up", "Down",
            ],
          ]
        ]) { $1 }, ["snapshot", "key"]),
    ]
  }
}
