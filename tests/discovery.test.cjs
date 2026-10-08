const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
function load(name,deps={},ext='.ts'){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/../entry/src/main/ets/lab/'+name+ext,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,Uint8Array,DataView,setTimeout,clearTimeout,require:id=>id==='./DisplayProfile'?load('DisplayProfile'):deps[id]});return exports;}
const core=load('PairingCore'),plist=load('Bplist',{'./PairingCore':core}),receiver=load('ReceiverInfo',{'./Bplist':plist});
const control=load('Iap2Control'),wireless=load('WirelessControl',{'./Iap2Control':control});
const identity={pairingId:'public-pairing-id',keys:{pubKey:{getEncoded:()=>({data:Uint8Array.from([...new Array(12).fill(0),...new Array(32).fill(7)])})}}};
const tick=()=>new Promise(r=>setImmediate(r)),deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise};};
function fixture(useHotspot=false){const published=[],removed=[],clients=[],reports=[],hotspots=[];let addGate,bindGate;
const discovery={handlers:{},on(n,h){this.handlers[n]=h;},off(n){delete this.handlers[n];},startSearchingMDNS(){this.started=true;},stopSearchingMDNS(){this.stopped=true;}};
class Client{handlers={};sent=[];on(n,h){this.handlers[n]=h;}emit(n,data){this.handlers[n]?.(data);}async bind(o){this.binding=o;if(bindGate)await bindGate.promise;}async connect(o){this.connected=o;}async send(o){this.sent.push(o);}async close(){this.closed=true;this.emit('close');}}
const mdns={addLocalService:async(ctx,s)=>{published.push(s);if(addGate)await addGate.promise;return s;},removeLocalService:async(ctx,s)=>{removed.push(s);},createDiscoveryService:(ctx,type)=>{discovery.type=type;return discovery;},resolveLocalService:async(ctx,s)=>s};
const {AirPlayDiscovery}=load('AirPlayDiscovery',{'@kit.NetworkKit':{mdns,socket:{constructTCPSocketInstance:()=>{const c=new Client();clients.push(c);return c;}}},'@kit.ArkTS':{util:{TextEncoder:class{encodeInto(s){return new TextEncoder().encode(s);}},TextDecoder:{create:()=>({decodeToString:b=>new TextDecoder().decode(b)})}}},'./ReceiverInfo':receiver,'./HotspotMdns':{HotspotMdns:class{constructor(address,deviceId,report,resolve){Object.assign(this,{address,deviceId,resolve});hotspots.push(this);}start(){if(!useHotspot)throw new Error('test system fallback');}approvePeer(address){this.approved=address;}close(){this.closed=true;}}}},'.ets');
return{service:new AirPlayDiscovery({},'00:11:22:33:44:55',m=>reports.push(m),'192.168.43.1'),published,removed,clients,reports,discovery,hotspots,setAddGate:g=>addGate=g,setBindGate:g=>bindGate=g,found:s=>discovery.handlers.serviceFound(s)};}
let count=0;async function check(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
await check('AirPlay discovery TXT features match info and publish only the public receiver identity',async()=>{
const f=fixture();await f.service.start(identity);const attrs=Object.fromEntries(f.published[0].serviceAttribute.map(a=>[a.key,new TextDecoder().decode(Uint8Array.from(a.value))]));
assert.equal(f.published[0].serviceType,'_airplay._tcp');assert.equal(f.published[0].port,7000);assert.equal(attrs.features,'0x5653aee2,0x61');assert.equal(attrs.pk,'07'.repeat(32));assert.equal(attrs.pi,'public-pairing-id');assert.equal(f.discovery.started,true);assert.equal(f.discovery.type,'_carplay-ctrl._tcp');
const mac='00:11:22:33:44:55',info=receiver.receiverInfo(mac);
const start=wireless.startWirelessSession(new wireless.WirelessSettings('test','password','192.168.43.1'),mac,attrs.pk,s=>new TextEncoder().encode(s));
assert.equal(attrs.deviceid,info.entries.get('deviceID').text);
assert.equal(new TextDecoder().decode(control.readParameters(start.slice(6),3)[0]),attrs.deviceid+'\0');
assert.notEqual(attrs.deviceid,attrs.pi);
assert.ok(f.reports.every(m=>!m.includes(attrs.pi)&&!m.includes(attrs.pk)));await f.service.close();assert.equal(f.removed.length,1);assert.equal(f.discovery.stopped,true);
});
await check('control probe only contacts authenticated phone IP, binds hotspot, parses fragmented status, and suppresses duplicates',async()=>{
const f=fixture();await f.service.start(identity);const entry={host:{address:'192.168.43.2'},port:12345};f.found(entry);f.found({host:{address:'192.168.43.3'},port:12345});await tick();assert.equal(f.clients.length,0);
f.service.approvePeer('192.168.43.2');await tick();assert.equal(f.clients.length,1);const c=f.clients[0];assert.equal(c.binding.address,'192.168.43.1');assert.equal(c.connected.address.port,12345);
assert.match(new TextDecoder().decode(c.sent[0].data),/^GET \/ctrl-int\/1\/connect HTTP\/1.1/);assert.match(new TextDecoder().decode(c.sent[0].data),/AirPlay-Receiver-Device-ID: 001122334455/);
c.emit('message',{message:new TextEncoder().encode('HTTP/1.1 ').buffer});c.emit('message',{message:new TextEncoder().encode('200 OK\r\n').buffer});assert.ok(f.reports.some(m=>m.endsWith('200')));assert.equal(c.closed,true);
f.found(entry);await tick();assert.equal(f.clients.length,1);await f.service.close();
});
await check('stop during service registration removes late registration without starting discovery',async()=>{
const f=fixture(),gate=deferred();f.setAddGate(gate);const start=f.service.start(identity);await tick();await f.service.close();gate.resolve();await start;assert.equal(f.removed.length,1);assert.equal(f.discovery.started,undefined);
});
await check('cancelled control probe cannot connect after late socket bind',async()=>{
const f=fixture(),gate=deferred();f.setBindGate(gate);await f.service.start(identity);f.found({host:{address:'192.168.43.2'},port:12345});await tick();f.service.approvePeer('192.168.43.2');await tick();await f.service.close();gate.resolve();await tick();assert.equal(f.clients[0].connected,undefined);assert.equal(f.clients[0].closed,true);
});
await check('hotspot publication suppresses duplicate system registration and routes authenticated control endpoint through hotspot',async()=>{
const f=fixture(true);await f.service.start(identity);assert.equal(f.published.length,0);assert.equal(f.hotspots[0].address,'192.168.43.1');
f.hotspots[0].resolve('192.168.43.2',12345);await tick();assert.equal(f.clients.length,0);
f.service.approvePeer('192.168.43.2');await tick();assert.equal(f.hotspots[0].approved,'192.168.43.2');assert.equal(f.clients.length,1);assert.equal(f.clients[0].binding.address,'192.168.43.1');
await f.service.close();assert.equal(f.hotspots[0].closed,true);f.hotspots[0].resolve('192.168.43.2',54321);await tick();assert.equal(f.clients.length,1);
});
await check('mode diagnostics expose numeric resource ownership only, excluding arbitrary private fields',()=>{
const {Plist:P}=plist,{modeSummary}=load('ModeDiagnostics',{'./Bplist':plist});const command=P.dict(['params'],[P.dict(['resources'],[P.array([P.dict(['resourceID','entity','password','owner'],[P.int(2),P.int(1),P.str('do-not-log'),P.str('secret')])])])]);
assert.equal(modeSummary(command),'resourceID=2,entity=1');assert.ok(!modeSummary(command).includes('secret'));assert.equal(modeSummary(P.dict([],[])),'资源状态未提供');
});
console.log(count+' discovery/diagnostic tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
