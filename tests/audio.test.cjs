const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
function load(name,deps={},ext='.ts',globals={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/../entry/src/main/ets/lab/'+name+ext,'utf8'),
{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,Uint8Array,DataView,Date,setInterval,clearInterval,require:id=>id==='./DisplayProfile'?load('DisplayProfile'):deps[id],...globals});return exports;}
const codec=load('AudioCodec'),core=load('PairingCore'),plist=load('Bplist',{'./PairingCore':core});
const tick=()=>new Promise(r=>setImmediate(r));const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};};
function seal(k,n,d,a){const c=crypto.createCipheriv('chacha20-poly1305',k,n,{authTagLength:16});c.setAAD(a);return Buffer.concat([c.update(d),c.final(),c.getAuthTag()]);}
function open(k,n,d,a){const c=crypto.createDecipheriv('chacha20-poly1305',k,n,{authTagLength:16});c.setAAD(a);c.setAuthTag(d.subarray(-16));return Buffer.concat([c.update(d.subarray(0,-16)),c.final()]);}
function packet(key,counter,sample,pcm){const head=Buffer.alloc(12),nonce=Buffer.alloc(12);head[0]=128;head[1]=96;head.writeUInt16BE(Number(counter%65536n),2);head.writeUInt32BE(sample>>>0,4);head.writeUInt32BE(987,8);nonce.writeBigUInt64LE(counter,4);return Buffer.concat([head,seal(key,nonce,pcm,head.subarray(4)),nonce.subarray(4)]);}
function fixture(bits=32768,type=100){let ms=0,port=35000,createGate,bindGate;const endpoints=[],renderers=[],reports=[],timers=[];
class Endpoint{handlers={};closed=false;port=port++;on(n,h){this.handlers[n]=h;}emit(n,x){this.handlers[n]?.(x);}async bind(){if(bindGate)await bindGate.promise;this.bound=true;}async setExtraOptions(){}async getLocalAddress(){return{port:this.port};}async close(){this.closed=true;}}
class Renderer{handlers={};started=false;released=false;on(n,h){this.handlers[n]=h;}off(n){delete this.handlers[n];}async start(){this.started=true;}async stop(){this.started=false;}async release(){this.released=true;}}
const audio={createAudioRenderer:async(options)=>{const r=new Renderer();r.options=options;renderers.push(r);if(createGate)await createGate.promise;return r;},AudioSampleFormat:{SAMPLE_FORMAT_S16LE:1},AudioEncodingType:{ENCODING_TYPE_RAW:0},StreamUsage:{STREAM_USAGE_MUSIC:1},AudioDataCallbackResult:{VALID:0,INVALID:-1}};
const native={packets:[],outputs:[],stopped:false,startAudio:(rate,channels,kind)=>{assert.equal(rate,48000);assert.equal(channels,codec.pcmFormat(bits).channels);assert.equal(kind,codec.pcmFormat(bits).codec);return 7;},feedAudio:(id,data,ptsUs)=>{assert.equal(id,7);native.packets.push({data,ptsUs});return true;},readAudio:()=>native.outputs.shift(),stopAudio:()=>{native.stopped=true;}};
const bridge=load('AudioDecodeBridge',{'libdiplayvideo.so':{default:native},'./AudioCodec':codec},'.ets');
const {NativeAudioServer}=load('NativeAudioServer',{'@kit.NetworkKit':{socket:{constructUDPSocketInstance:()=>{const s=new Endpoint();endpoints.push(s);return s;}}},'@kit.AudioKit':{audio},
'@kit.BasicServicesKit':{systemDateTime:{TimeType:{STARTUP:0},getUptime:()=>ms}},'./AudioCodec':codec,'./Bplist':plist,'./AudioDecodeBridge':bridge},'.ets',
{setInterval:(fn,interval)=>{timers.push({fn,interval,active:true});return timers.length-1;},clearInterval:id=>{timers[id].active=false;}});
const key=crypto.randomBytes(32),server=new NativeAudioServer(type,'media',0xffffffffffffffffn,codec.pcmFormat(bits),key,{open:async(...args)=>open(...args)},'192.168.43.2',m=>reports.push(m));
return{server,key,endpoints,renderers,reports,native,timers,pump:()=>timers.filter(t=>t.active).forEach(t=>t.fn()),setTime:t=>{ms=t;},setCreateGate:g=>{createGate=g;},setBindGate:g=>{bindGate=g;},emit:w=>endpoints[0].emit('message',{message:Uint8Array.from(w).buffer,remoteInfo:{address:'192.168.43.2'}})};}
let count=0;async function check(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
await check('independent encrypted RTP fixture binds timestamp/SSRC and little-endian nonce; replay cannot poison window',()=>{
const key=crypto.randomBytes(32),wire=packet(key,33n,0xfffffff0,Buffer.from([0x12,0x34,0xab,0xcd])),p=new codec.AudioPacket(wire),window=new codec.AudioReplayWindow();
assert.equal(p.sample,0xfffffff0);assert.equal(p.counter,33n);assert.deepEqual(Buffer.from(codec.pcmLittleEndian(open(key,p.nonce,p.sealed,p.aad),2)),Buffer.from([0x34,0x12,0xcd,0xab]));
assert.equal(window.accepts(33n),true);const corrupt=new codec.AudioPacket(Buffer.from(wire));corrupt.aad[0]^=1;assert.throws(()=>open(key,corrupt.nonce,corrupt.sealed,corrupt.aad));assert.equal(window.accepts(33n),true);
window.commit(33n);assert.equal(window.accepts(33n),false);window.commit(31n);window.commit(400n);assert.equal(window.accepts(33n),false);assert.equal(window.accepts(399n),true);
assert.throws(()=>new codec.AudioPacket(new Uint8Array(37)));assert.throws(()=>codec.pcmFormat(0x70000000));assert.throws(()=>codec.pcmLittleEndian(new Uint8Array(3),1));
});
await check('jitter queue reorders across RTP timestamp wrap, inserts silence for loss and trims late samples',()=>{
const q=new codec.PcmJitterBuffer(codec.pcmFormat(4));q.push(0,Uint8Array.of(5,6,7,8));q.push(0xfffffffe,Uint8Array.of(1,2,3,4));const target=new Uint8Array(8);assert.equal(q.fill(target,true),8);assert.deepEqual([...target],[1,2,3,4,5,6,7,8]);
q.push(4,Uint8Array.of(9,10));const gap=new Uint8Array(6);assert.equal(q.fill(gap),2);assert.deepEqual([...gap],[0,0,0,0,9,10]);q.push(3,Uint8Array.of(1,1));assert.equal(q.queuedBytes,0);q.clear();
});
await check('PCM prefill is bounded; short sounds play after timeout; long pauses can resume',()=>{
const q=new codec.PcmJitterBuffer(codec.pcmFormat(4)),target=new Uint8Array(4);q.push(100,Uint8Array.of(1,2));assert.equal(q.fill(target),0);assert.deepEqual([...target],[0,0,0,0]);assert.equal(q.fill(target,true),2);
q.fill(new Uint8Array(8000));q.push(101,Uint8Array.of(3,4));assert.equal(q.fill(target,true),2);assert.deepEqual([...target],[3,4,0,0]);
for(let i=0;i<100;i++)q.push(5000+i*100,new Uint8Array(200));assert.ok(q.queuedBytes<=3200);q.clear();assert.equal(q.queuedBytes,0);
});
await check('renderer receives authenticated PCM only, fills entire callback, and releases all resources',async()=>{
const f=fixture(),setup=await f.server.start();assert.equal(setup.entries.get('dataPort').number(),35000);assert.equal(setup.entries.get('controlPort').number(),35001);assert.equal(setup.entries.get('streamConnectionID').integer,0xffffffffffffffffn);
const raw=Buffer.from([0x12,0x34,0xab,0xcd]),valid=packet(f.key,0n,1000,raw),bad=Buffer.from(valid);bad[13]^=1;f.emit(bad);await tick();assert.equal(f.renderers[0].started,false);
f.emit(valid);await tick();await tick();assert.equal(f.renderers[0].started,true);f.setTime(60);const buffer=new ArrayBuffer(16);new Uint8Array(buffer).fill(255);assert.equal(f.renderers[0].handlers.writeData(buffer),0);
assert.deepEqual([...new Uint8Array(buffer)],[0x34,0x12,0xcd,0xab,...new Array(12).fill(0)]);f.emit(valid);await tick();assert.equal(f.server.packets,1);
const feedback=f.server.feedback({ntp:()=>123n});assert.equal(feedback.entries.get('sampleTime').number(),2440);assert.equal(feedback.entries.get('timestamp').integer,123n);
assert.ok(f.reports.every(m=>!m.includes('1234')&&!m.includes('abcd')));await f.server.close();assert.ok(f.endpoints.every(e=>e.closed));assert.equal(f.renderers[0].released,true);assert.ok(f.server.key.every(n=>n===0));
});
await check('stop during renderer creation releases late renderer without binding UDP',async()=>{
const f=fixture(),gate=deferred();f.setCreateGate(gate);const pending=f.server.start();await tick();await f.server.close();gate.resolve();await assert.rejects(pending,/关闭/);assert.equal(f.endpoints.length,0);assert.equal(f.renderers[0].released,true);
});
await check('stop during UDP bind re-closes late binding and prevents creating control socket',async()=>{
const f=fixture(),gate=deferred();f.setBindGate(gate);const pending=f.server.start();await tick();await f.server.close();gate.resolve();await assert.rejects(pending,/关闭/);assert.equal(f.endpoints.length,1);assert.equal(f.endpoints[0].closed,true);assert.equal(f.renderers[0].released,true);
});
await check('AAC-LC capability uses independent ADTS bit parsing and rejects invalid lengths',()=>{
for(const bits of [0x400000,0x800000]){const format=codec.pcmFormat(bits),payload=Uint8Array.from([1,2,3,4,5]),frame=codec.aacAdts(payload,format);
assert.equal(format.codec,'aac');assert.equal(frame[0],255);assert.equal((frame[2]>>>6)+1,2);assert.equal((frame[2]>>>2)&15,bits===0x800000?3:4);
assert.equal(((frame[2]&1)<<2)|(frame[3]>>>6),2);assert.equal(((frame[3]&3)<<11)|(frame[4]<<3)|(frame[5]>>>5),12);assert.deepEqual([...frame.subarray(7)],[1,2,3,4,5]);assert.deepEqual([...codec.aacAdts(frame,format)],[...frame]);}
assert.throws(()=>codec.aacAdts(new Uint8Array(8190),codec.pcmFormat(0x800000)));const bad=codec.aacAdts(Uint8Array.of(1),codec.pcmFormat(0x800000));bad[4]=255;assert.throws(()=>codec.aacAdts(bad,codec.pcmFormat(0x800000)));
});
await check('encrypted AAC feeds native decoder; asynchronous PCM is drained without another UDP packet',async()=>{
const f=fixture(0x800000,102);await f.server.start();f.emit(packet(f.key,0n,1000,Buffer.from([1,2,3,4])));await tick();await tick();
assert.equal(f.native.packets.length,1);assert.equal(f.native.packets[0].ptsUs,20833);assert.deepEqual([...new Uint8Array(f.native.packets[0].data).subarray(7)],[1,2,3,4]);
f.native.outputs.push({data:Uint8Array.of(0x34,0x12,0xcd,0xab).buffer,ptsUs:20833});f.setTime(60);f.pump();const buffer=new ArrayBuffer(8);f.renderers[0].handlers.writeData(buffer);assert.deepEqual([...new Uint8Array(buffer)],[0x34,0x12,0xcd,0xab,0,0,0,0]);
await f.server.close();assert.equal(f.native.stopped,true);assert.ok(f.timers.every(t=>!t.active));
});
await check('receiver declares a media AAC stream and only supported output formats',()=>{
const info=load('ReceiverInfo',{'./Bplist':plist}).receiverInfo('00:00:00:00:00:00'),formats=info.entries.get('audioFormats').items;
assert.equal(formats.find(f=>f.entries.get('type').number()===102).entries.get('audioOutputFormats').number(),0x800000);
assert.ok(formats.every(f=>!f.entries.has('audioInputFormats')));assert.ok(formats.every(f=>(f.entries.get('audioOutputFormats').number()&0x70000000)===0));
});
await check('Opus format bits use mono 48 kHz RTP clock; enabled capabilities retain PCM/AAC fallback',()=>{
for(const bits of [0x10000000,0x20000000,0x40000000]){const format=codec.pcmFormat(bits);assert.equal(format.codec,'opus');assert.equal(format.rate,48000);assert.equal(format.channels,1);}
const info=load('ReceiverInfo',{'./Bplist':plist}).receiverInfo('00:00:00:00:00:00',true),formats=info.entries.get('audioFormats').items;
for(const type of [100,101])assert.equal(formats.find(f=>f.entries.get('type').number()===type&&f.entries.get('audioType').text==='default').entries.get('audioOutputFormats').number()&0x70000000,0x70000000);
assert.ok(formats.every(f=>!f.entries.has('audioInputFormats')));assert.ok(info.entries.get('extendedFeatures').items.some(f=>f.text==='vocoderInfo'));
});
await check('authenticated Opus packet reaches native decoder without ADTS and yields mono renderer PCM',async()=>{
const f=fixture(0x40000000,101);await f.server.start();f.emit(packet(f.key,0n,960,Buffer.from([0xf8,0xff,0xfe])));await tick();await tick();
assert.deepEqual([...new Uint8Array(f.native.packets[0].data)],[0xf8,0xff,0xfe]);assert.equal(f.native.packets[0].ptsUs,20000);
f.native.outputs.push({data:Uint8Array.of(0x34,0x12).buffer,ptsUs:20000});f.setTime(60);f.pump();const buffer=new ArrayBuffer(4);f.renderers[0].handlers.writeData(buffer);assert.deepEqual([...new Uint8Array(buffer)],[0x34,0x12,0,0]);
assert.equal(f.renderers[0].options.streamInfo.channels,1);await f.server.close();assert.equal(f.native.stopped,true);
});
console.log(count+' audio tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
