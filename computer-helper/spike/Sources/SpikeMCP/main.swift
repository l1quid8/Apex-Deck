import AppKit
import Darwin
import SpikeCore

signal(SIGPIPE, SIG_IGN)
let operatorMode = CommandLine.arguments.dropFirst().first
if operatorMode != nil && operatorMode != "--status" { exit(2) }
let environment = ProcessInfo.processInfo.environment
let config = NSWorkspace.OpenConfiguration(); config.activates = false
var fd = Wire.connect()
if fd < 0 {
  NSWorkspace.shared.openApplication(at: Wire.bundle, configuration: config) { _, _ in }
  let deadline = Date().addingTimeInterval(6)
  while fd < 0 && Date() < deadline {
    RunLoop.current.run(until: Date().addingTimeInterval(0.02)); fd = Wire.connect()
  }
}
guard fd >= 0 else {
  FileHandle.standardError.write(Data("unified_computer_use_unavailable\n".utf8)); exit(1)
}
if operatorMode == "--status" {
  Wire.send(["jsonrpc": "2.0", "id": 1, "method": "unified/status"], fd: fd)
  if let line = Wire.firstLine(fd: fd, limit: 65536, timeout: 2) { FileHandle.standardOutput.write(line); FileHandle.standardOutput.write(Data([10])) }
  close(fd); exit(0)
}
if let token = environment["APEX_COMPUTER_TURN_TOKEN"], let thread = environment["APEX_COMPUTER_THREAD_ID"], let participant = environment["APEX_COMPUTER_PARTICIPANT_ID"] {
  Wire.send(["jsonrpc": "2.0", "id": "bind", "method": "unified/bind-turn", "params": ["threadId": thread, "participantId": participant, "turnToken": token]], fd: fd)
  guard let data = Wire.firstLine(fd: fd, limit: 65536, timeout: 2),
    let reply = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
    (reply["result"] as? [String: Any])?["bound"] as? Bool == true else {
    FileHandle.standardError.write(Data("unified_computer_turn_binding_refused\n".utf8)); close(fd); exit(1)
  }
}
// Missing turn context intentionally leaves discovery available, with every call refused.
DispatchQueue.global().async {
  Wire.responses(fd: fd) { data in FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) }
  close(fd); exit(0)
}
Wire.lines(fd: STDIN_FILENO) { data in
  guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
  Wire.send(object, fd: fd)
}
shutdown(fd, SHUT_RDWR); close(fd)
