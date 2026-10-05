const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
function load(name,deps={},ext='.ts',globals={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/../entry/src/main/ets/lab/'+name+ext,'utf8'),
{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,Uint8Array,DataView,setInterval,clearInterval,require:id=>id==='./DisplayProfile'?load('DisplayProfile'):deps[id],...globals});return exports;}
const core=load('PairingCore'),screen=load('ScreenCodec',{'./PairingCore':core});
const avc=Buffer.from([1,100,0,31,255,225,0,4,0x67,100,0,31,1,0,2,0x68,1]);
function packet(op,body){const h=Buffer.alloc(128);h.writeUInt32LE(body.length);h[4]=op;return Buffer.concat([h,body]);}
let count=0;async function check(name,fn){await fn();count++;console.log('PASS '+name);}
const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
await check('screen header/body fragments and multiple packets remain distinct and bounded',()=>{
const bytes=Buffer.concat([packet(1,avc),packet(0,Buffer.alloc(32))]);for(let i=0;i<bytes.length;i++){const parser=new screen.ScreenParser(),parts=[...parser.feed(bytes.subarray(0,i)),...parser.feed(bytes.subarray(i))];assert.equal(parts.length,2);assert.equal(parts[0].header[4],1);assert.deepEqual(Buffer.from(parts[0].body),avc);}
const bad=Buffer.alloc(128);bad.writeUInt32LE(8*1024*1024+1);assert.throws(()=>new screen.ScreenParser().feed(bad),/limit/);
});
await check('avcC parameter sets and validated NAL lengths convert to Annex B',()=>{
assert.deepEqual(Array.from(screen.h264Configuration(avc)),[0,0,0,1,0x67,100,0,31,0,0,0,1,0x68,1]);
const box=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('avcC'),avc]);assert.deepEqual(Buffer.from(screen.h264Configuration(box)),Buffer.from(screen.h264Configuration(avc)));
assert.deepEqual(Array.from(screen.annexB(Buffer.from([0,0,0,2,0x65,1,0,0,0,1,0x41]))),[0,0,0,1,0x65,1,0,0,0,1,0x41]);
for(const bytes of [Buffer.alloc(0),Buffer.from([0,0,0,3,0x65]),Buffer.from([0,0,0,0])])assert.throws(()=>screen.annexB(bytes));
assert.throws(()=>screen.h264Configuration(avc.subarray(0,10)));const wrong=Buffer.from(avc);wrong[4]=254;assert.throws(()=>screen.h264Configuration(wrong));
});
await check('native screen server authenticates header and counter before delivering a frame',async()=>{
const endpoints=[],logs=[],feeds=[];let released=false;
class Endpoint{handlers={};closed=false;on(n,h){this.handlers[n]=h;}emit(n,v){this.handlers[n]?.(v);}async listen(){}async getLocalAddress(){return{port:30000};}async close(){this.closed=true;}}
const bridge={claim:()=>1,feed:(owner,bytes,config,pts)=>feeds.push({owner,bytes:Buffer.from(bytes),config,pts}),stats:()=>[feeds.length,0,0,0],release:()=>{released=true;}};
const {NativeScreenServer}=load('NativeScreenServer',{'./ScreenCodec':screen,'./VideoBridge':{VideoBridge:{instance:bridge}},'@kit.NetworkKit':{socket:{constructTCPSocketServerInstance:()=>{const e=new Endpoint();endpoints.push(e);return e;}}}},'.ets');
const key=crypto.randomBytes(32),native={open:async(k,n,d,aad)=>{const c=crypto.createDecipheriv('chacha20-poly1305',k,n,{authTagLength:16});c.setAAD(aad);c.setAuthTag(d.slice(-16));return Buffer.concat([c.update(d.slice(0,-16)),c.final()]);}};
const service=new NativeScreenServer(key,native,m=>logs.push(m));assert.equal(await service.start(),30000);const client=new Endpoint();endpoints[0].emit('connect',client);
client.emit('message',{message:Uint8Array.from(packet(1,avc)).buffer});await tick();assert.equal(feeds.length,1);assert.equal(feeds[0].config,true);
const plain=Buffer.from([0,0,0,2,0x65,1]),header=Buffer.alloc(128);header[4]=0;header.writeUInt32LE(plain.length+16);
const enc=crypto.createCipheriv('chacha20-poly1305',key,Buffer.alloc(12),{authTagLength:16});enc.setAAD(header);const sealed=Buffer.concat([enc.update(plain),enc.final(),enc.getAuthTag()]);
const bytes=Buffer.concat([header,sealed]);client.emit('message',{message:Uint8Array.from(bytes.subarray(0,130)).buffer});client.emit('message',{message:Uint8Array.from(bytes.subarray(130)).buffer});await tick();await tick();
assert.equal(feeds.length,2);assert.deepEqual(feeds[1].bytes,Buffer.from([0,0,0,1,0x65,1]));assert.ok(logs.some(m=>m.includes('首个视频帧')));
client.emit('message',{message:Uint8Array.from(packet(2,Buffer.alloc(8))).buffer});await tick();assert.equal(client.closed,false);assert.equal(feeds.length,2);
client.emit('message',{message:Uint8Array.from(packet(1,avc)).buffer});await tick();assert.equal(feeds.length,3);assert.equal(feeds[2].config,true);
// Replay uses nonce zero after the receiver advanced to nonce one: reject and close.
client.emit('message',{message:Uint8Array.from(bytes).buffer});await tick();assert.equal(feeds.length,3);assert.equal(client.closed,true);assert.equal(released,true);
await service.close();
});
await check('first rendered frame is reported once; video failure ends session and cancels polling',async()=>{
let poll,rendered=0,ended=0,output=0,error=0,released=0,cleared=0;
const server={on(){},async listen(){},async getLocalAddress(){return{port:30000};},async close(){}};
const bridge={claim:()=>1,stats:()=>[10,output,error,0],release:()=>{released++;}};
const {NativeScreenServer}=load('NativeScreenServer',{'./ScreenCodec':screen,'./VideoBridge':{VideoBridge:{instance:bridge}},'@kit.NetworkKit':{socket:{constructTCPSocketServerInstance:()=>server}}},'.ets',
{setInterval:cb=>{poll=cb;return 1;},clearInterval:()=>{cleared++;}});
const receiver=new NativeScreenServer(new Uint8Array(32),{},()=>{},()=>{rendered++;},()=>{ended++;});
await receiver.start();poll();assert.equal(rendered,0);output=1;poll();poll();assert.equal(rendered,1);
error=1;poll();await tick();assert.equal(ended,1);assert.equal(cleared,1);assert.equal(released,1);
poll();await receiver.close();assert.equal(ended,1);assert.equal(released,1);
});
console.log(count+' screen tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
