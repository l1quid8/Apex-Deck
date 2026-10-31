import AppKit
import ApplicationServices
import SpikeCore

enum TextEditStartupDecision: Equatable {
  case ready, pressNewDocument(Int), dismissOpenPanel, fileNew
}

struct TextEditStartupState {
  var hasWindow = false
  var windowCount = 0
  var role = ""
  var subrole = ""
  var title = ""
  var document: String?
  var modal: Bool?
  var sheets = 0
  var editable = false
  var fileBrowser = false
  var openButtons = 0
  var cancelButtons = 0
  var newDocumentButtons = [Int]()
  var destructiveButtons = false
  func isFreshDocument<Window>(window: Window?, previousWindows: [Window],
    same: (Window, Window) -> Bool, value: String?, range: CFRange?) -> Bool {
    guard let window = window else { return false }
    return isFreshDocument(changedWindow: !previousWindows.contains { same($0, window) },
      value: value, range: range)
  }
  func isFreshDocument(changedWindow: Bool, value: String?, range: CFRange?) -> Bool {
    changedWindow && document == nil && (try? decision()) == .ready && value == ""
      && range?.location == 0 && range?.length == 0
  }
  func decision() throws -> TextEditStartupDecision {
    if !hasWindow {
      guard windowCount == 0 else { throw Refusal("startup_unfocused_windows") }
      return .fileNew
    }
    guard role == kAXWindowRole, sheets == 0 else { throw Refusal("startup_unknown_modal") }
    if subrole == kAXStandardWindowSubrole, modal == false, editable { return .ready }
    guard [kAXDialogSubrole, kAXSystemDialogSubrole].contains(subrole), title == "Open",
      document == nil, modal != nil, windowCount == 1, fileBrowser,
      openButtons == 1, cancelButtons == 1, !destructiveButtons,
      newDocumentButtons.count <= 1
    else { throw Refusal("startup_unsupported_window_or_localization") }
    if let button = newDocumentButtons.first { return .pressNewDocument(button) }
    return .dismissOpenPanel
  }
}

enum TextEditNewMenu {
  static func matches(role: String, title: String, character: String?, modifiers: Int?, enabled: Bool, press: Bool) -> Bool {
    role == kAXMenuItemRole && title == "New" && character == "n" && modifiers == 0 && enabled && press
  }
}

extension Server {
  func prepareTextEdit(id: String, epoch: UInt64) throws -> Snapshot {
    try latch.check(id, epoch: epoch)
    let initial = try observe(id: id, epoch: epoch)
    let deadline = ProcessInfo.processInfo.systemUptime + 6
    let initialState = try startupObservation(initial, id: id, deadline: deadline)
    switch try initialState.state.decision() {
    case .ready: return initial
    case .pressNewDocument(let index):
      guard let button = initialState.buttons[index] else { throw Refusal("startup_button_unavailable") }
      try latch.dispatch(id, epoch: epoch, validate: {
        let live = try self.startupObservation(initial, id: id, deadline: deadline)
        guard try live.state.decision() == .pressNewDocument(index),
          let current = live.buttons[index], same(current.e, button.e),
          current.fingerprint == button.fingerprint
        else { throw Refusal("startup_panel_changed") }
      }, post: {
        guard AXUIElementPerformAction(button.e, kAXPressAction as CFString) == .success else {
          throw Refusal("startup_new_document_failed")
        }
      })
      return try waitForStartupEditor(id: id, epoch: epoch, deadline: deadline, allowNoWindow: false,
        previous: initial, previousWindows: initialState.windows)
    case .dismissOpenPanel:
      // Escape is permitted only after the whole known launch panel is checked.
      // Input.key also checks live focus, launch identity and the original epoch.
      guard try startupObservation(initial, id: id, deadline: deadline).state.decision() == .dismissOpenPanel else {
        throw Refusal("startup_panel_changed")
      }
      try input.key("Escape", s: initial, id: id)
      let fresh = try waitForStartupEditor(id: id, epoch: epoch, deadline: deadline, allowNoWindow: true,
        previous: initial, previousWindows: initialState.windows)
      if try startupObservation(fresh, id: id, deadline: deadline).state.decision() == .ready { return fresh }
      try pressStartupNewMenu(fresh, id: id, deadline: deadline)
    case .fileNew:
      try pressStartupNewMenu(initial, id: id, deadline: deadline)
    }
    return try waitForStartupEditor(id: id, epoch: epoch, deadline: deadline, allowNoWindow: false,
      previous: initial, previousWindows: initialState.windows)
  }

