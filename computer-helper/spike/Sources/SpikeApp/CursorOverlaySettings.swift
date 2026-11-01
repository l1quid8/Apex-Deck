import Foundation

/// Persistent visual cursor overlay preferences – mirrors Rust host prefs
/// in crates/apex-host/src/cursor_overlay.rs and vendor constants in
/// agent-desktop cursor_overlay/style.rs + image.rs + motion_profile.rs.
///
/// Stored in UserDefaults inside the helper's domain. No new permissions.
/// Default is enabled so the large pointer is visible during computer-use
/// sessions unless the user explicitly disables it.
enum CursorOverlaySettings {
  // MARK: - Keys (legacy + full prefs blob)
  static let defaultsKey = "com.apex.unifiedComputerUse.cursorOverlayEnabled"
  static let labelKey = "com.apex.unifiedComputerUse.cursorOverlayLabelEnabled"
  static let blobKey = "com.apex.unifiedComputerUse.cursorOverlayPrefs"
  static let presetKey = "com.apex.unifiedComputerUse.cursorOverlayPreset"
  static let sizeKey = "com.apex.unifiedComputerUse.cursorOverlaySize"
  static let fillKey = "com.apex.unifiedComputerUse.cursorOverlayFill"
  static let rimKey = "com.apex.unifiedComputerUse.cursorOverlayRim"
  static let accentKey = "com.apex.unifiedComputerUse.cursorOverlayAccent"
  static let rippleKey = "com.apex.unifiedComputerUse.cursorOverlayRipple"
  static let highlightKey = "com.apex.unifiedComputerUse.cursorOverlayHighlight"
  static let travelMinKey = "com.apex.unifiedComputerUse.cursorOverlayTravelMin"
  static let travelMaxKey = "com.apex.unifiedComputerUse.cursorOverlayTravelMax"
  static let dwellKey = "com.apex.unifiedComputerUse.cursorOverlayDwell"
  static let bowKey = "com.apex.unifiedComputerUse.cursorOverlayBow"
  static let overshootKey = "com.apex.unifiedComputerUse.cursorOverlayOvershoot"
  static let tremorKey = "com.apex.unifiedComputerUse.cursorOverlayTremor"
  static let customImageKey = "com.apex.unifiedComputerUse.cursorOverlayCustomImage"
  static let hotspotXKey = "com.apex.unifiedComputerUse.cursorOverlayHotspotX"
  static let hotspotYKey = "com.apex.unifiedComputerUse.cursorOverlayHotspotY"

  // MARK: - Enabled / labels (legacy keys preserved)

  static var isEnabled: Bool {
    get {
      if UserDefaults.standard.object(forKey: defaultsKey) == nil { return true }
      return UserDefaults.standard.bool(forKey: defaultsKey)
    }
    set { UserDefaults.standard.set(newValue, forKey: defaultsKey) }
  }

  static var showLabel: Bool {
    get {
      if UserDefaults.standard.object(forKey: labelKey) == nil { return false }
      return UserDefaults.standard.bool(forKey: labelKey)
    }
    set { UserDefaults.standard.set(newValue, forKey: labelKey) }
  }

  // MARK: - Preset

  enum Preset: String {
    case `default` = "default"
    case simple = "simple"
    case ringOnly = "ring-only"
    case custom = "custom"
    init(fromAny value: Any?) {
      guard let s = value as? String else { self = .default; return }
      switch s.lowercased() {
      case "simple": self = .simple
      case "ring-only", "ringonly", "ring_only": self = .ringOnly
      case "custom": self = .custom
      default: self = .default
      }
    }
  }

  static var preset: Preset {
    get {
      if let raw = UserDefaults.standard.string(forKey: presetKey) {
        return Preset(fromAny: raw)
      }
      // Try blob
      if let blob = UserDefaults.standard.dictionary(forKey: blobKey), let p = blob["preset"] as? String {
        return Preset(fromAny: p)
      }
      return .default
    }
    set { UserDefaults.standard.set(newValue.rawValue, forKey: presetKey) }
  }

  // MARK: - Size 0.5...4.0

