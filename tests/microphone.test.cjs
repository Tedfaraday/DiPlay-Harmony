const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
function load(name,deps={},ext='.ts') { const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/../entry/src/main/ets/lab/'+name+ext,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,Uint8Array,DataView,require:id=>id==='./DisplayProfile'?load('DisplayProfile'):deps[id]});return exports; }
const core=load('PairingCore'),codec=load('AudioCodec'),plist=load('Bplist',{'./PairingCore':core});
const packet=load('MicrophonePacket',{'./PairingCore':core,'./AudioCodec':codec});
const tick=()=>new Promise(r=>setImmediate(r));
function gate(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
const cipher={seal:async(k,n,p,a)=>{const c=crypto.createCipheriv('chacha20-poly1305',k,n,{authTagLength:16});c.setAAD(a);return Buffer.concat([c.update(p),c.final(),c.getAuthTag()]);}};
function decode(wire,key){const p=new codec.AudioPacket(wire),c=crypto.createDecipheriv('chacha20-poly1305',key,p.nonce,{authTagLength:16});c.setAAD(p.aad);c.setAuthTag(p.sealed.slice(-16));return {p,plain:Buffer.concat([c.update(p.sealed.slice(0,-16)),c.final()])};}
function fixture(opts={}){
 const capturers=[],sockets=[],reports=[],key=crypto.randomBytes(32);let createGate,bindGate;
 class Capturer {handlers={};started=false;released=false;constructor(options){this.options=options;}on(n,h){this.handlers[n]=h;}off(n){delete this.handlers[n];}async getStreamInfo(){return {...this.options.streamInfo,...opts.actual};}async start(){this.started=true;}async stop(){this.started=false;}async release(){this.released=true;}}
 class Socket {closed=false;sent=[];on(){}async bind(){if(bindGate)await bindGate.promise;}async close(){this.closed=true;}async send(v){this.sent.push({data:Buffer.from(new Uint8Array(v.data)),address:{...v.address}});}}
 const audio={AudioChannel:{CHANNEL_1:1},AudioSampleFormat:{SAMPLE_FORMAT_S16LE:1},AudioEncodingType:{ENCODING_TYPE_RAW:0},SourceType:{SOURCE_TYPE_MIC:0},createAudioCapturer:async options=>{if(opts.deny)throw Error('permission');const c=new Capturer(options);capturers.push(c);if(createGate)await createGate.promise;return c;}};
 const mod=load('NativeMicrophone',{'@kit.AudioKit':{audio},'@kit.NetworkKit':{socket:{constructUDPSocketInstance:()=>{const s=new Socket();sockets.push(s);return s;}}},'./AudioCodec':codec,'./MicrophonePacket':packet},'.ets');
 return {mod,capturers,sockets,reports,key,newMic:(crypt=cipher)=>new mod.NativeMicrophone(codec.pcmFormat(16),key,crypt,'192.0.2.10',41000,320,m=>reports.push(m)),createGate:g=>createGate=g,bindGate:g=>bindGate=g};
}
let count=0;async function check(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
await check('uplink RTP is independently decrypted; PCM endianness, timestamps, nonce, and sequence advance',async()=>{
 const p=new packet.MicrophonePacketizer(),key=crypto.randomBytes(32),input=Uint8Array.of(0x34,0x12,0xcd,0xab);
 const w=await p.packet(input,key,cipher),d=decode(w,key);assert.equal(w[1],100);assert.deepEqual([...d.plain],[0x12,0x34,0xab,0xcd]);assert.equal(d.p.counter,0n);assert.equal(d.p.sample,0);
 const w2=await p.packet(input,key,cipher),d2=decode(w2,key);assert.equal(w2[3],1);assert.equal(d2.p.counter,1n);assert.equal(d2.p.sample,2);
 w2[4]^=1;assert.throws(()=>decode(w2,key));assert.deepEqual([...input],[0x34,0x12,0xcd,0xab]);
 await assert.rejects(p.packet(new Uint8Array(3),key,cipher));
});
await check('failed seal consumes nonce, preventing reuse on retry',async()=>{
 const p=new packet.MicrophonePacketizer(),key=crypto.randomBytes(32);await assert.rejects(p.packet(Uint8Array.of(0,0),key,{seal:async()=>{throw Error('seal');}}));
 assert.equal(decode(await p.packet(Uint8Array.of(0,0),key,cipher),key).p.counter,1n);
});
await check('input capability probe never starts recording, releases all capturers, handles denial and mismatch',async()=>{
 const f=fixture();assert.equal(await f.mod.probeMicrophone(()=>false),0x4154);assert.equal(f.capturers.length,5);assert.ok(f.capturers.every(c=>c.released&&!c.started));
 assert.equal(await fixture({deny:true}).mod.probeMicrophone(()=>false),0);assert.equal(await fixture({actual:{channels:2}}).mod.probeMicrophone(()=>false),0);
 const cancelled=fixture();assert.equal(await cancelled.mod.probeMicrophone(()=>true),0);assert.equal(cancelled.capturers.length,0);
});
await check('uplink frames split callbacks, sends only to paired peer, wipes samples and stops resources',async()=>{
 const f=fixture(),mic=f.newMic();assert.equal(f.capturers.length,0);await mic.start();const c=f.capturers[0];assert.equal(c.started,true);
 const data=new Uint8Array(640).fill(12);c.handlers.readData(data.slice(0,110).buffer);await tick();assert.equal(f.sockets[0].sent.length,0);c.handlers.readData(data.slice(110).buffer);await tick();
 assert.equal(f.sockets[0].sent.length,1);assert.equal(f.sockets[0].sent[0].address.address,'192.0.2.10');assert.equal(decode(f.sockets[0].sent[0].data,f.key).plain.length,640);
 const lateCallback=c.handlers.readData;await mic.close();lateCallback(data.buffer);await tick();assert.equal(f.sockets[0].sent.length,1);assert.ok(c.released&&!c.started);assert.ok(f.sockets[0].closed);assert.ok(mic.key.every(x=>x===0));assert.ok(f.reports.every(m=>!m.includes('192.0.2.10')));
});
await check('cancellation during capturer creation or UDP bind cannot start recording',async()=>{
 for(const field of ['createGate','bindGate']){const f=fixture(),g=gate(),mic=f.newMic();f[field](g);const pending=mic.start();await tick();await mic.close();g.resolve();await pending;assert.ok(f.capturers.every(c=>c.released&&!c.started));assert.ok(f.sockets.every(s=>s.closed));}
});
await check('backpressure stops microphone and wipes queued audio instead of accumulating speech',async()=>{
 const f=fixture(),g=gate(),mic=f.newMic({seal:async(...args)=>{await g.promise;return cipher.seal(...args);}});await mic.start();const c=f.capturers[0];c.handlers.readData(new ArrayBuffer(640));await tick();c.handlers.readData(new ArrayBuffer(640*9));await tick();assert.equal(mic.closed,true);assert.equal(mic.queue.length,0);g.resolve();await tick();assert.equal(f.sockets[0].sent.length,0);assert.equal(c.released,true);
});
await check('duplex advertises only probed matching mono PCM and preserves stereo music and AAC',()=>{
 const info=load('ReceiverInfo',{'./Bplist':plist}).receiverInfo('00:00:00:00:00:00',true,undefined,0x4010);
 const formats=info.entries.get('audioFormats').items;for(const f of formats){const type=f.entries.get('type').number(),name=f.entries.get('audioType').text.toLowerCase();
 if(type===100&&['compatibility','default','telephony','speechrecognition'].includes(name)){assert.equal(f.entries.get('audioInputFormats').number(),0x4010);assert.equal(f.entries.get('audioOutputFormats').number(),0x4010);}else{assert.equal(f.entries.has('audioInputFormats'),false);}}
 assert.equal(formats.find(f=>f.entries.get('type').number()===102&&f.entries.get('audioType').text==='media').entries.get('audioOutputFormats').number(),0x800000);
});
await check('SETUP diagnostics expose allowed numeric fields and bounded names, never arbitrary plist values',()=>{
 const {Plist:P}=plist,s=P.dict(['type','audioType','audioFormat','dataPort','streamConnectionID','shk','name'],[P.int(100),P.str('private phone'),P.int(16),P.int(41000),P.int(123456789),P.bytes(Uint8Array.of(1,2)),P.str('private ssid')]);
 const summary=load('AudioDiagnostics',{'./AudioCodec':codec}).audioSetupSummary(s);assert.match(summary,/type=100/);assert.match(summary,/inputPortPresent=yes/);assert.doesNotMatch(summary,/private|123456789|shk/);
});
console.log(count+' microphone tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
