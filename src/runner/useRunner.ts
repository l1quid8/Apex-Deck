import { useEffect, useState } from 'react';
import type { Backend } from '../backend.ts';
import type { RunnerSnapshot } from './types.ts';
export function useRunner(backend: Backend | null | undefined, room: string | null) {
  const [hostOffset,setHostOffset]=useState(0);
  const [snapshot,setSnapshot]=useState<RunnerSnapshot|null>(null);
  useEffect(()=>{
    let live=true;let reading=false;let stop:(()=>void)|undefined;
    setSnapshot(null);
    const refresh=async()=>{if(!live||reading||!room||!backend?.roomRunnerState||backend.supports?.('room_runner_v1')===false)return;reading=true;try{const s=await backend.roomRunnerState(room);if(live){if(s?.hostNow)setHostOffset(s.hostNow-Date.now());setSnapshot(current=>current&&s&&current.id===s.id&&current.revision>s.revision?current:s);}}catch{/* Old or disconnected hosts retain reconnect state. */}finally{reading=false;}};
    void refresh();
    backend?.onRoomRunnerChanged?.((id,s)=>{if(live&&id===room)setSnapshot(s);}).then(off=>{if(live)stop=off;else off();});
    const tick=setInterval(refresh,2000);window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
    return()=>{live=false;stop?.();clearInterval(tick);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
  },[backend,room]);
  return [snapshot,setSnapshot,hostOffset] as const;
}
