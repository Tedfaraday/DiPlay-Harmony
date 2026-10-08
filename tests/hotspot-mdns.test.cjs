const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
function load(name,deps={},ext='.ts',globals={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/../entry/src/main/ets/lab/'+name+ext,'utf8'),
{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,Uint8Array,DataView,require:id=>{if(id==='./DisplayProfile')return load('DisplayProfile');if(!(id in deps))throw Error('Missing '+id);return deps[id];},...globals});return exports;}
const dns=load('DnsCodec'),core=load('PairingCore'),plist=load('Bplist',{'./PairingCore':core}),receiver=load('ReceiverInfo',{'./Bplist':plist});
const encode=s=>new TextEncoder().encode(s),decode=b=>new TextDecoder().decode(b);
// Independent wire producer, including compressed names and a dot inside one instance label.
const short=n=>{const b=Buffer.alloc(2);b.writeUInt16BE(n);return b;},long=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const name=labels=>Buffer.concat([...labels.map(s=>{const b=Buffer.from(s);return Buffer.concat([Buffer.from([b.length]),b]);}),Buffer.from([0])]);
const pointer=n=>short(0xc000|n),rr=(owner,type,data,ttl=120,flush=true)=>Buffer.concat([owner,short(type),short(flush?0x8001:1),long(ttl),short(data.length),data]);
const browse=['_carplay-ctrl','_tcp','local'],instance=['CDX.iPhone',...browse],host=['iphone','local'];
function response(records){return Buffer.concat([short(0),short(0x8400),short(0),short(records.length),short(0),short(0),...records]);}
function compressed(){
 const base=name(browse),target=Buffer.concat([name(['CDX.iPhone']).subarray(0,-1),pointer(12)]),targetOffset=12+base.length+10;
 const ptr=rr(base,12,target,120,false),srvBody=Buffer.concat([short(0),short(0),short(12345),name(['iphone']).subarray(0,-1),pointer(12+name(browse.slice(0,2)).length-1)]);
 const hostOffset=12+ptr.length+2+10+6;
 const srv=rr(pointer(targetOffset),33,srvBody),address=rr(pointer(hostOffset),1,Buffer.from([192,168,43,2]));
 return response([ptr,srv,address]);
}
const ptr=(ttl=120)=>response([rr(name(browse),12,name(instance),ttl,false)]);
const srv=(port=12345,ttl=120)=>response([rr(name(instance),33,Buffer.concat([short(0),short(0),short(port),name(host)]),ttl)]);
const addr=(address=[192,168,43,2],ttl=120)=>response([rr(name(host),1,Buffer.from(address),ttl)]);
const identity={pairingId:'public-pairing-id',keys:{pubKey:{getEncoded:()=>({data:Uint8Array.from([...new Array(12).fill(0),...new Array(32).fill(7)])})}}};
function fixture(){let now=0;const sent=[],pending=[],stopped=[],reports=[],resolved=[],timers=[];
 const native={startDiscovery:address=>{assert.equal(address,'192.168.43.1');return 7;},sendDiscovery:(handle,data,address)=>{assert.equal(handle,7);sent.push({data:Buffer.from(data),address});return true;},
 readDiscovery:()=>pending.shift(),stopDiscovery:handle=>stopped.push(handle)};
 const {HotspotMdns}=load('HotspotMdns',{'libdiplayvideo.so':{default:native},'@kit.ArkTS':{util:{TextEncoder:class{encodeInto(s){return encode(s);}},TextDecoder:{create:()=>({decodeToString:decode})}}},
 './DnsCodec':dns,'./ReceiverInfo':receiver},'.ets',{Date:{now:()=>now},setInterval:fn=>{timers.push({fn,active:true});return timers.length-1;},clearInterval:i=>{timers[i].active=false;}});
 const service=new HotspotMdns('192.168.43.1','00:11:22:33:44:55',m=>reports.push(m),(address,port)=>resolved.push({address,port}));
 return{service,sent,pending,stopped,reports,resolved,native,timers,pump:t=>{now=t;timers.filter(t=>t.active).forEach(t=>t.fn());},
 emit:(data,address='192.168.43.2',unicast=false)=>pending.push({data:Uint8Array.from(data).buffer,address,unicast}),
 start:()=>{service.start(identity);},ready:()=>{service.start(identity);[250,500,750].forEach(t=>{now=t;timers.filter(t=>t.active).forEach(t=>t.fn());});}};
}
let count=0;function check(label,fn){fn();count++;console.log('PASS '+label);}
check('independent compressed PTR/SRV/A decodes; instance dot stays in a single label',()=>{
 const packet=dns.readDns(compressed(),decode);assert.equal(packet.records.length,3);assert.deepEqual(Array.from(packet.records[0].target.labels),instance);
 assert.equal(packet.records[1].port,12345);assert.deepEqual(Array.from(packet.records[1].target.labels),host);assert.equal(packet.records[2].address,'192.168.43.2');
});
check('DNS queries use QU flag and UTF8 labels; probe records belong in authority section',()=>{
 const packet=new dns.DnsPacket();packet.questions=[new dns.DnsQuestion(new dns.DnsName(['设备.甲',...browse]))];
 const wire=Buffer.from(dns.writeDns(packet,encode));assert.equal(wire.readUInt16BE(4),1);assert.equal(wire.readUInt16BE(wire.length-2),0x8001);
 const length=wire[12];assert.equal(wire.subarray(13,13+length).toString(),'设备.甲');
 const f=fixture();f.start();assert.equal(f.sent[0].data.readUInt16BE(6),0);assert.equal(f.sent[0].data.readUInt16BE(8),3);
 f.service.close();
});
check('malformed DNS pointers, record lengths, counts and oversized TXT reject',()=>{
 const bad=Buffer.from(compressed());bad[12]=0xc0;bad[13]=12;assert.throws(()=>dns.readDns(bad,decode));
 assert.throws(()=>dns.readDns(compressed().subarray(0,-1),decode));
 const counts=Buffer.alloc(12);counts.writeUInt16BE(65,6);assert.throws(()=>dns.readDns(counts,decode));
 assert.throws(()=>dns.readDns(response([rr(name(host),16,Buffer.from([5,1]))]),decode));
 const packet=new dns.DnsPacket(),record=new dns.DnsRecord(new dns.DnsName(host),16);record.values=['x'.repeat(256)];packet.records=[record];assert.throws(()=>dns.writeDns(packet,encode));
});
check('three name probes precede announcement; discovery TXT matches info, and stop sends goodbye',()=>{
 const f=fixture();f.ready();const announcements=f.sent.filter(s=>s.data.readUInt16BE(2)&0x8000);assert.equal(announcements.length,1);
 const packet=dns.readDns(announcements[0].data,decode),txt=packet.records.find(r=>r.type===16),attrs=Object.fromEntries(txt.values.map(s=>{const i=s.indexOf('=');return[s.slice(0,i),s.slice(i+1)];}));
 assert.equal(attrs.deviceid,receiver.receiverInfo('00:11:22:33:44:55').entries.get('deviceID').text);assert.equal(attrs.pk,'07'.repeat(32));assert.equal(attrs.pi,identity.pairingId);assert.equal(attrs.features,'0x5653aee2,0x61');
 assert.equal(packet.records.find(r=>r.type===1).address,'192.168.43.1');assert.equal(packet.records.find(r=>r.type===33).port,7000);
 assert.ok(f.reports.every(m=>!m.includes(attrs.pk)&&!m.includes(attrs.pi)));f.service.close();assert.deepEqual(f.stopped,[7]);
 assert.ok(dns.readDns(f.sent.at(-1).data,decode).records.every(r=>r.ttl===0));assert.ok(f.timers.every(t=>!t.active));
});
check('control resolution waits for authentication and verifies advertised address; packets from other phones cannot resolve',()=>{
 const f=fixture();f.ready();f.emit(compressed());f.emit(compressed(),'192.168.43.3');f.pump(800);assert.equal(f.resolved.length,0);
 f.service.approvePeer('192.168.43.2');assert.deepEqual(f.resolved,[{address:'192.168.43.2',port:12345}]);
 f.emit(compressed());f.pump(900);assert.equal(f.resolved.length,1);assert.ok(f.reports.every(m=>!m.includes('CDX')&&!m.includes('192.168')));f.service.close();
});
check('fragmented discovery records trigger SRV and A followups only to authenticated phone',()=>{
 const f=fixture();f.ready();f.service.approvePeer('192.168.43.2');f.emit(ptr());f.pump(800);
 assert.ok(f.sent.some(s=>s.address==='192.168.43.2'&&dns.readDns(s.data,decode).questions.some(q=>q.type===33)));
 f.emit(srv());f.pump(900);assert.ok(f.sent.some(s=>s.address==='192.168.43.2'&&dns.readDns(s.data,decode).questions.some(q=>q.type===1)));
 f.emit(addr([192,168,43,3]));f.pump(950);assert.equal(f.resolved.length,0);
 f.emit(addr());f.pump(1000);assert.equal(f.resolved.length,1);assert.ok(f.sent.every(s=>!s.address||s.address==='192.168.43.2'));f.service.close();
});
check('browse requests target CarPlay control service and ignore legacy service responses',()=>{
 const f=fixture();f.ready();f.service.approvePeer('192.168.43.2');
 assert.ok(f.sent.some(s=>dns.readDns(s.data,decode).questions.some(q=>q.type===12&&Array.from(q.name.labels).join('.')==='_carplay-ctrl._tcp.local')));
 const legacy=['_carplay','_tcp','local'],legacyInstance=['CDX.iPhone',...legacy];
 f.emit(response([rr(name(legacy),12,name(legacyInstance),120,false),rr(name(legacyInstance),33,Buffer.concat([short(0),short(0),short(12345),name(host)])),rr(name(host),1,Buffer.from([192,168,43,2]))]));
 f.pump(800);assert.equal(f.resolved.length,0);
 f.emit(compressed());f.pump(900);assert.equal(f.resolved.length,1);f.service.close();
});
check('stale records, unsolicited unicast responses, and malformed datagrams cannot create a control endpoint',()=>{
 const f=fixture();f.ready();f.emit(compressed());f.pump(800);f.pump(121000);f.service.approvePeer('192.168.43.2');assert.equal(f.resolved.length,0);
 f.emit(compressed(),'192.168.43.2',true);f.emit(Buffer.alloc(9001));f.pump(124001);assert.equal(f.resolved.length,0);
 f.emit(compressed());f.pump(124100);assert.equal(f.resolved.length,1);f.service.close();
});
check('conflicting host record and send failure close native socket and timer',()=>{
 const f=fixture();f.ready();const announcement=dns.readDns(f.sent.find(s=>s.data.readUInt16BE(2)&0x8000).data,decode);
 const ownHost=announcement.records.find(r=>r.type===1).name.labels;f.emit(response([rr(name(ownHost),1,Buffer.from([192,168,43,99]))]));f.pump(900);
 assert.deepEqual(f.stopped,[7]);assert.ok(f.timers.every(t=>!t.active));
 const g=fixture();g.native.sendDiscovery=()=>false;assert.throws(()=>g.start());assert.deepEqual(g.stopped,[7]);
});
check('unicast own-service queries get public response after delay; repeated queries are rate limited',()=>{
 const f=fixture();f.ready();const query=new dns.DnsPacket();query.questions=[new dns.DnsQuestion(new dns.DnsName(['_airplay','_tcp','local']))];
 f.emit(dns.writeDns(query,encode));f.pump(1800);const start=f.sent.length;f.pump(1950);
 assert.equal(f.sent.length,start+1);assert.equal(f.sent.at(-1).address,'192.168.43.2');
 f.emit(dns.writeDns(query,encode));f.pump(1975);f.pump(2100);assert.equal(f.sent.length,start+1);f.service.close();
});
console.log(count+' hotspot mDNS tests passed');
