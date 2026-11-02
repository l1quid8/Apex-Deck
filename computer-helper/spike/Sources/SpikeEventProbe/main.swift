import AppKit
import CoreGraphics
import Darwin
// Operator-only synthetic event exposure probe. Never registered as MCP.
import Foundation
import SpikeCore

let modes = CommandLine.arguments.dropFirst()
guard modes.count == 1, let mode = modes.first, mode == "--untagged-dialog-click" else {
  fputs("Explicit supervised probe mode required\n", stderr)
  exit(2)
}
let fd = Wire.connect()
guard fd >= 0 else { exit(1) }
Wire.send(["jsonrpc": "2.0", "id": 1, "method": "spike/status"], fd: fd)
Wire.lines(fd: fd) { data in
  guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
    let result = object["result"] as? [String: Any],
    let probe = result["syntheticDialog"] as? [String: Any],
    let center = probe["center"] as? [Double], center.count == 2
  else { exit(1) }
  guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "dev.apexdeck.computer.spike",
    NSWorkspace.shared.frontmostApplication?.processIdentifier == result["pid"] as? Int32
  else {
    fputs("Test dialog must remain frontmost\n", stderr)
    exit(1)
  }
  let point = CGPoint(x: center[0], y: center[1])
  let source = CGEventSource(stateID: .privateState)
  guard
    let down = CGEvent(
      mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: point,
      mouseButton: .left),
    let up = CGEvent(
      mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: point,
      mouseButton: .left)
  else { exit(1) }
  for event in [down, up] {
    event.flags = []
    event.setIntegerValueField(.eventSourceUserData, value: 0)
  }
  down.post(tap: .cgSessionEventTap)
  up.post(tap: .cgSessionEventTap)
  close(fd)
  exit(0)
}
