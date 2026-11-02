import Foundation

/// Operator configuration for the supervised local proof, not a session capability.
public struct ProofBinding {
  public let room: String
  public let participant: String
  public let socket: String
  public init(room: String, participant: String, socket: String) throws {
    func identifier(_ value: String) -> Bool {
      !value.isEmpty && value.utf8.count <= 128 && value.unicodeScalars.allSatisfy {
        CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.").contains($0)
      }
    }
    guard identifier(room), identifier(participant), socket.hasPrefix("/"),
      socket.utf8.count < 104, !socket.utf8.contains(0) else { throw Refusal("proof_binding_invalid") }
    self.room = room; self.participant = participant; self.socket = socket
  }
  public static func environment(_ environment: [String: String]) throws -> ProofBinding? {
    let keys = ["APEX_COMPUTER_PROOF_ROOM", "APEX_COMPUTER_PROOF_PARTICIPANT", "APEX_COMPUTER_PROOF_HOST_SOCKET"]
    guard keys.contains(where: { environment[$0] != nil }) else { return nil }
    guard let room = environment[keys[0]], let participant = environment[keys[1]],
      let socket = environment[keys[2]] else { throw Refusal("proof_binding_incomplete") }
    return try ProofBinding(room: room, participant: participant, socket: socket)
  }
  public var arguments: [String: String] { ["room": room, "participant": participant, "socket": socket] }
}
