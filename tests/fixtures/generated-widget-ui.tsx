import React from 'react';
import {createRoot} from 'react-dom/client';
import {GeneratedAnswerCard} from '../../src/interactiveAnswers/GeneratedAnswerCard';
const card={schemaVersion:1 as const,kind:'generated' as const,cardId:'widget-ui',title:'Saved flow',summary:'Fixture summary must stay hidden',fallback:'Fixture fallback must stay hidden',html:'<button id="next">Next stage</button><output id="step"></output>',css:'body{font:16px system-ui}button{margin:20px}output{display:block;padding:20px}',js:'const saved=generatedUI.widgetState;let step=Number.isInteger(saved?.step)?saved.step:0;const draw=()=>document.querySelector("#step").textContent="Stage "+step;document.querySelector("#next").onclick=()=>{step++;generatedUI.setWidgetState({step});draw()};draw();'};
const root=createRoot(document.getElementById('root')!);
// Observe from before the card mounts, including reload and fresh app launch.
const continuity={fallbackFrames:0,snapshotFrames:0};
Object.assign(window,{__widgetContinuity:continuity});
function sampleContinuity(){
 if([...document.querySelectorAll('.generated-fallback')].some(node=>node.getBoundingClientRect().height>0))continuity.fallbackFrames++;
 if(document.querySelector('.generated-snapshot'))continuity.snapshotFrames++;
 requestAnimationFrame(sampleContinuity);
}
requestAnimationFrame(sampleContinuity);
root.render(<div id="chat" style={{height:650,overflow:'auto',padding:30}}><p>Chat reply with persistent generated interface</p><GeneratedAnswerCard card={card} source={JSON.stringify(card)} version={1} author="Fixture" identity={{hostId:'local',threadId:'persistence',seq:1,cardId:card.cardId}} historical={false} readOnly={false}/><div style={{height:900}}/></div>);
