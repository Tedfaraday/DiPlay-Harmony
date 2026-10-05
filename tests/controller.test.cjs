// Platform mocks exercise the actual ArkTS controller's async cancellation and HTTP.
// These tests do not establish device permissions or hardware interoperability.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require(process.env.DIPLAY_TYPESCRIPT || 'typescript');
function load(relativePath, dependencies) {
  const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const exports = {};
  vm.runInNewContext(compiled.outputText, { exports, require: id => {
    if (!(id in dependencies)) throw new Error(`Unexpected import: ${id}`);
    return dependencies[id];
  }, Uint8Array, Date, setTimeout, clearTimeout, setInterval, clearInterval, console });
  return exports;
}
const iap2 = load('../entry/src/main/ets/lab/Iap2Probe.ts', {});
const link = load('../entry/src/main/ets/lab/Iap2Link.ts', { './Iap2Probe': iap2 });
const control = load('../entry/src/main/ets/lab/Iap2Control.ts', {});
const wireless = load('../entry/src/main/ets/lab/WirelessControl.ts', {'./Iap2Control':control});
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  const servers = [], udps = [], btClosed = [], btWrites = [];
  let btCallback, btRead, sessionEvent, sessionStopped=0;
  class Endpoint {
    handlers = {}; closed = false; sent = []; sends = undefined; bindGate = undefined;
    on(name, handler) { this.handlers[name] = handler; }
    async close() { this.closed = true; this.handlers.close?.(); }
    async listen() { if (this.bindGate) await this.bindGate.promise; this.listening = true; }
    async bind() { if (this.bindGate) await this.bindGate.promise; }
    async send(options) { this.sent.push(options); if (this.sends) await this.sends.promise; }
    emit(name, data) { this.handlers[name]?.(data); }
  }
  const socket = {
    constructTCPSocketServerInstance: () => { const s = new Endpoint(); servers.push(s); return s; },
    constructUDPSocketInstance: () => { const s = new Endpoint(); udps.push(s); return s; }
  };
  const util = {
    generateRandomUUID: () => '12345678-1234-1234-1234-123456789abc',
    TextEncoder: class { encodeInto(text) { return new TextEncoder().encode(text); } },
    TextDecoder: { create: () => ({ decodeToString: bytes => new TextDecoder().decode(bytes) }) }
  };
  const modules = {
    '@kit.PerformanceAnalysisKit':{hilog:{info(){}}},
    '@kit.AbilityKit': { abilityAccessCtrl: { createAtManager: () => ({ requestPermissionsFromUser: async () => ({ authResults: [0] }) }) } },
    '@kit.ConnectivityKit': {
      wifiManager: { on() {}, off() {}, isHotspotActive: () => true },
      connection: { getPairedDevices: () => [], getRemoteDeviceName: () => '' },
      socket: { SppType: { SPP_RFCOMM: 0 }, sppConnect: (_addr, _opt, cb) => { btCallback = cb; },
        sppCloseClientSocket: id => btClosed.push(id), on: (_name, _id, cb) => { btRead = cb; },
        off: () => { btRead = undefined; }, sppWrite: (id, data) => btWrites.push([id, data]) }
    },
    '@kit.NetworkKit': { socket, mdns: { addLocalService: async (_ctx, info) => info, removeLocalService: async () => {} } },
    '@kit.BasicServicesKit': {systemDateTime:{TimeType:{STARTUP:0}, getUptime:()=>100}},
    '@kit.ArkTS': { util }, './Iap2Probe': iap2, './Iap2Link': link, './Iap2Control': control,
    './ExperimentalAuth': { ExperimentalAuth: { load: async () => undefined } },
    './WirelessControl':wireless,'./ReceiverIdentity':{ReceiverIdentity:{load:async()=>({pairingId:'test',publicKeyHex:'ab'.repeat(32)})}},
    './SessionProbeServer':{SessionProbeServer:class {constructor(_report,_ready,event){sessionEvent=event;} async start(){} async stop(){sessionStopped++;}}}
  };
  const { LabController } = load('../entry/src/main/ets/lab/LabController.ets', modules);
  const controller = new LabController();
  return { controller, servers, udps, btClosed, btWrites, Endpoint, modules, sessionEvent:event=>sessionEvent(event), sessionStopped:()=>sessionStopped,
    connected: (error, id) => btCallback(error, id), read: bytes => btRead(Uint8Array.from(bytes).buffer) };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const message = text => ({ message: new TextEncoder().encode(text).buffer, remoteInfo: { address: '192.168.1.2', port: 5555, family: 'IPv4', size: text.length } });