  func createNewTextEditDocument(previous: Snapshot, id: String, epoch: UInt64) throws -> Snapshot {
    try latch.check(id, epoch: epoch)
    guard previous.epoch == epoch else { throw Refusal("human_activity_changed") }
    let deadline = ProcessInfo.processInfo.systemUptime + 3
    let initial = try startupObservation(previous, id: id, deadline: deadline)
    guard try initial.state.decision() == .ready else { throw Refusal("new_document_requires_editor") }
    // Capture every existing window before Cmd-N, so focusing another old blank
    // document cannot satisfy the proof that a new scratch document was made.
    try input.key("Cmd-N", s: previous, id: id)
    return try waitForStartupEditor(id: id, epoch: epoch,
      deadline: deadline, allowNoWindow: false, previous: previous, previousWindows: initial.windows)
  }

  private func waitForStartupEditor(id: String, epoch: UInt64, deadline: Double, allowNoWindow: Bool,
    previous: Snapshot, previousWindows: [AXUIElement]) throws -> Snapshot {
    while ProcessInfo.processInfo.systemUptime < deadline {
      try latch.check(id, epoch: epoch)
      let fresh = try observe(id: id, epoch: epoch)
      guard fresh.app.processIdentifier == previous.app.processIdentifier, fresh.launch == previous.launch else {
        throw Refusal("startup_target_changed")
      }
      let current = try startupObservation(fresh, id: id, deadline: deadline)
      if current.state.isFreshDocument(window: fresh.window, previousWindows: previousWindows,
        same: { same($0, $1) }, value: fresh.value, range: fresh.range) { return fresh }
      if allowNoWindow {
        let decision = try current.state.decision()
        if decision == .fileNew { return fresh }
      } else if current.state.hasWindow,
        !(current.state.role == kAXWindowRole && current.state.subrole == kAXStandardWindowSubrole
          && current.state.modal == false && current.state.sheets == 0) {
        // A known Open panel can remain briefly while AXPress completes. Other
        // modals are refused immediately and receive no follow-up input.
        _ = try current.state.decision()
      }
      Thread.sleep(forTimeInterval: 0.02)
    }
    throw Refusal("startup_editor_unavailable")
  }

