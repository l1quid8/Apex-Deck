// Shared by settings writers in this renderer; identities survive section remounts.
let sequence = 0;
export function nextSettingsSaveSequence(): number { return ++sequence; }