  static var size: Double {
    get {
      let stored = UserDefaults.standard.object(forKey: sizeKey)
      if let d = stored as? Double, (0.5...4.0).contains(d) { return d }
      if let n = stored as? NSNumber { let d = n.doubleValue; if (0.5...4.0).contains(d) { return d } }
      if let blob = UserDefaults.standard.dictionary(forKey: blobKey), let v = blob["size"] as? Double, (0.5...4.0).contains(v) { return v }
      return 1.0
    }
    set { UserDefaults.standard.set(max(0.5, min(4.0, newValue)), forKey: sizeKey) }
  }

  // MARK: - Colors (hex #FFF or #FFFFFF)

  static let defaultFillHex: String? = nil
  static let defaultRimHex = "#111318"
  static let defaultAccentHex = "#4299FF"

  static func validateHex(_ s: String) -> Bool {
    var hex = s.trimmingCharacters(in: .whitespacesAndNewlines)
    if hex.hasPrefix("#") { hex.removeFirst() }
    return (hex.count == 3 || hex.count == 6) && hex.allSatisfy({ $0.isHexDigit })
  }

  static var fillHex: String? {
    get {
      if let v = UserDefaults.standard.string(forKey: fillKey), validateHex(v) { return v }
      return defaultFillHex
    }
    set {
      if let v = newValue, !v.isEmpty {
        guard validateHex(v) else { return }
        UserDefaults.standard.set(v, forKey: fillKey)
      } else {
        UserDefaults.standard.removeObject(forKey: fillKey)
      }
    }
  }

  static var rimHex: String? {
    get {
      if let v = UserDefaults.standard.string(forKey: rimKey), validateHex(v) { return v }
      return defaultRimHex
    }
    set {
      guard let v = newValue, !v.isEmpty, validateHex(v) else {
        if newValue == nil { UserDefaults.standard.removeObject(forKey: rimKey) }
        return
      }
      UserDefaults.standard.set(v, forKey: rimKey)
    }
  }

  static var accentHex: String {
    get {
      if let v = UserDefaults.standard.string(forKey: accentKey), validateHex(v) { return v }
      return defaultAccentHex
    }
    set {
      guard validateHex(newValue) else { return }
      UserDefaults.standard.set(newValue, forKey: accentKey)
    }
  }

  // MARK: - Effects

  static var ripple: Bool {
    get {
      if UserDefaults.standard.object(forKey: rippleKey) != nil { return UserDefaults.standard.bool(forKey: rippleKey) }
      if let blob = UserDefaults.standard.dictionary(forKey: blobKey), let v = blob["ripple"] as? Bool { return v }
      return true
    }
    set { UserDefaults.standard.set(newValue, forKey: rippleKey) }
  }

  static var highlight: Bool {
    get {
      if UserDefaults.standard.object(forKey: highlightKey) != nil { return UserDefaults.standard.bool(forKey: highlightKey) }
      if let blob = UserDefaults.standard.dictionary(forKey: blobKey), let v = blob["highlight"] as? Bool { return v }
      return true
    }
    set { UserDefaults.standard.set(newValue, forKey: highlightKey) }
  }

  // MARK: - Motion (travel, dwell, path shape)

  static var travelMinMs: Int {
    get {
      if let v = UserDefaults.standard.object(forKey: travelMinKey) as? Int { return v }
      if let n = UserDefaults.standard.object(forKey: travelMinKey) as? NSNumber { return n.intValue }
      if let blob = UserDefaults.standard.dictionary(forKey: blobKey), let motion = blob["motion"] as? [String: Any], let v = motion["travelMinMs"] as? Int { return v }
      return 90
    }
    set { UserDefaults.standard.set(max(30, newValue), forKey: travelMinKey) }
  }

  static var travelMaxMs: Int {
    get {
      if let v = UserDefaults.standard.object(forKey: travelMaxKey) as? Int { return v }
      if let n = UserDefaults.standard.object(forKey: travelMaxKey) as? NSNumber { return n.intValue }
      if let blob = UserDefaults.standard.dictionary(forKey: blobKey), let motion = blob["motion"] as? [String: Any], let v = motion["travelMaxMs"] as? Int { return v }
      return 320
    }
    set { UserDefaults.standard.set(newValue, forKey: travelMaxKey) }
  }