  private func startupObservation(_ s: Snapshot, id: String, deadline: Double) throws -> StartupObservation {
    try latch.check(id, epoch: s.epoch)
    let previous = Thread.current.threadDictionary["axDeadline"]
    Thread.current.threadDictionary["axDeadline"] = min(deadline, ProcessInfo.processInfo.systemUptime + 2)
    defer {
      if let previous = previous { Thread.current.threadDictionary["axDeadline"] = previous }
      else { Thread.current.threadDictionary.removeObject(forKey: "axDeadline") }
    }
    guard ax.trusted(), !s.app.isTerminated, s.app.bundleIdentifier == "com.apple.TextEdit",
      s.app.launchDate == s.launch,
      try ax.running("com.apple.TextEdit").processIdentifier == s.app.processIdentifier,
      NSWorkspace.shared.frontmostApplication?.processIdentifier == s.app.processIdentifier,
      let focusedApp = element(ax.system, kAXFocusedApplicationAttribute),
      pid(focusedApp) == s.app.processIdentifier
    else { throw Refusal("startup_target_or_focus_changed") }
    let root = AXUIElementCreateApplication(s.app.processIdentifier)
    guard same(element(root, kAXFocusedWindowAttribute), s.window),
      same(element(root, kAXFocusedUIElementAttribute), s.focus),
      same(element(ax.system, kAXFocusedUIElementAttribute), s.focus),
      s.window.flatMap({ string($0, kAXDocumentAttribute) }) == s.document
    else { throw Refusal("startup_window_document_or_focus_changed") }
    if let focus = s.focus {
      guard pid(focus) == s.app.processIdentifier, safe(focus),
        s.focusFingerprint == fingerprint(focus), attr(focus, kAXEnabledAttribute) as? Bool != false
      else { throw Refusal("startup_protected_or_changed_focus") }
    }
    let windows = try startupElements(root, kAXWindowsAttribute)
    guard windows.allSatisfy({ pid($0) == s.app.processIdentifier && safe($0) }) else {
      throw Refusal("startup_foreign_or_unknown_window")
    }
    var result = StartupObservation()
    result.windows = windows
    result.state.windowCount = windows.count
    if let window = s.window {
      guard windows.filter({ same($0, window) }).count == 1 else { throw Refusal("startup_window_inventory_changed") }
      result.state.hasWindow = true
      result.state.role = string(window, kAXRoleAttribute) ?? ""
      result.state.subrole = string(window, kAXSubroleAttribute) ?? ""
      result.state.title = string(window, kAXTitleAttribute) ?? ""
      result.state.document = s.document
      result.state.modal = attr(window, kAXModalAttribute) as? Bool
      result.state.sheets = try startupElements(window, "AXSheets", absentIsEmpty: true).count
      let children = try startupElements(window, kAXChildrenAttribute, absentIsEmpty: true)
      result.state.sheets += children.filter { string($0, kAXRoleAttribute) == kAXSheetRole }.count
      if let focus = s.focus {
        result.state.editable = string(focus, kAXRoleAttribute) == kAXTextAreaRole
          && startupDescendant(focus, of: window, targetPID: s.app.processIdentifier)
          && s.value != nil && s.range != nil && attr(focus, kAXEnabledAttribute) as? Bool == true
      }
      if [kAXDialogSubrole, kAXSystemDialogSubrole].contains(result.state.subrole), result.state.title == "Open" {
        let defaultButton = element(window, kAXDefaultButtonAttribute)
        var pending: [(AXUIElement, Int)] = [(window, 0)]
        var visited = Set<AXUIElement>()
        while let (node, depth) = pending.popLast() {
          guard depth <= 16, visited.count < 256, ProcessInfo.processInfo.systemUptime < deadline,
            visited.insert(node).inserted, pid(node) == s.app.processIdentifier, safe(node)
          else { throw Refusal("startup_panel_inventory_incomplete") }
          let role = string(node, kAXRoleAttribute) ?? ""
          guard role != kAXUnknownRole else { throw Refusal("startup_panel_inventory_incomplete") }
          if [kAXBrowserRole, kAXOutlineRole, kAXTableRole].contains(role) {
            result.state.fileBrowser = true
            continue // Do not inspect filenames in the browser.
          }
          if role == kAXButtonRole {
            let title = string(node, kAXTitleAttribute) ?? ""
            let enabled = attr(node, kAXEnabledAttribute) as? Bool == true
            let press = startupPressable(node)
            if title == "Open", same(node, defaultButton) { result.state.openButtons += 1 }
            if title == "Cancel", enabled && press { result.state.cancelButtons += 1 }
            if title == "New Document", enabled && press {
              let index = result.buttons.count + 1
              result.buttons[index] = Control(e: node, fingerprint: fingerprint(node), press: true)
              result.state.newDocumentButtons.append(index)
            }
            if ["Save", "Save As", "Don't Save", "Don’t Save", "Discard", "Replace", "Overwrite"].contains(title) {
              result.state.destructiveButtons = true
            }
          }
          pending.append(contentsOf: try startupElements(node, kAXChildrenAttribute, absentIsEmpty: true).map { ($0, depth + 1) })
        }
      }
    } else if let focus = s.focus {
      // With no window, only the application itself may own focus. A stray
      // text field or hidden modal cannot authorize a new document.
      guard string(focus, kAXRoleAttribute) == kAXApplicationRole else { throw Refusal("startup_unknown_focus_without_window") }
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == s.app.processIdentifier,
      !s.app.isTerminated, s.app.launchDate == s.launch,
      same(element(root, kAXFocusedWindowAttribute), s.window),
      same(element(root, kAXFocusedUIElementAttribute), s.focus),
      element(ax.system, kAXFocusedApplicationAttribute).map({ pid($0) }) == s.app.processIdentifier
    else { throw Refusal("startup_target_or_focus_changed") }
    try latch.check(id, epoch: s.epoch)
    guard ProcessInfo.processInfo.systemUptime < deadline else { throw Refusal("startup_deadline") }
    return result
  }

  private func pressStartupNewMenu(_ s: Snapshot, id: String, deadline: Double) throws {
    guard try startupObservation(s, id: id, deadline: deadline).state.decision() == .fileNew else {
      throw Refusal("startup_new_requires_no_window")
    }
    let item = try startupNewMenu(s, deadline: deadline)
    let identity = fingerprint(item)
    try latch.dispatch(id, epoch: s.epoch, validate: {
      guard same(try startupNewMenu(s, deadline: deadline), item), fingerprint(item) == identity,
        try self.startupObservation(s, id: id, deadline: deadline).state.decision() == .fileNew,
        ProcessInfo.processInfo.systemUptime < deadline
      else { throw Refusal("startup_new_menu_changed") }
    }, post: {
      guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else {
        throw Refusal("startup_new_menu_failed")
      }
    })
  }
}

private struct StartupObservation {
  var state = TextEditStartupState()
  var buttons = [Int: Control]()
  var windows = [AXUIElement]()
}

private func startupPressable(_ node: AXUIElement) -> Bool {
  var names: CFArray?
  return AXUIElementCopyActionNames(node, &names) == .success
    && (names as? [String] ?? []).contains(kAXPressAction)
}

private func startupElements(_ node: AXUIElement, _ key: String, absentIsEmpty: Bool = false) throws -> [AXUIElement] {
  if let deadline = Thread.current.threadDictionary["axDeadline"] as? Double,
    ProcessInfo.processInfo.systemUptime >= deadline { throw Refusal("startup_deadline") }
  AXUIElementSetMessagingTimeout(node, 0.1)
  var value: CFTypeRef?
  let status = AXUIElementCopyAttributeValue(node, key as CFString, &value)
  if status == .attributeUnsupported && absentIsEmpty { return [] }
  guard status == .success, let elements = value as? [AXUIElement], elements.count <= 256 else {
    throw Refusal("startup_inventory_unavailable")
  }
  return elements
}

private func startupDescendant(_ node: AXUIElement, of window: AXUIElement, targetPID: pid_t) -> Bool {
  var current: AXUIElement? = node
  for _ in 0..<20 {
    guard let e = current, pid(e) == targetPID else { return false }
    if same(e, window) { return true }
    current = element(e, kAXParentAttribute)
  }
  return false
}

private func startupNewMenu(_ s: Snapshot, deadline: Double) throws -> AXUIElement {
  let previous = Thread.current.threadDictionary["axDeadline"]
  Thread.current.threadDictionary["axDeadline"] = min(deadline, ProcessInfo.processInfo.systemUptime + 2)
  defer {
    if let previous = previous { Thread.current.threadDictionary["axDeadline"] = previous }
    else { Thread.current.threadDictionary.removeObject(forKey: "axDeadline") }
  }
  let root = AXUIElementCreateApplication(s.app.processIdentifier)
  guard let menuBar = element(root, kAXMenuBarAttribute), pid(menuBar) == s.app.processIdentifier, safe(menuBar) else {
    throw Refusal("startup_new_menu_unavailable")
  }
  let fileItems = try startupElements(menuBar, kAXChildrenAttribute).filter {
    pid($0) == s.app.processIdentifier && safe($0)
      && string($0, kAXRoleAttribute) == kAXMenuBarItemRole && string($0, kAXTitleAttribute) == "File"
  }
  guard fileItems.count == 1 else { throw Refusal("startup_file_menu_unavailable_or_localized") }
  let menus = try startupElements(fileItems[0], kAXChildrenAttribute).filter {
    pid($0) == s.app.processIdentifier && safe($0) && string($0, kAXRoleAttribute) == kAXMenuRole
  }
  guard menus.count == 1 else { throw Refusal("startup_new_menu_unavailable") }
  let items = try startupElements(menus[0], kAXChildrenAttribute).filter {
    pid($0) == s.app.processIdentifier && safe($0)
      && TextEditNewMenu.matches(role: string($0, kAXRoleAttribute) ?? "",
        title: string($0, kAXTitleAttribute) ?? "", character: string($0, kAXMenuItemCmdCharAttribute),
        modifiers: (attr($0, kAXMenuItemCmdModifiersAttribute) as? NSNumber)?.intValue,
        enabled: attr($0, kAXEnabledAttribute) as? Bool == true, press: startupPressable($0))
  }
  guard items.count == 1, ProcessInfo.processInfo.systemUptime < deadline else {
    throw Refusal("startup_new_menu_unavailable_or_localized")
  }
  return items[0]
}
