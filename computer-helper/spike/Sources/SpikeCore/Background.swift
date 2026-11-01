import Foundation

/// Text entry with no focus or keyboard. API success proves nothing here: `AXSelectedText`
/// reports success and does nothing on web fields, so every rung is judged by reading back.
public enum TypeLadder {
  /// Stop can only act between writes, so long text goes in as several.
  public static let chunk = 64
  /// Long enough to see `AXSelectedText` do nothing. A wrong guess only costs a value write.
  public static let quickly = 0.4
  /// A covered Chromium page reports new values slowly, and a late answer isn't a failure.
  public static let patiently = 2.0
  private static let unverified = "type_verification_failed; delivery=delivered_unverified; retry=unsafe"
  public static func run(text: String, value: String, selection: NSRange?, gate: () throws -> Void,
    insert: (String) -> Bool, replace: (String) -> Bool, settled: (String, Double) -> String?) throws {
    guard !text.isEmpty else { return }
    let range = selection ?? NSRange(location: value.utf16.count, length: 0)
    guard range.location >= 0, range.length >= 0, NSMaxRange(range) <= value.utf16.count else {
      throw Refusal("editable_state_changed")
    }
    if selection != nil, try selectedText(text, value: value, range: range, gate: gate, insert: insert, settled: settled) { return }
    try gate()
    let expected = (value as NSString).replacingCharacters(in: range, with: text)
    guard replace(expected) else { throw Refusal("type_verification_failed; delivery=not_delivered; retry=safe") }
    let live = settled(expected, patiently)
    if live == expected { return }
    throw Refusal(live == value ? "type_verification_failed; delivery=delivery_uncertain; retry=unsafe" : unverified)
  }
  /// False only when the first write changed nothing, which is the cue for the next rung.
  private static func selectedText(_ text: String, value: String, range: NSRange, gate: () throws -> Void,
    insert: (String) -> Bool, settled: (String, Double) -> String?) throws -> Bool {
    let characters = Array(text)
    var current = value
    var caret = range
    var offset = 0
    while offset < characters.count {
      let piece = String(characters[offset..<min(offset + chunk, characters.count)])
      do { try gate() } catch let error as Refusal {
        throw offset == 0 ? error : Refusal("\(error.code); delivery=delivered_unverified; retry=unsafe")
      }
      let next = (current as NSString).replacingCharacters(in: caret, with: piece)
      let accepted = insert(piece)
      let live = accepted ? settled(next, offset == 0 ? quickly : patiently) : current
      if live != next {
        if offset == 0, live == current { return false }
        throw Refusal(unverified)
      }
      current = next
      caret = NSRange(location: caret.location + piece.utf16.count, length: 0)
      offset += chunk
    }
    return true
  }
}

/// A screenshot click has no pointer to send, so it needs a control to press.
public enum PointPress {
  public static func nearest<E>(_ start: E, read: (E) -> (Bool, Bool, E?)?) throws -> E {
    var cursor: E? = start
    for _ in 0..<Policy.maxAncestry {
      guard let current = cursor, let node = read(current) else { break }
      if node.0 { throw Refusal("pixel_target_has_no_control") }
      if node.1 { return current }
      cursor = node.2
    }
    throw Refusal("point_window_mismatch")
  }
}
