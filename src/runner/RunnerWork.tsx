import type {ReactNode} from 'react';
import type {RunnerSnapshot} from './types.ts';
/** A presentation group only; raw messages and tool records remain intact. */
export function RunnerWork({snapshot,count,children}:{snapshot:RunnerSnapshot;count:number;children:ReactNode}){
 return <details className="runner-work"><summary>{snapshot.kind==='goal'?'Goal work':'Loop runs'} · {count} {count===1?'reply':'replies'}</summary>{children}</details>;
}
