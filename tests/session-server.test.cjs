const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
function load(name,deps={}){const exports={};const extension=name==='SessionProbeServer'?'.ets':'.ts';
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../entry/src/main/ets/lab',name+extension),'utf8'),
{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,
{exports,Uint8Array,DataView,setTimeout,clearTimeout,require:id=>id==='./DisplayProfile'?load('DisplayProfile'):deps[id]});return exports;}
const parser=load('RtspProbe'),pairing=load('PairingCore'),control=load('ControlCipher',{'./PairingCore':pairing});const tick=()=>new Promise(r=>setImmediate(r));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};}
function fixture(extra={}){const servers=[],messages=[],events=[];
class Endpoint{handlers={};closed=false;sent=[];listenGate=undefined;closeGate=undefined;
on(name,handler){this.handlers[name]=handler;}emit(name,data){this.handlers[name]?.(data);}
async close(){if(this.closeGate)await this.closeGate.promise;this.closed=true;this.emit('close');}
async listen(){if(this.listenGate)await this.listenGate.promise;}
async send(data){this.sent.push(data);if(this.sendGate)await this.sendGate.promise;}}
const {SessionProbeServer}=load('SessionProbeServer',{'./IapPackages':load('IapPackages',{'./PairingCore':pairing}),'./CodecCapability':{probeOpus:async()=>false},'./AirPlayDiscovery':{AirPlayDiscovery:class{async start(){}async close(){}approvePeer(){}}},'./RtspProbe':parser,'./PairingCore':pairing,'@kit.NetworkKit':{socket:{constructTCPSocketServerInstance:()=>{
const s=new Endpoint();servers.push(s);return s;}}},'@kit.ArkTS':{util:{TextEncoder:class{encodeInto(t){return new TextEncoder().encode(t);}}}},...extra});
return{service:new SessionProbeServer(m=>messages.push(m),()=>{},e=>events.push(e)),servers,messages,events,Endpoint};}
let count=0;async function check(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
await check('native server waits for body then responds explicit 501 without logging credentials',async()=>{
const f=fixture();await f.service.start();const c=new f.Endpoint();f.servers[0].emit('connect',c);
c.emit('message',{message:new TextEncoder().encode('POST /pair-setup?secret=do-not-log HTTP/1.1\r\nContent-Length: 3\r\nCSeq: 9\r\n\r\n').buffer});
assert.equal(c.sent.length,0);c.emit('message',{message:Uint8Array.of(1,2,3).buffer});await tick();
const response=new TextDecoder().decode(c.sent[0].data);assert.match(response,/501 Not Implemented/);assert.match(response,/CSeq: 9/);
assert.equal(c.closed,true);assert.ok(f.messages.some(m=>m.includes('/pair-setup')));assert.ok(f.messages.every(m=>!m.includes('secret')));await f.service.stop();
});
await check('cancel during cleanup cannot resurrect TCP listener',async()=>{
const f=fixture();await f.service.start();const gate=deferred();f.servers[0].closeGate=gate;
const pending=f.service.start();await tick();await f.service.stop();gate.resolve();await assert.rejects(pending,/取消/);
assert.equal(f.servers.length,1);
});
await check('late peer from stopped server closes without receiving or responding',async()=>{
const f=fixture();await f.service.start();const server=f.servers[0];await f.service.stop();const c=new f.Endpoint();server.emit('connect',c);
await tick();assert.equal(c.closed,true);assert.equal(c.sent.length,0);
});
await check('invalid duplicate length closes peer without dispatching handler',async()=>{
const f=fixture();await f.service.start();const c=new f.Endpoint();f.servers[0].emit('connect',c);
c.emit('message',{message:new TextEncoder().encode('POST /info HTTP/1.1\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n').buffer});
await tick();assert.equal(c.closed,true);assert.equal(c.sent.length,0);await f.service.stop();
});
await check('M4 stays plaintext; queued next request and response use authenticated control records',async()=>{
const crypto=require('node:crypto'),read=crypto.randomBytes(32),write=crypto.randomBytes(32);
function seal(k,n,d,aad){const c=crypto.createCipheriv('chacha20-poly1305',k,n,{authTagLength:16});c.setAAD(aad);return Buffer.concat([c.update(d),c.final(),c.getAuthTag()]);}
function open(k,n,d,aad){const c=crypto.createDecipheriv('chacha20-poly1305',k,n,{authTagLength:16});c.setAAD(aad);c.setAuthTag(d.slice(-16));return Buffer.concat([c.update(d.slice(0,-16)),c.final()]);}
const f=fixture({'./NativePairCrypto':{NativePairCrypto:class{async seal(...a){return seal(...a);}async open(...a){return open(...a);}}},
 './PairingStore':{PairingStore:{load:async()=>({get:async()=>undefined,save:async()=>{}})}},'./ExperimentalAuth':{ExperimentalAuth:{load:async()=>({})}},
 './PairVerify':{PairVerify:class{verified=false;keys={readKey:read,writeKey:write};async handle(){this.verified=true;return Uint8Array.of(6,1,4);}dispose(){}}},'./ControlCipher':control});
await f.service.start({pairingId:'test',keys:{pubKey:{getEncoded:()=>({data:new Uint8Array(44)})}}},{});
const c=new f.Endpoint(),gate=deferred();c.getRemoteAddress=async()=>({address:'192.168.43.2'});c.sendGate=gate;f.servers[0].emit('connect',c);
c.emit('message',{message:new TextEncoder().encode('POST /pair-verify HTTP/1.1\r\nCSeq: 1\r\nContent-Length: 0\r\n\r\n').buffer});await tick();
assert.match(new TextDecoder().decode(c.sent[0].data),/^HTTP\/1.1 200 OK/);
const request=Buffer.from('GET /info?secret=do-not-log RTSP/1.0\r\nCSeq: 2\r\n\r\n'),head=Buffer.alloc(2);head.writeUInt16LE(request.length);
const record=Buffer.concat([head,seal(read,Buffer.alloc(12),request,head)]);c.emit('message',{message:Uint8Array.from(record).buffer});await tick();assert.equal(c.sent.length,1);
gate.resolve();await tick();await tick();const wire=Buffer.from(c.sent[1].data),length=wire.readUInt16LE(0);
assert.match(open(write,Buffer.alloc(12),wire.subarray(2,2+length+16),wire.subarray(0,2)).toString(),/^RTSP\/1.0 501 Not Implemented\r\nCSeq: 2/);
assert.equal(c.closed,true);assert.ok(f.messages.some(m=>m.includes('Pair-Verify 已完成')));assert.ok(f.messages.every(m=>!m.includes('secret')));await f.service.stop();
});
await check('audio SETUP returns both UDP ports and feedback; partial TEARDOWN preserves video/control',async()=>{
const {Plist:P,encodePlist,decodePlist}=load('Bplist',{'./PairingCore':pairing}),keys=[],audioStreams=[];let screenClosed=0;
class Audio{constructor(type,name,connection,format,key){Object.assign(this,{type,audioType:name,connection,format,key});audioStreams.push(this);}async start(){return P.dict(['type','dataPort','controlPort','streamConnectionID'],[P.int(this.type),P.int(40000),P.int(40001),P.int(this.connection)]);}feedback(){return P.dict(['type','sampleRate'],[P.int(this.type),P.int(this.format.rate)]);}async close(){this.closed=true;}}
const f=fixture({'./Bplist':{Plist:P,encodePlist,decodePlist},'./AudioCodec':load('AudioCodec'),'./NativeAudioServer':{NativeAudioServer:Audio}});
await f.service.start();const c=new f.Endpoint();f.servers[0].emit('connect',c);const peer=f.service.peers[0];peer.authenticated=true;peer.verify={shared:new Uint8Array(32),dispose(){}};
peer.crypto={hkdf:async(k,s,i)=>{keys.push(new TextDecoder().decode(s));return new Uint8Array(32);}};
peer.resources={clock:{ntp:()=>123n},async close(){}};peer.screen={closed:false,async close(){if(!this.closed){this.closed=true;screenClosed++;}}};peer.remoteAddress='192.168.43.2';
async function request(method,path,body){const head=new TextEncoder().encode(`${method} ${path} RTSP/1.0\r\nCSeq: 1\r\nContent-Length: ${body.length}\r\n\r\n`);c.emit('message',{message:Uint8Array.from([...head,...body]).buffer});await tick();await tick();const response=Buffer.from(c.sent.at(-1).data),split=response.indexOf('\r\n\r\n');assert.match(response.subarray(0,split).toString(),/200 OK/);return response.subarray(split+4);}
const stream=P.dict(['type','audioType','streamConnectionID','audioFormat'],[P.int(100),P.str('media'),P.int(0xffffffffffffffffn),P.int(32768)]);
const response=decodePlist(await request('SETUP','/',encodePlist(P.dict(['streams'],[P.array([stream])])))).entries.get('streams').items[0];
assert.equal(response.entries.get('dataPort').number(),40000);assert.equal(response.entries.get('controlPort').number(),40001);assert.equal(keys[0],'DataStream-Salt18446744073709551615');
const feedback=decodePlist(await request('POST','/feedback',new Uint8Array())).entries.get('streams');assert.equal(feedback.items[0].entries.get('sampleRate').number(),48000);
await request('TEARDOWN','/',encodePlist(P.dict(['streams'],[P.array([P.dict(['type'],[P.int(100)])])])));assert.equal(audioStreams[0].closed,true);assert.equal(screenClosed,0);assert.equal(c.closed,false);assert.equal(peer.audio.length,0);
await request('RECORD','/',new Uint8Array());await f.service.stop();assert.equal(screenClosed,1);
});
await check('cancel during codec capability probe cannot advertise support or open listener',async()=>{
const gate=deferred();let entered=false;
const f=fixture({'./PairingStore':{PairingStore:{load:async()=>({})}},'./ExperimentalAuth':{ExperimentalAuth:{load:async()=>({})}},
 './CodecCapability':{probeOpus:async()=>{entered=true;return gate.promise;}}});
const pending=f.service.start({},{});await tick();assert.equal(entered,true);await f.service.stop();gate.resolve(true);
await assert.rejects(pending,/取消/);assert.equal(f.servers.length,0);assert.equal(f.service.opus,false);
});
await check('type 130 derives from seed, echoes unsigned connection ID and preserves tunnel on unrelated stream teardown',async()=>{
const {Plist:P,encodePlist,decodePlist}=load('Bplist',{'./PairingCore':pairing}),salts=[],tunnels=[];
class Tunnel{constructor(...args){this.args=args;tunnels.push(this);}async start(){return 32100;}async close(){this.closed=true;}}
const f=fixture({'./Bplist':{Plist:P,encodePlist,decodePlist},'./NativeIapTunnel':{NativeIapTunnel:Tunnel}});await f.service.start();
const c=new f.Endpoint();c.getRemoteAddress=async()=>({address:'192.168.43.2'});f.servers[0].emit('connect',c);const peer=f.service.peers[0];
peer.authenticated=true;peer.verify={shared:new Uint8Array(32),dispose(){}};peer.crypto={hkdf:async(k,s)=>{salts.push(new TextDecoder().decode(s));return new Uint8Array(32);}};
peer.resources={close:async()=>{}};peer.wireless={ssid:'lab',passphrase:'do-not-log'};const auth={};
async function request(method,body){peer.queue.push(new parser.RtspRequest(method,'/','RTSP/1.0','5',encodePlist(body)));
await f.service.drain(peer,f.service.generation,auth);const wire=Buffer.from(c.sent.at(-1).data);assert.match(wire.toString('utf8',0,30),/200 OK/);return wire.subarray(wire.indexOf('\r\n\r\n')+4);}
const stream=P.dict(['type','clientTypeUUID','seed','streamConnectionID'],[P.int(130),P.str('E9459FD0-BCAD-4C45-820F-1E72447EF2F2'),P.int(0xffffffffffffffffn),P.int(42)]);
const result=decodePlist(await request('SETUP',P.dict(['streams'],[P.array([stream])]))).entries.get('streams').items[0];
assert.equal(result.entries.get('streamID').number(),1);assert.equal(result.entries.get('dataPort').number(),32100);assert.equal(result.entries.get('streamConnectionID').number(),42);
assert.equal(salts[0],'DataStream-Salt18446744073709551615');assert.equal(tunnels[0].args[2],'192.168.43.2');assert.equal(tunnels[0].args[4],auth);
await request('TEARDOWN',P.dict(['streams'],[P.array([P.dict(['type','streamID'],[P.int(130),P.int(2)])])]));assert.equal(tunnels[0].closed,undefined);
await request('TEARDOWN',P.dict(['streams'],[P.array([P.dict(['type','streamID'],[P.int(130),P.int(1)])])]));assert.equal(tunnels[0].closed,true);assert.equal(c.closed,false);
assert.ok(f.messages.every(m=>!m.includes('do-not-log')));await f.service.stop();
});
await check('screen teardown emits disconnect after response while preserving control; later close emits no duplicate',async()=>{
const {Plist:P,encodePlist,decodePlist}=load('Bplist',{'./PairingCore':pairing});
const f=fixture({'./Bplist':{Plist:P,encodePlist,decodePlist}});await f.service.start();
const c=new f.Endpoint();f.servers[0].emit('connect',c);const peer=f.service.peers[0];peer.authenticated=true;let closed=0;
peer.screen={close:async()=>{closed++;}};
const body=encodePlist(P.dict(['streams'],[P.array([P.dict(['type'],[P.int(110)])])]));
peer.queue.push(new parser.RtspRequest('TEARDOWN','/','RTSP/1.0','8',body));await f.service.drain(peer,f.service.generation,undefined);
assert.equal(closed,1);assert.equal(peer.screen,undefined);assert.equal(c.closed,false);assert.deepEqual(f.events,['ended']);
assert.match(new TextDecoder().decode(c.sent[0].data),/200 OK/);await c.close();assert.deepEqual(f.events,['ended']);await f.service.stop();
});
await check('one session display declaration reaches info, event HID resources and screen decoder',async()=>{
const bp=load('Bplist',{'./PairingCore':pairing}),{Plist:P,encodePlist,decodePlist}=bp;
const profile=load('DisplayProfile'),display=profile.displayProfile(2560,1600,343,343),resources=[],screens=[];
const f=fixture({'./Bplist':bp,'./ReceiverInfo':load('ReceiverInfo',{'./Bplist':bp}),
 './SessionResources':{SessionResources:class{constructor(report,p){resources.push(p);}async start(){return P.dict([],[]);}async close(){}}},
 './NativeScreenServer':{NativeScreenServer:class{constructor(...args){screens.push(args[5]);}async start(){return 31000;}async close(){}}}});
await f.service.start(undefined,undefined,'00:11:22:33:44:55','',undefined,display);
const c=new f.Endpoint();c.getRemoteAddress=async()=>({address:'192.168.43.2',port:7000});f.servers[0].emit('connect',c);
const peer=f.service.peers[0];peer.authenticated=true;peer.verify={shared:new Uint8Array(32),dispose(){}};peer.crypto={hkdf:async()=>new Uint8Array(32)};
async function request(method,path,body){peer.queue.push(new parser.RtspRequest(method,path,'RTSP/1.0','1',body?encodePlist(body):new Uint8Array(0)));await f.service.drain(peer,f.service.generation,undefined);const wire=Buffer.from(c.sent.at(-1).data);assert.match(wire.toString('utf8',0,30),/200 OK/);return decodePlist(wire.subarray(wire.indexOf('\r\n\r\n')+4));}
const info=await request('GET','/info');assert.equal(info.entries.get('displays').items[0].entries.get('heightPixels').number(),800);
await request('SETUP','/',P.dict([],[]));assert.equal(resources[0],display);
await request('SETUP','/',P.dict(['streams'],[P.array([P.dict(['type','streamConnectionID'],[P.int(110),P.int(42)])])]));assert.equal(screens[0],display);
await f.service.stop();
});
console.log(count+' native session server tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});

