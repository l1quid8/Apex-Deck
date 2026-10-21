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
 import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{VoiceCall}from'/src/phone/VoiceCall.tsx';
 let state={status:'off',voices:['am_michael'],muted:false};const listeners=new Set();const emit=()=>listeners.forEach(f=>f());const scope={hostId:'h',roomId:'r',participantId:'null'};let settings={silenceMs:700,preferences:{}};window.submits=0;window.starts=[];window.switched=[];
 const voice={controller:{getState:()=>state,start:async s=>{window.starts.push(s);state={...state,status:'listening',scope:s};emit();},switchAgent:async s=>{window.switched.push(s);state={...state,scope:s,status:"listening",candidates:undefined};emit();},mute:m=>{state={...state,muted:m};emit();},end:async()=>{state={...state,status:'off',scope:undefined};emit();},preview(){}},subscribe:f=>{listeners.add(f);return()=>listeners.delete(f);},view:()=>({weak:false,attention:false}),settings:()=>settings,save:s=>{settings=s;emit();},candidates:(hostId,roomId)=>[{hostId,roomId,participantId:hostId==='h'?'null':'other',profileId:'null',name:hostId==='h'?'Null':'Other',aliases:[]}]};window.ambiguous=()=>{state={...state,status:'needs-attention',candidates:[{...scope,profileId:'null',name:'Null'}, {hostId:'h2',roomId:'r2',participantId:'other',profileId:'other',name:'Other'}]};emit();};const link={status:async()=>({installed:true,supported:true})};
 function Sheet(p){return React.createElement('section',{role:'dialog'},React.createElement('h2',null,p.title),p.children);}
 function App(){const[other,setOther]=useState(false);window.switchRoom=()=>setOther(true);return React.createElement('div',{className:'ph-app'},React.createElement('form',{onSubmit:e=>{e.preventDefault();window.submits++;}},React.createElement(VoiceCall,{voice,hostId:other?'h2':'h',roomId:other?'r2':'r',machine:'Server',link,canSetUp:true,disabled:false,Sheet}),React.createElement('button',{type:'submit'},'Send')));}
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
 const{app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:393,height:852});const run=s=>win.webContents.executeJavaScript(s);const wait=async s=>{for(let i=0;i<100;i++){if(await run(s))return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out '+s);};try{await win.loadURL(${JSON.stringify(url)});await wait('window.ready&&document.querySelector(".ph-call-mic")');await run('document.querySelector(".ph-call-mic").click()');await wait('document.querySelector("[role=dialog]")?.textContent.includes("Listening")');assert.equal(await run('window.starts.length'),1);assert.equal(await run('!!document.querySelector("form [role=dialog]")'),false);await run('[...document.querySelectorAll("button")].find(b=>b.textContent==="Hide").click()');await wait('!document.querySelector("[role=dialog]")');await run('document.querySelector(".ph-call-mic").click()');await wait('!!document.querySelector("[role=dialog]")');await run('document.querySelector(".ph-call-mic").click()');await wait('!document.querySelector("[role=dialog]")');await run('window.switchRoom()');await new Promise(r=>setTimeout(r,50));await run('document.querySelector(".ph-call-mic").click()');await wait('document.querySelector("[role=dialog]")?.textContent.includes("Voice for Null")');assert.equal(await run('window.starts.length'),1,'changing threads does not start a replacement call');await run('[...document.querySelectorAll("button")].find(b=>b.textContent==="Mute").click()');await wait('document.querySelector("[role=dialog]")?.textContent.includes("Unmute")');await run('window.ambiguous()');await wait('[...document.querySelectorAll(".ph-voice-row")].some(b=>b.textContent==="Other")');await run('[...document.querySelectorAll("button")].find(b=>b.textContent==="Other").click()');await wait('window.switched.length===1');assert.equal(await run('window.switched[0].participantId'),'other');assert.equal(await run('window.submits'),0);app.exit(0);}catch(e){console.error(e.stack);app.exit(1);}});
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