  static var dwellMs: Int {
    get {
      if let v = UserDefaults.standard.object(forKey: dwellKey) as? Int { return v }
      if let n = UserDefaults.standard.object(forKey: dwellKey) as? NSNumber { return n.intValue }
      if let blob = UserDefaults.standard.dictionary(forKey: blobKey), let motion = blob["motion"] as? [String: Any], let v = motion["dwellMs"] as? Int { return v }
      return 0
    }
    set { UserDefaults.standard.set(max(0, min(300, newValue)), forKey: dwellKey) }
  }

  static var bow: Double {
    get {
      if let v = UserDefaults.standard.object(forKey: bowKey) as? Double { return v }
      if let n = UserDefaults.standard.object(forKey: bowKey) as? NSNumber { return n.doubleValue }
      if let blob = UserDefaults.standard.dictionary(forKey: blobKey), let motion = blob["motion"] as? [String: Any], let v = motion["bow"] as? Double { return v }
      return 1.0
    }
    set { UserDefaults.standard.set(max(0, min(3, newValue)), forKey: bowKey) }
  }

  static var overshoot: Double {
    get {
      if let v = UserDefaults.standard.object(forKey: overshootKey) as? Double { return v }
      if let n = UserDefaults.standard.object(forKey: overshootKey) as? NSNumber { return n.doubleValue }
      if let blob = UserDefaults.standard.dictionary(forKey: blobKey), let motion = blob["motion"] as? [String: Any], let v = motion["overshoot"] as? Double { return v }
      return 0.035
    }
    set { UserDefaults.standard.set(max(0, min(0.15, newValue)), forKey: overshootKey) }
  }

  static var tremor: Double {
    get {
      if let v = UserDefaults.standard.object(forKey: tremorKey) as? Double { return v }
      if let n = UserDefaults.standard.object(forKey: tremorKey) as? NSNumber { return n.doubleValue }
      if let blob = UserDefaults.standard.dictionary(forKey: blobKey), let motion = blob["motion"] as? [String: Any], let v = motion["tremor"] as? Double { return v }
      return 1.1
    }
    set { UserDefaults.standard.set(max(0, min(4.0, newValue)), forKey: tremorKey) }
  }

  // MARK: - Custom image (absolute path, validated up to 1024px, 2MiB elsewhere)

  static var customImagePath: String? {
    get {
      if let v = UserDefaults.standard.string(forKey: customImageKey), !v.isEmpty { return v }
      return nil
    }
    set {
      if let v = newValue, !v.isEmpty {
        UserDefaults.standard.set(v, forKey: customImageKey)
      } else {
        UserDefaults.standard.removeObject(forKey: customImageKey)
      }
    }
  }

  static var hotspotX: Double {
    get { UserDefaults.standard.object(forKey: hotspotXKey) as? Double ?? 0 }
    set { UserDefaults.standard.set(max(0, min(512, newValue)), forKey: hotspotXKey) }
  }

  static var hotspotY: Double {
    get { UserDefaults.standard.object(forKey: hotspotYKey) as? Double ?? 0 }
    set { UserDefaults.standard.set(max(0, min(512, newValue)), forKey: hotspotYKey) }
  }

  // MARK: - Sync from host dict (atomic validated persistence)

