import { ownerRefusal, leaveRefusal } from '../../src/threadSendApi.ts';

// App's pop-out callback reserves ownership before the native window opens.
// Keep that state real in extracted-callback fixtures, including repeated calls.
export function popoutOwnership(ids = []) {
  const outside = { current: new Set(ids) };
  return {
    outside,
    moving: { current: new Set() },
    sendApis: new Map(),
    ownerRefusal,
    leaveRefusal,
    setOutside(id, value) {
      if (value) outside.current.add(id);
      else outside.current.delete(id);
    },
  };
}
