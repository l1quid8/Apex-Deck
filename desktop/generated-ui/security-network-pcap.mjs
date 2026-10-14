import fs from 'node:fs';

// Decode only the IPv4 transport headers and synthetic STUN/TURN messages in
// the narrowly filtered capture. Preserve the original pcap as primary evidence.
export function decodeNetworkCapture(file, endpoint, client) {
  const data=fs.readFileSync(file), magic=data.subarray(0,4).toString('hex');
  const little=['d4c3b2a1','4d3cb2a1'].includes(magic), nano=['4d3cb2a1','a1b23c4d'].includes(magic);
  if(!['d4c3b2a1','a1b2c3d4','4d3cb2a1','a1b23c4d'].includes(magic))throw Error('Unsupported packet-capture header');
  const u32=offset=>little?data.readUInt32LE(offset):data.readUInt32BE(offset);
  const link=u32(20), linkOffset=link===276?20:link===113?16:link===1?14:null;
  if(linkOffset===null)throw Error('Unsupported packet-capture link type '+link);
  const rows=[];
  for(let offset=24;offset+16<=data.length;){
    const seconds=u32(offset), fraction=u32(offset+4),length=u32(offset+8);
    const bytes=data.subarray(offset+16,offset+16+length);offset+=16+length;
    if(bytes.length<linkOffset+20||bytes[linkOffset]>>4!==4)continue;
    const ip=linkOffset,ipLength=(bytes[ip]&15)*4, protocol=bytes[ip+9];
    if(![6,17].includes(protocol)||bytes.length<ip+ipLength+8)continue;
    const address=position=>[...bytes.subarray(position,position+4)].join('.');
    const source=address(ip+12),destination=address(ip+16);
    if(source!==client||destination!==endpoint.address)continue;
    const transport=ip+ipLength,sourcePort=bytes.readUInt16BE(transport),destPort=bytes.readUInt16BE(transport+2);
    const headerLength=protocol===17?8:(bytes[transport+12]>>4)*4;
    const payload=bytes.subarray(transport+headerLength);
    const row={at:seconds*1000+fraction/(nano?1e6:1e3),protocol:protocol===17?'udp':'tcp',sourcePort,destPort,bytes:payload.length};
    if(payload.length>=20&&payload.readUInt32BE(4)===0x2112a442){
      row.stunType=payload.readUInt16BE(0).toString(16).padStart(4,'0');
      row.stunTransaction=payload.subarray(8,20).toString('hex');
      row.stunLength=payload.readUInt16BE(2);
    }
    if(protocol===6)row.tcpFlags=bytes[transport+13];
    rows.push(row);
  }
  return rows;
}

export function dnsBootstrapConnections(file) {
  const log=JSON.parse(fs.readFileSync(file,'utf8'));
  const names=Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([name,value])=>[value,name]));
  const offset=Number(log.constants.timeTickOffset);
  const jobs=new Map();
  for(const event of log.events)if(names[event.type]==='SOCKET_POOL_CONNECT_JOB_CREATED'&&event.params?.group_id?.startsWith('dns_bootstrap/'))jobs.set(event.source.id,{job:event.source.id,group:event.params.group_id,start:offset+Number(event.time)});
  const sockets=new Map();
  for(const event of log.events)if(names[event.type]==='SOCKET_ALIVE'&&event.params?.source_dependency&&jobs.has(event.params.source_dependency.id))sockets.set(event.source.id,{...jobs.get(event.params.source_dependency.id),socket:event.source.id});
  for(const event of log.events){
    const socket=sockets.get(event.source.id);if(!socket)continue;
    if(names[event.type]==='TCP_CONNECT'&&event.params?.address_list)socket.remote=event.params.address_list[0];
    if(names[event.type]==='TCP_CONNECT'&&event.params?.local_address)socket.local=event.params.local_address;
    if(names[event.type]==='SOCKET_ALIVE'&&event.phase===2)socket.end=offset+Number(event.time);
  }
  return [...sockets.values()];
}
