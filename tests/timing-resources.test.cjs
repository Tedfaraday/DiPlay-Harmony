const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
function load(name,deps={},ext='.ts'){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/../entry/src/main/ets/lab/'+name+ext,'utf8'),
{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,Uint8Array,DataView,Date,setInterval,clearInterval,require:id=>id==='./DisplayProfile'?load('DisplayProfile'):deps[id]});return exports;}
const core=load('PairingCore'),timing=load('TimingClock'),plist=load('Bplist',{'./PairingCore':core}),cipher=load('ControlCipher',{'./PairingCore':core}),rtsp=load('RtspProbe');
const receiver=load('ReceiverInfo',{'./Bplist':plist}),hid=load('HidTouch',{'./Bplist':plist,'./ReceiverInfo':receiver});
function seal(k,n,d,aad){const c=crypto.createCipheriv('chacha20-poly1305',k,n,{authTagLength:16});c.setAAD(aad);return Buffer.concat([c.update(d),c.final(),c.getAuthTag()]);}
function open(k,n,d,aad){const c=crypto.createDecipheriv('chacha20-poly1305',k,n,{authTagLength:16});c.setAAD(aad);c.setAuthTag(d.slice(-16));return Buffer.concat([c.update(d.slice(0,-16)),c.final()]);}
const tick=()=>new Promise(r=>setImmediate(r));function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};}
function fixture(){const endpoints=[],messages=[];let port=29000;
class Endpoint{handlers={};closed=false;sent=[];port=port++;on(n,h){this.handlers[n]=h;}emit(n,v){this.handlers[n]?.(v);}async bind(){if(this.bindGate)await this.bindGate.promise;}async listen(){}async close(){this.closed=true;}async getLocalAddress(){return{address:'0.0.0.0',port:this.port,family:1};}async send(o){this.sent.push(o);}}
let bindGate;const socket={constructUDPSocketInstance:()=>{const e=new Endpoint();e.bindGate=bindGate;endpoints.push(e);return e;},constructTCPSocketServerInstance:()=>{const e=new Endpoint();endpoints.push(e);return e;}};
const {SessionResources}=load('SessionResources',{'./TimingClock':timing,'./Bplist':plist,'./ControlCipher':cipher,'./PairingCore':core,'./RtspProbe':rtsp,'./HidTouch':hid,
'@kit.NetworkKit':{socket},'@kit.BasicServicesKit':{systemDateTime:{TimeType:{STARTUP:0},getUptime:()=>1000}},'@kit.ArkTS':{util:{TextEncoder:class{encodeInto(t){return new TextEncoder().encode(t);}}}}},'.ets');
const native={hkdf:async(k,s,i)=>Buffer.from(crypto.hkdfSync('sha512',k,s,i,32)),seal:async(...a)=>seal(...a),open:async(...a)=>open(...a)};
return{resources:new SessionResources(m=>messages.push(m)),endpoints,messages,native,Endpoint,setBindGate:g=>{bindGate=g;}};}
let count=0;async function check(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
await check('clock requires matching origin timestamps and converges on phone domain',()=>{
let ms=0;const c=new timing.TimingClock(()=>ms,0);const wrong=new Uint8Array(32);wrong[0]=128;wrong[1]=211;wrong[3]=7;c.request();c.handle(wrong);assert.equal(c.synced,false);
for(let i=0;i<2;i++){const request=c.request(),t1=timing.ntpRead(request,24),response=new Uint8Array(32);response[0]=128;response[1]=211;response[3]=7;
timing.ntpWrite(response,8,t1);timing.ntpWrite(response,16,t1+BigInt(Math.round(.2*4294967296)));timing.ntpWrite(response,24,t1+BigInt(Math.round(.2*4294967296)));ms+=20;c.handle(response);}
assert.equal(c.synced,true);const epoch=2208988800n<<32n;assert.ok(Math.abs(Number(c.ntp()-epoch)/4294967296-.23)<.001);
const request=c.request(),reply=c.handle(request);assert.equal(reply[1],211);assert.equal(timing.ntpRead(reply,8),timing.ntpRead(request,24));
});
await check('native session binds real timing/event/keepalive ports and closes all resources',async()=>{
const f=fixture();const r=await f.resources.start({address:'192.168.43.2',port:7000,family:1},6000,true,crypto.randomBytes(32),f.native);
assert.equal(r.entries.get('timingPort').number(),29000);assert.equal(r.entries.get('eventPort').number(),29001);assert.equal(r.entries.get('keepAlivePort').number(),29002);
// The initial SETUP reply must negotiate session features: viewAreas always, iAPChannel only on the
// CarPlay Wi-Fi path, exactly as the reference receiver builds it.
assert.deepEqual([...r.entries.keys()],['timingPort','eventPort','enabledFeatures','keepAlivePort']);
assert.equal(f.endpoints[0].sent.length,1);assert.equal(f.endpoints[0].sent[0].address.port,6000);await f.resources.close();assert.ok(f.endpoints.every(e=>e.closed));
});
await check('initial SETUP negotiates iAPChannel only when the iAP session is active',async()=>{
 const withIap=fixture();const a=await withIap.resources.start({address:'192.168.43.2',port:7000,family:1},0,false,crypto.randomBytes(32),withIap.native,true);
 assert.deepEqual([...a.entries.keys()],['timingPort','eventPort','enabledFeatures']);
 assert.deepEqual([...a.entries.get('enabledFeatures').items].map(x=>x.text),['iAPChannel','viewAreas']);
 await withIap.resources.close();
 const without=fixture();const b=await without.resources.start({address:'192.168.43.2',port:7000,family:1},0,false,crypto.randomBytes(32),without.native,false);
 assert.deepEqual([...b.entries.get('enabledFeatures').items].map(x=>x.text),['viewAreas']);
 assert.equal(b.entries.has('keepAlivePort'),false);
 await without.resources.close();
});
await check('stop during UDP bind cannot leave a late socket or create event server',async()=>{
const f=fixture(),gate=deferred();f.setBindGate(gate);const pending=f.resources.start({address:'192.168.43.2',port:7000,family:1},6000,false,crypto.randomBytes(32),f.native);
await tick();await f.resources.close();gate.resolve();await assert.rejects(pending,/关闭/);assert.equal(f.endpoints.length,1);assert.equal(f.endpoints[0].closed,true);
});
await check('event channel serializes HID and iAP commands with distinct directional keys; response acknowledgements are ignored',async()=>{
const f=fixture(),shared=crypto.randomBytes(32);const setup=await f.resources.start({address:'192.168.43.2',port:7000,family:1},0,false,shared,f.native,true);
assert.deepEqual([...setup.entries.get('enabledFeatures').items].map(x=>x.text),['iAPChannel','viewAreas']);
const client=new f.Endpoint();f.endpoints[1].emit('connect',client);const read=Buffer.from(crypto.hkdfSync('sha512',shared,Buffer.from('Events-Salt'),Buffer.from('Events-Read-Encryption-Key'),32));
const write=Buffer.from(crypto.hkdfSync('sha512',shared,Buffer.from('Events-Salt'),Buffer.from('Events-Write-Encryption-Key'),32));
const req=Buffer.from('POST /event RTSP/1.0\r\nCSeq: 42\r\nContent-Length: 0\r\n\r\n'),head=Buffer.alloc(2);head.writeUInt16LE(req.length);const record=Buffer.concat([head,seal(read,Buffer.alloc(12),req,head)]);
client.emit('message',{message:Uint8Array.from(record.subarray(0,5)).buffer});client.emit('message',{message:Uint8Array.from(record.subarray(5)).buffer});await tick();await tick();
const response=Buffer.from(client.sent[0].data);assert.match(open(write,Buffer.alloc(12),response.subarray(2),response.subarray(0,2)).toString(),/CSeq: 42/);
const ack=Buffer.from('RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n'),a=Buffer.alloc(2),n=Buffer.alloc(12);a.writeUInt16LE(ack.length);n.writeBigUInt64LE(1n,4);
client.emit('message',{message:Uint8Array.from(Buffer.concat([a,seal(read,n,ack,a)])).buffer});await tick();assert.equal(client.sent.length,1);
await Promise.all([f.resources.touch(.25,.5,true),f.resources.touch(.25,.5,false)]);assert.equal(client.sent.length,3);
for(let i=1;i<=2;i++){const record=Buffer.from(client.sent[i].data),nonce=Buffer.alloc(12);nonce.writeBigUInt64LE(BigInt(i),4);const plain=open(write,nonce,record.subarray(2),record.subarray(0,2));
const split=plain.indexOf('\r\n\r\n'),body=plist.decodePlist(plain.subarray(split+4)),report=Buffer.from(body.entries.get('hidReport').data);
assert.match(plain.subarray(0,split).toString(),/POST \/command/);assert.equal(body.entries.get('uuid').text,'2a2a2a2a');assert.equal(report[1],i===1?1:0);assert.equal(report.readUInt16LE(2),320);assert.equal(report.readUInt16LE(4),360);}
await f.resources.iap(Uint8Array.of(255,85,2,0,238,16));const ir=Buffer.from(client.sent[3].data),nonce=Buffer.alloc(12);nonce.writeBigUInt64LE(3n,4);
const ip=open(write,nonce,ir.subarray(2),ir.subarray(0,2)),ib=plist.decodePlist(ip.subarray(ip.indexOf('\r\n\r\n')+4));
assert.equal(ib.entries.get('type').text,'iAPSendMessage');assert.deepEqual([...ib.entries.get('params').entries.get('data').data],[255,85,2,0,238,16]);
await f.resources.close();assert.equal(client.closed,true);
});
await check('HID touch clips coordinates and always encodes release with no active contacts',()=>{
const down=hid.touchCommand(2,-1,true),bytes=Buffer.from(down.entries.get('hidReport').data);assert.equal(bytes.length,12);assert.equal(bytes.readUInt16LE(2),1280);assert.equal(bytes.readUInt16LE(4),0);assert.equal(bytes[6],1);assert.equal(bytes[7],0);
const up=hid.touchCommand(.5,.5,false);assert.equal(up.entries.get('hidReport').data[1],0);assert.throws(()=>hid.touchCommand(NaN,0,true));
});
console.log(count+' timing/resources tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
