/** Presentation only. Raw replies remain in the durable transcript/export. */
export function stripRunnerReport(text:string):string {
  let enclosing:{marker:string;length:number}|null=null;
  let start=-1;let end=-1;let body='';let offset=0;let collecting=false;
  for(const line of text.split('\n')){
    const match=/^(`{3,}|~{3,})(.*)$/.exec(line);
    if(match){
      const marker=match[1][0],length=match[1].length;
      if(enclosing){if(marker===enclosing.marker&&length>=enclosing.length&&!match[2].trim()){if(collecting)end=offset+line.length;enclosing=null;collecting=false;offset+=line.length+1;continue;}}
      else {enclosing={marker,length};collecting=marker==='`'&&length===3&&match[2].trim()==='apex-runner';start=collecting?offset:-1;end=-1;body='';offset+=line.length+1;continue;}
    }
    if(collecting)body+=line+'\n';else if(!enclosing&&line.trim()){start=-1;end=-1;}
    offset+=line.length+1;
  }
  if(enclosing||start<0||end<0||new TextEncoder().encode(body).length>16384)return text;
  try{
    const r=JSON.parse(body);
    if(r.version!==1||!['working','done','blocked'].includes(r.disposition)||typeof r.done!=='string'||typeof r.next!=='string'||!(r.blocker===null||typeof r.blocker==='string')||!Array.isArray(r.criteria)||r.criteria.length>50)return text;
    if([r.done,r.next,r.blocker??''].some(s=>s.length>2000))return text;
    const ids=new Set();for(const c of r.criteria){if(typeof c.id!=='string'||ids.has(c.id)||!['pending','done','failed'].includes(c.status)||!Array.isArray(c.evidence)||c.evidence.some((e:unknown)=>typeof e!=='string'||!e.trim()))return text;ids.add(c.id);}
    return text.slice(0,start).trimEnd();
  }catch{return text;}
}
