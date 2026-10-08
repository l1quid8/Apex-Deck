import {routingRows,parseFeed,totals,sameTargets,pickName,roomFile,snippet,providerName} from './feed';
export function register(on: any, options: any) {
  let dir='',rows:any[]=[],enabled:boolean|null=null,provider='',size='',busy=false,started=false,lastState=-Infinity,issue='';
  let titles:Record<string,string>={};
  const snippets=new Map<string,{text:string|null;first:number;last:number}>();
  const path=(relative:string)=>dir+'/'+relative;
  async function run($:any,argv:string[]) {
    const r=await $.process.run(argv,{timeoutMs:5000});
    if(r.exitCode!==0) throw new Error('Could not read '+argv[argv.length-1].split('/').pop());
    if(r.isStdoutTruncated) throw new Error('Feed file exceeds Deck mod output limit');
    return r.stdout;
  }
  const cat=($:any,relative:string)=>run($,['/bin/cat',path(relative)]);
  async function poll($:any) {
    if(busy) return; busy=true;
    try {
      const now=await $.clock.now();
      if(now-lastState>=10000) {
        lastState=now;
        try {const s=JSON.parse(await cat($,'saved-chats-v1/settings.json'));enabled=s.decision?.enabled===true;provider=s.decision?.provider ?? '';}
        catch {enabled=null;}
        try {const s=JSON.parse(await cat($,'saved-chats-v1/session.json')); titles=Object.fromEntries((s.panes??[]).map((p:any)=>[p.id,p.title]));} catch {titles={};}
      }
      try {
        const next=(await run($,['/usr/bin/stat','-f','%z',path('decisions.jsonl')])).trim();
        if(next!==size) {rows=parseFeed(await cat($,'decisions.jsonl'));size=next;}
        issue='';
      } catch(e) {issue=String((e as Error).message); if(issue==='Could not read decisions.jsonl') {rows=[];size='';issue='No observations yet';}}
      for(const row of rows.slice(-50).reverse()) {
        if(typeof row.room!=='string'||!Number.isInteger(row.message_index)||row.message_index<0) continue;
        const key=row.room+':'+row.message_index+':'+row.at_ms, hit=snippets.get(key);
        if(hit?.text || (hit && (now-hit.first>=120000||now-hit.last<10000))) continue;
        let text=null;try{text=snippet(JSON.parse(await cat($,'saved-chats-v1/rooms/'+roomFile(row.room))),row);}catch{}
        snippets.set(key,{text,first:hit?.first??now,last:now});
      }
      const t=totals(rows); $.ui.status(enabled===true?'Clef ✓ '+t.agree+'/'+t.usable:enabled===false?'Clef: observer off':'Clef: observer state unavailable');
      $.ui.invalidate();
    } finally {busy=false;}
  }
  on('session.start',async($:any,e:any,next:any)=>{
    if(!started) {
      dir=String(options.dataDir||'~/Library/Application Support/dev.apexdeck.app');
      if(dir.startsWith('~/')) {const home=await $.env.get('HOME');if(!home)throw new Error('HOME unavailable');dir=home+dir.slice(1);}
      dir=dir.replace(/\/+$/,'');
      if(!dir.startsWith('/')||dir.split('/').some((s:string)=>s==='..'||s==='.'))throw new Error('Use an absolute data folder without dot segments');
      started=true;await $.command.register({name:'clef',description:'Live decision observations'});await poll($);$.clock.every(2000,()=>poll($));
    }
    return next(e);
  });
  on('command.run',{command:'clef'},async($:any)=>{await $.ui.open({id:'feed',title:'Clef observer',focus:false});return {};});
  on('ui.render',{component:'Pane',requestId:'feed'},async($:any,e:any)=>{
    const {Box,Text}=$.ui.resolve(e),t=totals(rows),routing=routingRows(rows),thinking=rows.filter(r=>r.kind==='thinking');
    return <Box flexDirection="column" gap={2}>
      <Text color={enabled===true?'var(--brand-mint)':'var(--danger)'} bold>{enabled===true?'Observer on · '+providerName(provider):enabled===false?'Observer is off: Settings → Providers → Decision observer':'Observer state unavailable'}</Text>
      <Text bold>Thinking recommendations</Text>
      <Text dimColor>{thinking.length+' checks · '+thinking.filter(r=>!r.stale && r.thinking && !('error' in r)).length+' recommendations · '+thinking.filter(r=>'error' in r).length+' errors · '+thinking.filter(r=>r.stale).length+' stale'}</Text>
      {!thinking.length && <Text dimColor>No thinking recommendations yet</Text>}
      {thinking.slice(-50).reverse().map((r:any,i:number)=>{
        const stale=Boolean(r.stale),error='error' in r,choice=r.thinking?.choice,p=r.thinking?.probabilities?.[choice];
        const text=snippets.get(r.room+':'+r.message_index+':'+r.at_ms)?.text ?? 'message #'+r.message_index;
        const time=Number.isFinite(r.at_ms)?new Date(r.at_ms).toLocaleString(undefined,{weekday:'short',hour:'2-digit',minute:'2-digit'}):'Unknown time';
        const recommendation=error?String(r.error).slice(0,300):'Clef: '+(choice??'unavailable')+' '+(Number.isFinite(p)?Math.round(p*100)+'%':'—');
        const detail=recommendation+' · Backup: '+(r.backup??'unavailable')+' · '+(r.auto===true?'Auto':'Fixed level')+(r.observe_only===true?' · log only':'')+(stale?' · stale: you moved on before it answered':'');
        return <Box key={'thinking-'+i} flexDirection="column"><Text dimColor={stale} color={error?'var(--danger)':undefined}>{time+' · '+(titles[r.room]??r.room??'Unknown thread')+' · '+(typeof r.agent==='string'?pickName([r.agent]):'Unknown agent')+' · “'+text+'”'}</Text><Text dimColor={stale}>{detail}</Text></Box>;
      })}
      <Text bold>Routing</Text>
      <Text>{t.checked+' checked · agrees '+t.agree+'/'+t.usable+' · '+t.errors+' errors · '+t.stale+' stale · avg '+(t.latency/1000).toFixed(1)+'s · $'+t.cost.toFixed(4)}</Text>
      <Text dimColor>Agreeing with Deck isn't the same as being right; read the ✗ rows.</Text>
      {issue && <Text color="var(--warn)">{issue}</Text>}
      {!routing.length && !issue && <Text dimColor>No observations yet</Text>}
      {routing.slice(-50).reverse().map((r:any,i:number)=>{
        const stale=Boolean(r.stale),error='error' in r,agree=sameTargets(r.suggested_targets??[],r.deck_targets??[]);
        const mark=stale?'–':error?'⚠':agree?'✓':'✗';
        const text=snippets.get(r.room+':'+r.message_index+':'+r.at_ms)?.text ?? 'message #'+r.message_index;
        const time=Number.isFinite(r.at_ms)?new Date(r.at_ms).toLocaleString(undefined,{weekday:'short',hour:'2-digit',minute:'2-digit'}):'Unknown time';
        const choice=r.result?.choice,p=r.result?.probabilities?.[choice];
        const detail=stale?'you moved on before it answered':error?String(r.error).slice(0,300):'Clef: '+pickName(r.choices?.[choice]??[])+' '+(Number.isFinite(p)?Math.round(p*100)+'%':'—')+' · Deck: '+pickName(r.deck_targets??[])+' · '+((r.result?.latency_ms??0)/1000).toFixed(1)+'s · '+(Number.isFinite(r.result?.usage?.cost)?'$'+r.result.usage.cost.toFixed(4):'cost unavailable');
        return <Box key={i} flexDirection="column"><Text dimColor={stale} color={stale?undefined:error?'var(--danger)':agree?'var(--brand-mint)':'var(--warn)'}>{mark+' '+time+' · '+(titles[r.room]??r.room??'Unknown thread')+' · “'+text+'”'}</Text><Text dimColor={stale}>{detail}</Text></Box>;
      })}
    </Box>;
  });
}