let tests = 0;
async function check(name, fn) { await fn(); tests++; console.log(`PASS ${name}`); }
(async () => {
  await check('fragmented HTTP request returns exact UTF-8 content length', async () => {
    const f = fixture(); await f.controller.startNetwork();
    const client = new f.Endpoint(); f.servers[0].emit('connect', client);
    client.emit('message', message(`GET /${f.controller.state.token} HTTP/1.1\r\nHost: tablet\r\n`));
    assert.equal(client.sent.length, 0);
    client.emit('message', message('\r\n')); await tick();
    const response = client.sent[0].data;
    const split = response.indexOf('\r\n\r\n');
    const headerLength = Number(/Content-Length: (\d+)/.exec(response)[1]);
    assert.equal(Buffer.byteLength(response.substring(split + 4), 'utf8'), headerLength);
    assert.match(response, /^HTTP\/1.1 200 OK/);
    assert.equal(f.controller.state.httpHits, 1);
    assert.equal(client.closed, true); await f.controller.stopNetwork();
  });
  await check('wrong token cannot increment success counters', async () => {
    const f = fixture(); await f.controller.startNetwork();
    const client = new f.Endpoint(); f.servers[0].emit('connect', client);
    client.emit('message', message('GET /wrong HTTP/1.1\r\n\r\n')); await tick();
    assert.match(client.sent[0].data, /^HTTP\/1.1 404 Not Found/);
    assert.equal(f.controller.state.httpHits, 0); await f.controller.stopNetwork();
  });
  await check('late HTTP response after stop cannot change the stopped session', async () => {
    const f = fixture(); await f.controller.startNetwork();
    const client = new f.Endpoint(); client.sends = deferred(); f.servers[0].emit('connect', client);
    client.emit('message', message(`GET /${f.controller.state.token} HTTP/1.1\r\n\r\n`));
    await f.controller.stopNetwork(); client.sends.resolve(); await tick();
    assert.equal(f.controller.state.network, '未启动'); assert.equal(f.controller.state.httpHits, 0);
  });
  await check('UDP rejects incorrect token and oversized datagrams, then echoes valid payload', async () => {
    const f = fixture(); await f.controller.startNetwork(); const udp = f.udps[0];
    udp.emit('message', message('wrong:payload'));
    udp.emit('message', message(`${f.controller.state.token}:${'x'.repeat(1200)}`));
    assert.equal(udp.sent.length, 0);
    const valid = message(`${f.controller.state.token}:ping`); udp.emit('message', valid); await tick();
    assert.equal(udp.sent[0].data, valid.message); assert.equal(f.controller.state.udpHits, 1);
    await f.controller.stopNetwork();
  });
  await check('stop during cleanup cancels pending start before sockets are created', async () => {
    const f = fixture(); const gate = deferred();
    f.controller.attach({}, () => {}); await f.controller.startNetwork();
    f.modules['@kit.NetworkKit'].mdns.removeLocalService = () => gate.promise;
    const starting = f.controller.startNetwork(); await tick();
    await f.controller.stopNetwork(); gate.resolve(); await starting;
    assert.equal(f.servers.length, 1); assert.equal(f.controller.state.network, '未启动');
    f.controller.dispose();
  });
  await check('late Bluetooth connect after cancellation closes returned socket without probing', async () => {
    const f = fixture(); f.controller.connectBluetooth('test'); f.controller.stopBluetooth();
    f.connected(null, 42); assert.deepEqual(f.btClosed, [42]); assert.equal(f.btWrites.length, 0);
    assert.equal(f.controller.state.bluetooth, '已断开');
  });
  await check('negotiation sends SYN after marker and stop clears link timer and buffers', async () => {
    const f = fixture(); f.controller.connectBluetooth('test', true, 'AA:BB:CC:DD:EE:FF'); f.connected(null, 42);
    assert.deepEqual(Array.from(new Uint8Array(f.btWrites[0][1])), Array.from(iap2.IAP2_MARKER));
    f.read(iap2.IAP2_MARKER); assert.equal(new Uint8Array(f.btWrites[1][1])[4], 128);
    assert.match(f.controller.state.bluetooth, /SYN/);
    f.controller.stopBluetooth(); assert.deepEqual(f.btClosed,[42]);
    assert.equal(f.controller.link, undefined); assert.equal(f.controller.linkTimer,-1);
  });
  await check('late authentication signature after stop cannot write to closed socket', async () => {
    const f=fixture();f.controller.connectBluetooth('test',true,'AA:BB:CC:DD:EE:FF');f.connected(null,42);
    const gate=deferred();f.controller.authentication=Promise.resolve({sign:()=>gate.promise});
    const current=f.controller.link, generation=f.controller.bluetoothGeneration;
    const pending=f.controller.answerControl(0xaa02,control.parameter(0,new Uint8Array(32)),generation,current);
    await tick();const writes=f.btWrites.length;f.controller.stopBluetooth();gate.resolve(new Uint8Array(64));await pending;
    assert.equal(f.btWrites.length,writes);assert.equal(f.controller.link,undefined);
  });
  await check('malformed local Bluetooth address does not attempt an invalid identity', async()=>{
    const f=fixture();f.controller.connectBluetooth('test',true,'wrong');
    assert.equal(f.btWrites.length,0);assert.equal(f.controller.link,undefined);
    assert.match(f.controller.state.logs.at(-1),/格式无效/);
  });
  await check('stop during receiver identity loading cancels wireless preparation', async()=>{
    const f=fixture();f.controller.attach({},()=>{});const gate=deferred();
    f.modules['./ReceiverIdentity'].ReceiverIdentity.load=()=>gate.promise;
    const pending=f.controller.startWireless('test','AA:BB:CC:DD:EE:FF',new wireless.WirelessSettings('test','password','192.168.43.1'));
    f.controller.stopBluetooth();gate.resolve({pairingId:'test',publicKeyHex:'ab'.repeat(32)});await pending;
    assert.equal(f.controller.link,undefined);assert.equal(f.btWrites.length,0);
    f.controller.dispose();
  });
  await check('hotspot credentials cannot be sent before authentication',async()=>{
    const f=fixture();f.controller.connectBluetooth('test',true,'AA:BB:CC:DD:EE:FF');f.connected(null,42);
    f.controller.wirelessSettings=new wireless.WirelessSettings('test','password','192.168.43.1');
    f.controller.receiverIdentity={pairingId:'test',publicKeyHex:'ab'.repeat(32)};
    const writes=f.btWrites.length;
    await f.controller.answerControl(0x5702,new Uint8Array(0),f.controller.bluetoothGeneration,f.controller.link);
    assert.equal(f.btWrites.length,writes);assert.equal(f.controller.wifiSent,0);f.controller.stopBluetooth();
  });
  await check('authenticated session bootstrap uses receiver MAC rather than pairing UUID',async()=>{
    const f=fixture(),sent=[],mac='AA:BB:CC:DD:EE:FF';
    f.controller.localBluetoothAddress=mac;
    f.controller.wirelessSettings=new wireless.WirelessSettings('test','password','192.168.43.1');
    f.controller.receiverIdentity={pairingId:'12345678-1234-1234-1234-123456789abc',publicKeyHex:'ab'.repeat(32)};
    f.controller.authenticated=true;
    const sessionLink={sendControl:bytes=>sent.push(bytes),takeOutput:()=>[]};f.controller.link=sessionLink;
    await f.controller.answerControl(0x4300,new Uint8Array(0),f.controller.bluetoothGeneration,sessionLink);
    assert.equal(sent.length,1);
    const body=sent[0].slice(6);
    assert.equal(new TextDecoder().decode(control.readParameters(body,3)[0]),mac+'\0');
    assert.equal(new TextDecoder().decode(control.readParameters(body,4)[0]),'ab'.repeat(32)+'\0');
    f.controller.stopBluetooth();
  });
  await check('connection only becomes connected after native first-frame output',async()=>{
    const f=fixture();f.controller.attach({},()=>{});
    await f.controller.startWireless('10:20:30:40:50:60','AA:BB:CC:DD:EE:FF',new wireless.WirelessSettings('test','password','192.168.43.1'));
    assert.equal(f.controller.state.phase,'connecting');assert.equal(f.controller.state.connectedAt,0);
    f.sessionEvent('paired');assert.equal(f.controller.state.phase,'negotiating');
    f.sessionEvent('streaming');assert.equal(f.controller.state.phase,'connected');assert.ok(f.controller.state.connectedAt>0);
    assert.equal(f.controller.connectionTimer,-1);f.sessionEvent('ended');assert.equal(f.controller.state.phase,'disconnected');
    assert.equal(f.controller.state.connectedAt,0);f.controller.dispose();
  });
  await check('manual disconnect cancels timeout and cannot be revived by late media events',async()=>{
    const f=fixture();f.controller.attach({},()=>{});
    await f.controller.startWireless('10:20:30:40:50:60','AA:BB:CC:DD:EE:FF',new wireless.WirelessSettings('test','password','192.168.43.1'));
    f.controller.stopTests('用户断开连接');f.sessionEvent('paired');f.sessionEvent('streaming');f.sessionEvent('ended');
    assert.equal(f.controller.state.phase,'idle');assert.equal(f.controller.state.connectedAt,0);assert.equal(f.controller.connectionTimer,-1);
    assert.equal(f.controller.state.connectionError,'');f.controller.dispose();
  });
  await check('Bluetooth startup failure closes waiting media server and exposes actionable state',async()=>{
    const f=fixture();f.controller.attach({},()=>{});
    await f.controller.startWireless('10:20:30:40:50:60','AA:BB:CC:DD:EE:FF',new wireless.WirelessSettings('test','password','192.168.43.1'));
    const stops=f.sessionStopped();f.connected({code:1,message:'synthetic failure'},-1);
    assert.equal(f.controller.state.phase,'error');assert.equal(f.controller.connectionTimer,-1);assert.ok(f.sessionStopped()>stops);
    f.sessionEvent('streaming');assert.equal(f.controller.state.phase,'error');assert.match(f.controller.state.connectionError,/蓝牙配对/);f.controller.dispose();
  });
  console.log(`${tests} controller tests passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
