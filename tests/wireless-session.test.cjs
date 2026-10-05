const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
function load(name,deps={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../entry/src/main/ets/lab',name+'.ts'),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,Uint8Array,require:id=>deps[id]});return exports;}
const control=load('Iap2Control'),wireless=load('WirelessControl',{'./Iap2Control':control}),{RtspProbe}=load('RtspProbe');
const encode=s=>new TextEncoder().encode(s);const settings=new wireless.WirelessSettings('测试热点','test-passphrase','192.168.43.1');
let count=0;function check(name,fn){fn();console.log('PASS '+name);count++;}
check('Wi-Fi credentials use correct TLV IDs and terminated UTF8',()=>{
  const bytes=wireless.wifiConfiguration(settings,encode);assert.equal(bytes[4]*256+bytes[5],0x5703);
  assert.deepEqual(Array.from(control.parameterIds(bytes.slice(6))),[1,2,3,4]);
  assert.equal(new TextDecoder().decode(control.readParameters(bytes.slice(6),1)[0]),'测试热点\0');
  assert.equal(control.readParameters(bytes.slice(6),3)[0][0],2);
});
check('CarPlay start uses port 7000 u32, own public key and nested hotspot address',()=>{
  const body=wireless.startWirelessSession(settings,'AA:BB:CC:DD:EE:FF','ab'.repeat(32),encode).slice(6);
  assert.deepEqual(Array.from(control.readParameters(body,2)[0]),[0,0,27,88]);
  assert.equal(new TextDecoder().decode(control.readParameters(body,3)[0]),'AA:BB:CC:DD:EE:FF\0');
  assert.equal(new TextDecoder().decode(control.readParameters(body,4)[0]),'ab'.repeat(32)+'\0');
  const group=control.readParameters(body,1)[0];
  assert.equal(new TextDecoder().decode(control.readParameters(group,3)[0]),'192.168.43.1\0');
});
check('wireless identity advertises only implemented bootstrap message IDs',()=>{
  const component=wireless.wirelessComponent(settings.ssid,encode);
  const body=control.identification('test',encode,'AA:BB:CC:DD:EE:FF',component).slice(6);
  assert.equal(control.readParameters(body,24).length,1);
  assert.deepEqual(Array.from(control.readParameters(body,6)[0]),[170,1,170,3,87,3,67,1]);
});
check('bad hotspot values and invalid receiver keys are rejected',()=>{
  for(const args of [['','password','192.168.43.1'],['x','short','192.168.43.1'],['x','password','192.168.43.999'],['x','password','192.168.43.1',-1]])assert.throws(()=>new wireless.WirelessSettings(...args));
  assert.throws(()=>wireless.startWirelessSession(settings,'id','fake',encode));
  assert.throws(()=>wireless.startWirelessSession(settings,'12345678-1234-1234-1234-123456789abc','ab'.repeat(32),encode));
});
check('RTSP header and binary body split at every byte boundary',()=>{
  const head=encode('POST /pair-setup HTTP/1.1\r\nContent-Length: 4\r\nCSeq: 7\r\n\r\n');const wire=Uint8Array.from([...head,0,255,1,2]);
  for(let i=0;i<=wire.length;i++){const p=new RtspProbe();const r=[...p.feed(wire.slice(0,i)),...p.feed(wire.slice(i))];
    assert.equal(r.length,1);assert.equal(r[0].path,'/pair-setup');assert.equal(r[0].cseq,'7');}
});
check('RTSP pipelining and malformed content lengths',()=>{
  const p=new RtspProbe();assert.equal(p.feed(encode('OPTIONS * RTSP/1.0\r\nCSeq: 1\r\n\r\nGET /info HTTP/1.1\r\n\r\n')).length,2);
  for(const h of ['Content-Length: -1','Content-Length: 65537','Content-Length: 0\r\nContent-Length: 0','Transfer-Encoding: chunked']){
    assert.throws(()=>new RtspProbe().feed(encode('POST /info HTTP/1.1\r\n'+h+'\r\n\r\n')));}
  assert.throws(()=>new RtspProbe().feed(new Uint8Array(16385).fill(65)));
});
console.log(count+' wireless/session tests passed');
