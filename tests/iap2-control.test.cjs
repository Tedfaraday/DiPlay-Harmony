const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ts=require(process.env.DIPLAY_TYPESCRIPT || 'typescript');
const exportsObject={};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../entry/src/main/ets/lab/Iap2Control.ts'),'utf8'),
  {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:exportsObject,Uint8Array});
const {parameter,controlMessage,parameterIds,readParameters,identification,ecdsaDerToRaw}=exportsObject;
let count=0;function check(name,fn){fn();count++;console.log('PASS '+name);}
check('CSM and parameter lengths are big-endian and include headers',()=>{
  const p=parameter(0,Uint8Array.of(1,2));assert.deepEqual(Array.from(p),[0,6,0,0,1,2]);
  assert.deepEqual(Array.from(controlMessage(0xaa03,[p])),[64,64,0,12,170,3,0,6,0,0,1,2]);
});
check('iAP diagnostics decode only known availability and transport presence, without identifiers',()=>{
 const d=new exportsObject.IapControlDiagnostics(),body=controlMessage(0,[parameter(0,Uint8Array.of(1))]).slice(6);
 assert.equal(d.observe(0x4e0d,body),'id=0x4e0d,wirelessUpdate=yes');assert.equal(d.observe(0x4e0d,body),'');
 assert.match(d.observe(0x4e0d,parameter(0,Uint8Array.of(0))),/wirelessUpdate=no/);
 const nested=parameter(1,controlMessage(0,[parameter(0,Uint8Array.of(1)),parameter(1,new TextEncoder().encode('secret-device'))]).slice(6));
 assert.equal(d.observe(0x4300,nested),'id=0x4300,wired=absent,wireless=yes,themeAssets=absent');
 const transport=controlMessage(0,[parameter(0,new TextEncoder().encode('AA:BB:CC:DD:EE:FF')),parameter(1,new TextEncoder().encode('private-serial'))]).slice(6);
 assert.equal(d.observe(0x4e0e,transport),'id=0x4e0e,transportBluetoothPresent=yes,transportUsbPresent=yes');
 assert.equal(d.observe(0x5001,new TextEncoder().encode('secret-song')),'id=0x5001,unhandled,bytes=11');
});
check('iAP observations cannot throw on malformed TLVs and stop at a fixed report bound',()=>{
 const d=new exportsObject.IapControlDiagnostics();assert.match(d.observe(0x4e0d,Uint8Array.of(0)),/invalidDiagnosticFields/);
 assert.match(d.observe(0x4e0d,parameter(0,Uint8Array.of(2))),/invalid/);
 assert.equal(d.observe(-1,new Uint8Array(0)),'');assert.equal(d.observe(65536,new Uint8Array(0)),'');
 const bounded=new exportsObject.IapControlDiagnostics();for(let i=0;i<24;i++)assert.ok(bounded.observe(0x6000+i,new Uint8Array(0)));
 assert.equal(bounded.observe(0x6100,new Uint8Array(0)),'');
});
check('required identification fields use terminated UTF8 and supported message IDs',()=>{
  const bytes=identification('test-serial',s=>new TextEncoder().encode(s));
  assert.equal(bytes.length,bytes[2]*256+bytes[3]);const body=bytes.slice(6);
  for(const id of [0,1,2,3,4,5,12,13]){const fields=readParameters(body,id);assert.equal(fields.length,1);assert.equal(fields[0].at(-1),0);}
  assert.deepEqual(Array.from(readParameters(body,6)[0]),[170,1,170,3]);
  assert.deepEqual(Array.from(readParameters(body,7)[0]),[170,0,170,2,170,4,170,5]);
});
check('TLV parser rejects truncated, zero, short, and overlong parameters',()=>{
  for(const bytes of [[0],[0,0,0,0],[0,3,0,0],[0,5,0,0]])assert.throws(()=>readParameters(Uint8Array.from(bytes),0));
});
check('wireless identity field 17 includes exactly the configured local address',()=>{
  const bytes=identification('test',s=>new TextEncoder().encode(s),'12:34:56:78:9A:BC');
  const group=readParameters(bytes.slice(6),17)[0];
  assert.deepEqual(Array.from(readParameters(group,3)[0]),[18,52,86,120,154,188]);
  assert.deepEqual(Array.from(parameterIds(group)),[0,1,2,3,4,5]);
  assert.throws(()=>identification('test',s=>new TextEncoder().encode(s),'wrong'));
  assert.deepEqual(Array.from(parameterIds(Uint8Array.of(0,4,0,17))),[17]);
});
check('P256 DER conversion agrees with independent native Node verifier',()=>{
  const pair=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});const data=crypto.randomBytes(32);
  for(let i=0;i<32;i++){const der=crypto.sign('sha256',data,pair.privateKey);const raw=ecdsaDerToRaw(der);
    assert.equal(raw.length,64);assert.equal(crypto.verify('sha256',data,{key:pair.publicKey,dsaEncoding:'ieee-p1363'},raw),true);}
});
check('DER converter rejects negative, noncanonical, oversized and zero integers',()=>{
  for(const bytes of [[48,6,2,1,128,2,1,1],[48,7,2,2,0,1,2,1,1],[48,6,2,1,0,2,1,1],
    [48,6,2,1,1,2,1,1,0]])assert.throws(()=>ecdsaDerToRaw(Uint8Array.from(bytes)));
});
console.log(count+' control tests passed');