  /// Apply dict from host/RPC – validates ranges, mirrors upstream limits.
  /// All fields are validated before mutating UserDefaults (no partial mutation on invalid input).
  /// Returns nil on success, error string on validation failure.
  static func apply(dict: [String: Any]) -> String? {
    // Allow either flat dict or nested {cursorOverlay: {...}} wrapper
    let src: [String: Any]
    if let inner = dict["cursorOverlay"] as? [String: Any] {
      src = inner
    } else {
      src = dict
    }

    var stagedMutations: [() -> Void] = []

    // preset
    if let raw = src["preset"] as? String {
      let p = Preset(fromAny: raw)
      stagedMutations.append {
        UserDefaults.standard.set(p.rawValue, forKey: presetKey)
        // preset side-effects: simple disables ripple/highlight per Rust host logic
        if p == .simple {
          UserDefaults.standard.set(false, forKey: rippleKey)
          UserDefaults.standard.set(false, forKey: highlightKey)
        } else if p == .ringOnly {
          UserDefaults.standard.set(true, forKey: rippleKey)
          UserDefaults.standard.set(true, forKey: highlightKey)
        }
      }
    }

    // size
    if let sz = src["size"] as? Double {
      guard (0.5...4.0).contains(sz) else { return "size must be 0.5...4.0" }
      stagedMutations.append { UserDefaults.standard.set(sz, forKey: sizeKey) }
    } else if let n = src["size"] as? NSNumber {
      let sz = n.doubleValue
      guard (0.5...4.0).contains(sz) else { return "size must be 0.5...4.0" }
      stagedMutations.append { UserDefaults.standard.set(sz, forKey: sizeKey) }
    }

    // colors
    if let fill = src["fill"] as? String {
      if fill.isEmpty || fill.lowercased() == "null" {
        stagedMutations.append { UserDefaults.standard.removeObject(forKey: fillKey) }
      } else {
        guard validateHex(fill) else { return "fill must be hex like #FFFFFF" }
        stagedMutations.append { UserDefaults.standard.set(fill, forKey: fillKey) }
      }
    } else if src["fill"] is NSNull {
      stagedMutations.append { UserDefaults.standard.removeObject(forKey: fillKey) }
    }

    if let rim = src["rim"] as? String {
      if rim.isEmpty || rim.lowercased() == "null" {
        stagedMutations.append { UserDefaults.standard.removeObject(forKey: rimKey) }
      } else {
        guard validateHex(rim) else { return "rim must be hex" }
        stagedMutations.append { UserDefaults.standard.set(rim, forKey: rimKey) }
      }
    } else if src["rim"] is NSNull {
      stagedMutations.append { UserDefaults.standard.removeObject(forKey: rimKey) }
    }

    if let accent = src["accent"] as? String {
      guard validateHex(accent) else { return "accent must be hex" }
      stagedMutations.append { UserDefaults.standard.set(accent, forKey: accentKey) }
    } else if src["accent"] is NSNull {
      stagedMutations.append { UserDefaults.standard.removeObject(forKey: accentKey) }
    }

    // ripple/highlight
    if let v = src["ripple"] as? Bool { stagedMutations.append { UserDefaults.standard.set(v, forKey: rippleKey) } }
    if let v = src["highlight"] as? Bool { stagedMutations.append { UserDefaults.standard.set(v, forKey: highlightKey) } }
    if let v = src["labelsEnabled"] as? Bool {
      stagedMutations.append { UserDefaults.standard.set(v, forKey: labelKey) }
    } else if let v = src["labels_enabled"] as? Bool {
      stagedMutations.append { UserDefaults.standard.set(v, forKey: labelKey) }
    }

    // motion
    var effTravelMin = travelMinMs
    var effTravelMax = travelMaxMs
    var effDwell = dwellMs

    if let motion = src["motion"] as? [String: Any] {
      if let v = motion["travelMinMs"] as? Int {
        guard (30...1000).contains(v) else { return "travelMin must be >=30" }
        effTravelMin = v
        stagedMutations.append { UserDefaults.standard.set(v, forKey: travelMinKey) }
      } else if let v = motion["travelMinMs"] as? NSNumber {
        guard (30...1000).contains(v.intValue) else { return "travelMin must be >=30" }
        effTravelMin = v.intValue
        stagedMutations.append { UserDefaults.standard.set(v.intValue, forKey: travelMinKey) }
      }

      if let v = motion["travelMaxMs"] as? Int {
        effTravelMax = v
        stagedMutations.append { UserDefaults.standard.set(v, forKey: travelMaxKey) }
      } else if let v = motion["travelMaxMs"] as? NSNumber {
        effTravelMax = v.intValue
        stagedMutations.append { UserDefaults.standard.set(v.intValue, forKey: travelMaxKey) }
      }

      if let v = motion["dwellMs"] as? Int {
        guard (0...300).contains(v) else { return "dwell must be 0...300" }
        effDwell = v
        stagedMutations.append { UserDefaults.standard.set(v, forKey: dwellKey) }
      } else if let v = motion["dwellMs"] as? NSNumber {
        guard (0...300).contains(v.intValue) else { return "dwell must be 0...300" }
        effDwell = v.intValue
        stagedMutations.append { UserDefaults.standard.set(v.intValue, forKey: dwellKey) }
      }

      if let v = motion["bow"] as? Double {
        guard (0...3.0).contains(v) else { return "bow must be 0...3" }
        stagedMutations.append { UserDefaults.standard.set(v, forKey: bowKey) }
      } else if let v = motion["bow"] as? NSNumber {
        guard (0...3.0).contains(v.doubleValue) else { return "bow must be 0...3" }
        stagedMutations.append { UserDefaults.standard.set(v.doubleValue, forKey: bowKey) }
      }

      if let v = motion["overshoot"] as? Double {
        guard (0...0.15).contains(v) else { return "overshoot must be 0...0.15" }
        stagedMutations.append { UserDefaults.standard.set(v, forKey: overshootKey) }
      } else if let v = motion["overshoot"] as? NSNumber {
        guard (0...0.15).contains(v.doubleValue) else { return "overshoot must be 0...0.15" }
        stagedMutations.append { UserDefaults.standard.set(v.doubleValue, forKey: overshootKey) }
      }

      if let v = motion["tremor"] as? Double {
        guard (0...4.0).contains(v) else { return "tremor must be 0...4" }
        stagedMutations.append { UserDefaults.standard.set(v, forKey: tremorKey) }
      } else if let v = motion["tremor"] as? NSNumber {
        guard (0...4.0).contains(v.doubleValue) else { return "tremor must be 0...4" }
        stagedMutations.append { UserDefaults.standard.set(v.doubleValue, forKey: tremorKey) }
      }
    }

    // budget check travelMax+dwell <=700 (upstream limit)
    guard effTravelMax + effDwell <= 700 else { return "travelMax + dwell must not exceed 700 ms" }
    guard effTravelMin <= effTravelMax else { return "travelMin must be <= travelMax" }

    // custom image
    if let ci = src["customImage"] as? [String: Any] {
      if let p = ci["path"] as? String, !p.isEmpty {
        guard p.hasPrefix("/") else { return "custom image path must be absolute" }
        if FileManager.default.fileExists(atPath: p) {
          if let err = validateImageFile(at: p) {
            return err
          }
        }
        stagedMutations.append { UserDefaults.standard.set(p, forKey: customImageKey) }
        if let hx = ci["hotspotX"] as? Double {
          guard (0...512).contains(hx) else { return "hotspotX must be 0...512" }
          stagedMutations.append { UserDefaults.standard.set(hx, forKey: hotspotXKey) }
        } else if let hx = ci["hotspotX"] as? NSNumber {
          guard (0...512).contains(hx.doubleValue) else { return "hotspotX must be 0...512" }
          stagedMutations.append { UserDefaults.standard.set(hx.doubleValue, forKey: hotspotXKey) }
        }
        if let hy = ci["hotspotY"] as? Double {
          guard (0...512).contains(hy) else { return "hotspotY must be 0...512" }
          stagedMutations.append { UserDefaults.standard.set(hy, forKey: hotspotYKey) }
        } else if let hy = ci["hotspotY"] as? NSNumber {
          guard (0...512).contains(hy.doubleValue) else { return "hotspotY must be 0...512" }
          stagedMutations.append { UserDefaults.standard.set(hy.doubleValue, forKey: hotspotYKey) }
        }
      } else if ci["path"] is NSNull || (ci["path"] as? String)?.isEmpty == true {
        stagedMutations.append {
          UserDefaults.standard.removeObject(forKey: customImageKey)
          UserDefaults.standard.removeObject(forKey: hotspotXKey)
          UserDefaults.standard.removeObject(forKey: hotspotYKey)
        }
      }
    } else if src["customImage"] is NSNull {
      stagedMutations.append {
        UserDefaults.standard.removeObject(forKey: customImageKey)
        UserDefaults.standard.removeObject(forKey: hotspotXKey)
        UserDefaults.standard.removeObject(forKey: hotspotYKey)
      }
    }

    // legacy direct image path
    if let p = src["customImagePath"] as? String {
      if p.isEmpty {
        stagedMutations.append { UserDefaults.standard.removeObject(forKey: customImageKey) }
      } else {
        guard p.hasPrefix("/") else { return "custom image path must be absolute" }
        stagedMutations.append { UserDefaults.standard.set(p, forKey: customImageKey) }
      }
    }

    // All checks passed: apply staged mutations atomically
    for mutate in stagedMutations {
      mutate()
    }

    // Clear stale blob before taking snapshot so getters do not fall back to old blob values
    UserDefaults.standard.removeObject(forKey: blobKey)

    // Also persist plist-compatible blob for status reporting convenience
    var plistDict = toDictionary()
    for (k, v) in plistDict {
      if v is NSNull { plistDict.removeValue(forKey: k) }
    }
    UserDefaults.standard.set(plistDict, forKey: blobKey)
    return nil
  }

