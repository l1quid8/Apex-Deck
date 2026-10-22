import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { createServer } from "vite";
import { runElectronScenario } from "./helpers/electron-test.mjs";

test(
  "phone mic controls survive thread switches and never submit the composer",
  { timeout: 150000 },
  async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "phone-voice-ui-"));
    const html = `<html><body><div id="root"></div><script type="module">
 import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{VoiceCall,PhoneCallStrip}from'/src/phone/VoiceCall.tsx';
 let state={status:'off',voices:['am_michael','bf_emma'],muted:false};const listeners=new Set();const emit=()=>listeners.forEach(f=>f());const scope={hostId:'h',roomId:'r',participantId:'null'};let settings={silenceMs:700,look:'pill',preferences:{}};window.submits=0;window.starts=[];window.switched=[];window.saved=[];
 const voice={controller:{getState:()=>state,start:async s=>{window.starts.push(s);state={...state,status:'listening',scope:s,startedAt:Date.now()};emit();},switchAgent:async s=>{window.switched.push(s);state={...state,scope:s,status:"listening",candidates:undefined,threadQuery:undefined};emit();},mute:m=>{state={...state,muted:m};emit();},end:async()=>{state={...state,status:'off',scope:undefined};emit();},preview(){}},subscribe:f=>{listeners.add(f);return()=>listeners.delete(f);},view:()=>({weak:false,attention:false}),settings:()=>settings,settingsFor:()=>settings,look:()=>settings.look,save:(s,h)=>{window.saved.push(h);settings=s;emit();},candidates:(hostId,roomId)=>roomId==='r3'?[{hostId,roomId,participantId:'a',profileId:'a',name:'Ann',aliases:[]},{hostId,roomId,participantId:'b',profileId:'b',name:'Bo',aliases:[]}]:[{hostId,roomId,participantId:hostId==='h'?'null':'other',profileId:'null',name:hostId==='h'?'Null':'Other',aliases:[]}]};window.ambiguous=()=>{state={...state,status:'needs-attention',candidates:[{...scope,profileId:'null',name:'Null',roomTitle:'Current thread'}, {hostId:'h2',roomId:'r2',participantId:'other',profileId:'other',name:'Other',roomTitle:'Other thread'}]};emit();};window.uncertain=()=>{state={...state,status:'needs-attention',threadQuery:'voise calls',candidates:[{...scope,profileId:'null',name:'Null',aliases:[],roomTitle:'Voice calls'}]};emit();};const link={status:async()=>({installed:true,supported:true})};
 function Sheet(p){return React.createElement('section',{role:'dialog'},React.createElement('h2',null,p.title),React.createElement('button',{type:'button',onClick:p.onClose},'Close'),p.children);}
 function App(){const[room,setRoom]=useState('r');window.room=setRoom;const host=room==='r2'?'h2':'h';return React.createElement('div',{className:'ph-app'},React.createElement('form',{onSubmit:e=>{e.preventDefault();window.submits++;}},React.createElement(PhoneCallStrip,{voice,hostId:host,roomId:room}),React.createElement(VoiceCall,{voice,hostId:host,roomId:room,machine:'Server',link,canSetUp:true,disabled:false,Sheet}),React.createElement('button',{type:'submit'},'Send')));}
 createRoot(document.getElementById('root')).render(React.createElement(App));window.ready=true;
 </script></body></html>`;
    const server = await createServer({
      cacheDir: path.join(temp, "cache"),
      server: { port: 0 },
      logLevel: "error",
      plugins: [
        {
          name: "voice-ui",
          configureServer(s) {
            s.middlewares.use("/__voice_ui", async (_q, r) => {
              r.setHeader("Content-Type", "text/html");
              r.end(await s.transformIndexHtml("/__voice_ui", html));
            });
          },
        },
      ],
    });
    await server.listen();
    const url = `http://localhost:${server.httpServer.address().port}/__voice_ui`;
    const main = path.join(temp, "main.cjs");
    fs.writeFileSync(
      main,
      `
 const{app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:393,height:852});const run=s=>win.webContents.executeJavaScript(s);const wait=async s=>{for(let i=0;i<100;i++){if(await run(s))return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out '+s);};try{await win.loadURL(${JSON.stringify(url)});const q=s=>run('!!document.querySelector('+JSON.stringify(s)+')');const click=async t=>assert.equal(await run('(()=>{const b=[...document.querySelectorAll("button")].find(b=>b.textContent==='+JSON.stringify(t)+'||b.getAttribute("aria-label")==='+JSON.stringify(t)+');if(!b)return document.body.innerText;b.click();return "ok"})()'),'ok','button '+t);await wait('window.ready&&document.querySelector(".ph-call-mic")');await run('document.querySelector(".ph-call-mic").click()');await wait('!!document.querySelector(".ph-call-pill")');assert.equal(await run('window.starts.length'),1,'one bot starts straight away');assert.equal(await q('[role=dialog]'),false);await run('document.querySelector(".ph-call-pill-mid").click()');await wait('document.querySelector("[role=dialog]")?.textContent.includes("Call with Null")');assert.equal(await q('form [role=dialog]'),false,'the sheet sits outside the composer');await click('Close');await wait('!document.querySelector("[role=dialog]")');await run('document.querySelector(".ph-call-pill-mid").click()');await wait('!!document.querySelector("[role=dialog]")');await click('Bar');await wait('!!document.querySelector(".ph-call-strip")&&!document.querySelector(".ph-call-pill")');assert.equal(await run('window.saved[0]'),'h','looks save against the machine of the call');await click('Close');await run('document.querySelector(".ph-call-strip-tap").click()');await wait('!!document.querySelector("[role=dialog]")');await click('Mute');await wait('document.querySelector("[role=dialog]")?.textContent.includes("Unmute")');await run('window.ambiguous()');await wait('[...document.querySelectorAll(".ph-call-seg button")].some(b=>b.textContent==="Other · Other thread")');await click('Other · Other thread');await wait('window.switched.length===1');assert.equal(await run('window.switched[0].participantId'),'other');await wait('!document.querySelector("[role=dialog]")');await run('window.room("r3")');await wait('!document.querySelector(".ph-call-strip")');await run('document.querySelector(".ph-call-mic").click()');await wait('document.querySelector("[role=dialog]")?.textContent.includes("Call who?")');await click('Bo');await wait('window.starts.length===2');assert.equal(await run('window.switched.length'),1,'a call on another machine is replaced, not moved');await run('window.room("r")');await wait('!document.querySelector(".ph-call-strip")');await run('document.querySelector(".ph-call-mic").click()');await wait('window.switched.length===2');assert.equal(await run('window.starts.length'),2,'a call elsewhere on this machine moves here instead of starting again');assert.equal(await run('window.submits'),0);await run('window.uncertain()');await wait('document.querySelector(\"[role=dialog] h2\")?.textContent===\"Which thread?\"');assert.equal(await run('document.querySelector(\"[role=dialog]\").textContent.includes(\"voise calls\")'),true,'the heard thread is visible');await wait('[...document.querySelectorAll(\".ph-call-seg button\")].some(b=>b.textContent.includes(\"Voice calls\"))');assert.equal(await run('window.switched.length'),2,'an uncertain singleton waits for a choice');await run('[...document.querySelectorAll(\".ph-call-seg button\")].find(b=>b.textContent.includes(\"Voice calls\")).click()');await wait('window.switched.length===3');assert.equal(await run('window.switched[2].roomTitle'),'Voice calls');app.exit(0);}catch(e){console.error(e.stack);app.exit(1);}});
 `,
    );
    try {
      const result = await runElectronScenario(electron, main, temp);
      assert.equal(result.code, 0, result.output);
    } finally {
      await server.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  },
);
