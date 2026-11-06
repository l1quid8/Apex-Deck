import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {transform}from'sucrase';
const source=fs.readFileSync(new URL('../src/AssistantTeamRow.tsx',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace(/^export /gm,'');
const code=transform(source,{transforms:['typescript','jsx'],jsxRuntime:'classic'}).code;
const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity).filter(x=>x!==null&&x!==false&&x!==undefined)})};
const render=new Function('React','useMemo','Avatar','assistantAppearance','createAssistantAvatarApi',code+';return AssistantTeamRow;')(React,fn=>fn(),()=>null,()=>({kind:'pixel',seed:'x',color:'#abc'}),()=>undefined);
const all=n=>typeof n==='object'&&n?[n,...n.children.flatMap(all)]:[];
const ref={hostId:'local',assistantId:'a'};
test('one full highlighted row has separate main-chat and hidden-float targets',()=>{const events=[];const tree=render({assistant:{name:'Alfred',ref},status:{state:'ready'},selected:true,floated:false,onOpen:r=>events.push(['main',r]),onPopOut:r=>events.push(['float',r])});const buttons=all(tree).filter(x=>x.type==='button');assert.equal(buttons.length,2);assert.equal(tree.type,'div');buttons[0].props.onClick();buttons[1].props.onClick();assert.deepEqual(events,[['main',ref],['float',ref]]);assert.ok(!all(buttons[0]).slice(1).some(x=>x.type==='button'));assert.match(tree.props.className,/selected/)});
test('visible normal or avatar-only float removes duplicate sidebar pop-out button',()=>{const tree=render({assistant:{name:'Alfred',ref},status:{state:'ready'},selected:false,floated:true,onOpen(){},onPopOut(){}});assert.equal(all(tree).filter(x=>x.type==='button').length,1)});
