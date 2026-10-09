export const APEX_AGENT_DOCK_DEFAULT = 480;
export const APEX_AGENT_DOCK_FOCUSED = 700;
export const APEX_AGENT_DOCK_MIN = 320;
export const APEX_AGENT_DOCK_MAX = 820;
export const APEX_AGENT_DOCK_NARROW_BREAKPOINT = 720;
export const APEX_AGENT_DOCK_STORAGE_KEY = 'apex-agent-dock-width-v1';

/** Collapse the shared app chrome only while an open dock cannot fit beside it. */
export function shouldUseCompactApexAgentShell(open: boolean, bodyWidth: number): boolean {
  return open && Number.isFinite(bodyWidth) && bodyWidth > 0 && bodyWidth <= APEX_AGENT_DOCK_NARROW_BREAKPOINT;
}

/** Keep enough room for the chat when possible, while letting the dock fill a narrow window. */
export function clampApexAgentDockWidth(width: number, availableWidth: number, focused = false): number {
  const available = Math.max(0, Number.isFinite(availableWidth) ? availableWidth : 0);
  const maximum = Math.min(APEX_AGENT_DOCK_MAX, available, focused ? available : Math.max(APEX_AGENT_DOCK_MIN, available - 300));
  const minimum = Math.min(APEX_AGENT_DOCK_MIN, maximum);
  return Math.round(Math.max(minimum, Math.min(Number.isFinite(width) ? width : APEX_AGENT_DOCK_DEFAULT, maximum)));
}

export function storedApexAgentDockWidth(storage?: Pick<Storage, 'getItem'>): number {
  try {
    const raw = storage?.getItem(APEX_AGENT_DOCK_STORAGE_KEY);
    const value = raw === null || raw === undefined ? APEX_AGENT_DOCK_DEFAULT : Number(raw);
    return Number.isFinite(value) ? Math.round(Math.max(APEX_AGENT_DOCK_MIN, Math.min(APEX_AGENT_DOCK_MAX, value))) : APEX_AGENT_DOCK_DEFAULT;
  } catch {
    return APEX_AGENT_DOCK_DEFAULT;
  }
}