  static func resetToDefaults() {
    for key in [presetKey, sizeKey, fillKey, rimKey, accentKey, rippleKey, highlightKey, travelMinKey, travelMaxKey, dwellKey, bowKey, overshootKey, tremorKey, customImageKey, hotspotXKey, hotspotYKey, blobKey] {
      UserDefaults.standard.removeObject(forKey: key)
    }
    // Keep isEnabled and label defaults untouched (reset only overlay prefs)
  }

  static func toDictionary() -> [String: Any] {
    var customImg: [String: Any]? = nil
    if let path = customImagePath {
      customImg = ["path": path, "hotspotX": hotspotX, "hotspotY": hotspotY]
    }
    let motion: [String: Any] = [
      "travelMinMs": travelMinMs,
      "travelMaxMs": travelMaxMs,
      "dwellMs": dwellMs,
      "bow": bow,
      "overshoot": overshoot,
      "tremor": tremor,
    ]
    var dict: [String: Any] = [
      "preset": preset.rawValue,
      "size": size,
      "ripple": ripple,
      "highlight": highlight,
      "labelsEnabled": showLabel,
      "motion": motion,
    ]
    if let fill = fillHex { dict["fill"] = fill } else { dict["fill"] = NSNull() }
    if let rim = rimHex { dict["rim"] = rim } else { dict["rim"] = NSNull() }
    dict["accent"] = accentHex
    if let ci = customImg { dict["customImage"] = ci } else { dict["customImage"] = NSNull() }
    dict["enabled"] = isEnabled
    return dict
  }

  /// Human readable validation for direct custom image file at path
  static func validateImageFile(at path: String) -> String? {
    guard path.hasPrefix("/") else { return "path must be absolute" }
    guard FileManager.default.fileExists(atPath: path) else { return "image file missing" }
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
          let size = attrs[.size] as? UInt64 else { return "cannot stat image" }
    if size > 2 * 1024 * 1024 { return "image must be ≤2MiB" }
    // PNG magic check
    guard let fh = FileHandle(forReadingAtPath: path) else { return "cannot read image" }
    defer { fh.closeFile() }
    let magic = fh.readData(ofLength: 8)
    guard magic.count == 8, magic.starts(with: Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) else { return "cursor images must be PNG" }
    // IHDR width/height
    fh.seek(toFileOffset: 16)
    let wh = fh.readData(ofLength: 8)
    guard wh.count == 8 else { return "bad PNG header" }
    let w = wh.subdata(in: 0..<4).withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }
    let h = wh.subdata(in: 4..<8).withUnsafeBytes { $0.load(as: UInt32.self).bigEndian }
    if w == 0 || h == 0 || w > 1024 || h > 1024 { return "PNG must be ≤1024 per side" }
    return nil
  }
}
