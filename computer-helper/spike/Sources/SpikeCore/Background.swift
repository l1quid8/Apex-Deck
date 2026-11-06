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
  private static let uncertain = "type_verification_failed; delivery=delivery_uncertain; retry=unsafe"
  /// What a write call proves. Only an outright refusal means nothing can land later.
  public enum Write { case applied, refused, unknown }
  public static func run(text: String, value: String, selection: NSRange?, gate: () throws -> Void,
    insert: (String) -> Write, replace: (String) -> Write, settled: (String, Double) -> String?) throws {
    guard !text.isEmpty else { return }
    let range = selection ?? NSRange(location: value.utf16.count, length: 0)
    guard range.location >= 0, range.length >= 0, NSMaxRange(range) <= value.utf16.count else {
      throw Refusal("editable_state_changed")
    }
    var pending = false // An earlier write may still land, so nothing can promise it didn't.
    if selection != nil {
      guard let unchanged = try selectedText(text, value: value, range: range, gate: gate, insert: insert, settled: settled) else { return }
      pending = unchanged
    }
    do { try gate() } catch let error as Refusal {
      throw pending ? Refusal("\(error.code); delivery=delivery_uncertain; retry=unsafe") : error
    }
    let expected = (value as NSString).replacingCharacters(in: range, with: text)
    if replace(expected) == .refused {
      throw Refusal(pending ? uncertain : "type_verification_failed; delivery=not_delivered; retry=safe")
    }
    let live = settled(expected, patiently)
    if live == expected { return }
    throw Refusal(live == value ? uncertain : unverified)
  }
  /// Nil when the text went in. Otherwise the first write changed nothing, which is the
  /// cue for the next rung, and the answer says whether that write could still land.
  private static func selectedText(_ text: String, value: String, range: NSRange, gate: () throws -> Void,
    insert: (String) -> Write, settled: (String, Double) -> String?) throws -> Bool? {
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
      let write = insert(piece)
      let live = write == .refused ? current : settled(next, offset == 0 ? quickly : patiently)
      if live != next {
        if offset == 0, live == current { return write != .refused }
        throw Refusal(unverified)
      }
      current = next
      caret = NSRange(location: caret.location + piece.utf16.count, length: 0)
      offset += chunk
    }
    return nil
  }
}

/// A screenshot click has no pointer to send, so it needs a control to press.
public enum PointPress {
  public static func nearest<E>(_ start: E, read: (E) -> (Bool, Bool, E?)?) throws -> E {
    var cursor: E? = start
    var found: E?
    for _ in 0..<Policy.maxAncestry {
      guard let current = cursor, let node = read(current) else { break }
      if node.0 {
        guard let found = found else { throw Refusal("pixel_target_has_no_control") }
        return found
      }
      if found == nil, node.1 { found = current }
      cursor = node.2
    }
    // Reached the top without the screenshot's window: a popover or another window of this app.
    throw Refusal("point_window_mismatch")
  }
}
