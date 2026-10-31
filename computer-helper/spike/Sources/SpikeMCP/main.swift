import AppKit
import Darwin
import SpikeCore

signal(SIGPIPE, SIG_IGN)
let operatorMode = CommandLine.arguments.dropFirst().first
let allowed: [String: String] = [
  "--status": "spike/status", "--probe-ds4": "spike/probe-ds4",
  "--show-test-dialog": "spike/show-test-dialog",
]
if let mode = operatorMode, allowed[mode] == nil {
  FileHandle.standardError.write(Data("invalid_operator_mode\n".utf8))
  exit(2)
}
let config = NSWorkspace.OpenConfiguration()
config.activates = false
var ready = false
NSWorkspace.shared.openApplication(at: Wire.bundle, configuration: config) { app, _ in
  ready = app != nil
}
let deadline = Date().addingTimeInterval(6)
var fd: Int32 = -1
while Date() < deadline {
  RunLoop.current.run(until: Date().addingTimeInterval(0.02))
  if ready {
    fd = Wire.connect()
    if fd >= 0 { break }
  }
}
guard fd >= 0 else {
  FileHandle.standardError.write(Data("spike_unavailable\n".utf8))
  exit(1)
}
if let mode = operatorMode {
  Wire.send(["jsonrpc": "2.0", "id": 1, "method": allowed[mode]!], fd: fd)
  Wire.responses(fd: fd) { data in
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    close(fd)
    exit(0)
  }
  exit(1)
}
DispatchQueue.global().async {
  Wire.responses(fd: fd) { data in
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
  }
  close(fd)
  exit(0)
}
// The reader never waits for an action response: matching cancellation and EOF
// are delivered to the app while its sequential input worker is occupied.
Wire.lines(fd: STDIN_FILENO) { data in
  guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
    return
  }
  Wire.send(object, fd: fd)
}
shutdown(fd, SHUT_RDWR)
close(fd)
