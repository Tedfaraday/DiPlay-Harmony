const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
function load(name,deps={},ext='.ts'){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/../entry/src/main/ets/lab/'+name+ext,'utf8'),
{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,Uint8Array,DataView,setInterval,clearInterval,require:id=>deps[id]});return exports;}
const core=load('PairingCore'),probe=load('Iap2Probe'),link=load('Iap2Link',{'./Iap2Probe':probe}),iap=load('Iap2Control'),wireless=load('WirelessControl',{'./Iap2Control':iap}),packages=load('IapPackages',{'./PairingCore':core}),cipher=load('ControlCipher',{'./PairingCore':core});
const runtimeModule=load('TunnelControl',{'./Iap2Link':link,'./Iap2Control':iap,'./WirelessControl':wireless});
const tick=()=>new Promise(r=>setImmediate(r));function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};}
function packet(type,body){const h=Buffer.alloc(32);h.writeUInt32BE(32+body.length,0);h.write(type,16,4,'ascii');return Buffer.concat([h,body]);}
function frame(control,seq,ack,session=0,payload){const len=payload?payload.length+10:9,h=Buffer.from([255,90,len>>8,len&255,control,seq,ack,session,0]);h[8]=(-h.subarray(0,8).reduce((a,b)=>a+b,0))&255;return payload?Buffer.concat([h,Buffer.from(payload),Buffer.from([(-payload.reduce((a,b)=>a+b,0))&255])]):h;}
const sync=Buffer.from([1,4,255,255,0,0,0,0,0,0,10,0,2]);
function runtimeFixture(extra={}){const sent=[],reports=[];let ready=0,seq=99;
const auth={certificate:Uint8Array.of(3,4,5),sign:async()=>new Uint8Array(64),...extra};
const settings=new wireless.WirelessSettings('lab','do-not-log','192.168.43.1');
const runtime=new runtimeModule.TunnelControl(auth,settings,'AA:BB:CC:DD:EE:FF','ab'.repeat(32),'serial',()=>1000,t=>new TextEncoder().encode(t),async b=>sent.push(Buffer.from(b)),m=>reports.push(m),()=>ready++);
return{runtime,sent,reports,ready:()=>ready,message:async(id,fields=[])=>runtime.feed(frame(64,++seq,99,10,iap.controlMessage(id,fields)))};}
let count=0;async function check(n,f){await f();count++;console.log('PASS '+n);}
(async()=>{
await check('independent big-endian APTransportPackage fixture handles every split, coalescing and non-comm records',()=>{
const bytes=Buffer.concat([packet('noop',Buffer.from([9])),packet('comm',Buffer.from([1,2,3])),packet('comm',Buffer.from([4]))]);
for(let i=0;i<=bytes.length;i++){const p=new packages.IapPackages(),out=[...p.feed(bytes.subarray(0,i)),...p.feed(bytes.subarray(i))];assert.deepEqual(out.map(x=>[...x]),[[1,2,3],[4]]);}
});
await check('malformed package sizes and buffer floods reject instead of stalling or allocating unbounded memory',()=>{
for(const size of [0,31,1048577,0xffffffff]){const h=Buffer.alloc(32);h.writeUInt32BE(size);assert.throws(()=>new packages.IapPackages().feed(h),/size/);}
assert.throws(()=>new packages.IapPackages().feed(new Uint8Array(1048577)),/limit/);
});
await check('tunnel initiates marker/SYN with zero acknowledgement settings and authenticates before credentials or handoff',async()=>{
const f=runtimeFixture();await f.runtime.start();assert.deepEqual([...f.sent[0]],[255,85,2,0,238,16]);assert.equal(f.sent[1][4],128);assert.deepEqual([...f.sent[1].subarray(13,19)],[0,0,0,0,0,0]);
await f.runtime.feed(frame(192,99,99,0,sync));const before=f.sent.length;await f.message(0x5702);assert.equal(f.sent.length,before);assert.equal(f.ready(),0);
await f.message(0x1d00);assert.equal(f.sent.at(-1).readUInt16BE(13),0x1d01);await f.message(0x1d02);await f.message(0xaa00);
await f.message(0xaa02,[iap.parameter(0,new Uint8Array(32))]);await f.message(0xaa05);assert.equal(f.ready(),1);await f.message(0xaa05);assert.equal(f.ready(),1);
await f.message(0x5702);assert.equal(f.sent.at(-1).readUInt16BE(13),0x5703);assert.ok(f.reports.every(m=>!m.includes('do-not-log')&&!m.includes('AA:BB')));f.runtime.close();
});
await check('late authentication signature after cancellation never emits a response or handoff',async()=>{
const gate=deferred(),f=runtimeFixture({sign:async()=>gate.promise});await f.runtime.start();await f.runtime.feed(frame(192,99,99,0,sync));await f.message(0x1d00);await f.message(0x1d02);
const pending=f.message(0xaa02,[iap.parameter(0,new Uint8Array(32))]);await tick();const n=f.sent.length;f.runtime.close();const signature=new Uint8Array(64).fill(7);gate.resolve(signature);await pending;
assert.equal(f.sent.length,n);assert.equal(f.ready(),0);assert.ok(signature.every(x=>x===0));
});
await check('success notification without an identification and challenge exchange cannot authorize handoff',async()=>{
const f=runtimeFixture();await f.runtime.start();await f.runtime.feed(frame(192,99,99,0,sync));await assert.rejects(f.message(0xaa05),/challenge/);assert.equal(f.ready(),0);f.runtime.close();
});
function nativeFixture(){const endpoints=[],reports=[],received=[],sent=[];let ended=0,start=0;const key=crypto.randomBytes(32);
class Endpoint{handlers={};closed=false;on(n,h){this.handlers[n]=h;}emit(n,v){this.handlers[n]?.(v);}async close(){this.closed=true;this.emit('close');}async listen(){if(this.gate)await this.gate.promise;}async getLocalAddress(){return{port:32000};}async getRemoteAddress(){if(this.remoteGate)await this.remoteGate.promise;return{address:this.address||'192.168.43.2'};}}
let gate;const {NativeIapTunnel}=load('NativeIapTunnel',{'@kit.NetworkKit':{socket:{constructTCPSocketServerInstance:()=>{const e=new Endpoint();e.gate=gate;endpoints.push(e);return e;}}},
'@kit.BasicServicesKit':{systemDateTime:{TimeType:{STARTUP:0},getUptime:()=>0}},'@kit.ArkTS':{util:{TextEncoder:class{encodeInto(t){return new TextEncoder().encode(t);}}}},
'./ControlCipher':cipher,'./IapPackages':packages,'./TunnelControl':{TunnelControl:class{async start(){start++;}async feed(b){received.push([...b]);}async advance(){}close(){}}}},'.ets');
const native={open:async(k,n,d,aad)=>{const c=crypto.createDecipheriv('chacha20-poly1305',k,n,{authTagLength:16});c.setAAD(aad);c.setAuthTag(d.slice(-16));return Buffer.concat([c.update(d.slice(0,-16)),c.final()]);}};
const tunnel=new NativeIapTunnel(key,native,'192.168.43.2',{iap:async b=>sent.push(b)}, {},{},'','','',m=>reports.push(m),()=>{},()=>ended++);
function seal(body){const h=Buffer.alloc(2);h.writeUInt16LE(body.length);const c=crypto.createCipheriv('chacha20-poly1305',key,Buffer.alloc(12),{authTagLength:16});c.setAAD(h);return Buffer.concat([h,c.update(body),c.final(),c.getAuthTag()]);}
return{tunnel,endpoints,Endpoint,received,reports,seal,ended:()=>ended,start:()=>start,setGate:g=>gate=g};}
await check('native tunnel authenticates encrypted frames before emitting comm bytes and rejects tampering',async()=>{
const f=nativeFixture();await f.tunnel.start();const c=new f.Endpoint();f.endpoints[0].emit('connect',c);const wire=f.seal(packet('comm',Buffer.from([1,2,3])));
c.emit('message',{message:Uint8Array.from(wire.subarray(0,5)).buffer});c.emit('message',{message:Uint8Array.from(wire.subarray(5)).buffer});await tick();await tick();assert.deepEqual(f.received,[[1,2,3]]);
wire[wire.length-1]^=1;c.emit('message',{message:Uint8Array.from(wire).buffer});await tick();await tick();assert.equal(f.ended(),1);assert.deepEqual(f.received,[[1,2,3]]);assert.equal(c.closed,true);
});
await check('native tunnel rejects a different phone and cancellation prevents late listener/identity startup',async()=>{
const f=nativeFixture();await f.tunnel.start();const c=new f.Endpoint();c.address='192.168.43.3';f.endpoints[0].emit('connect',c);await tick();assert.equal(f.start(),0);assert.equal(f.ended(),1);
const g=nativeFixture(),gate=deferred();g.setGate(gate);const pending=g.tunnel.start();await tick();await g.tunnel.close();gate.resolve();await assert.rejects(pending,/关闭/);assert.equal(g.endpoints[0].closed,true);
const h=nativeFixture();await h.tunnel.start();const late=new h.Endpoint();late.remoteGate=deferred();h.endpoints[0].emit('connect',late);await h.tunnel.close();late.remoteGate.resolve();await tick();assert.equal(h.start(),0);
});
console.log(count+' iAP tunnel tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
