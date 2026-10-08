const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
function load(name,deps={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/../entry/src/main/ets/lab/'+name+'.ts','utf8'),
{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,Uint8Array,DataView,require:id=>id==='./DisplayProfile'?load('DisplayProfile'):deps[id]});return exports;}
const codec=load('AudioCodec'),core=load('PairingCore'),plist=load('Bplist',{'./PairingCore':core});
let count=0;async function check(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
await check('capability request diagnostics allowlist fields and qualifiers without echoing secrets',()=>{
 const {Plist:P,encodePlist}=plist,d=load('AudioDiagnostics',{'./AudioCodec':codec,'./Bplist':plist});
 const node=P.dict(['qualifier','deviceID','private-key','features'],[P.array([P.str('audioFormats'),P.str('private-wifi'),P.str('txtAirPlay')]),P.str('AA:BB:CC:DD:EE:FF'),P.bytes(new Uint8Array(32)),P.int(123)]);
 assert.equal(d.capabilityRequestSummary(encodePlist(node)),'keys=qualifier|features,qualifier=audioFormats|txtAirPlay');
 assert.equal(d.capabilityRequestSummary(new Uint8Array(0)),'body=empty');assert.equal(d.capabilityRequestSummary(Uint8Array.of(1)),'body=unparsed');
 assert.equal(d.capabilityRequestSummary(encodePlist(P.array([]))),'body=non-dict');
});
await check('audio command diagnostics distinguish known commands but never expose payload text',()=>{
 const {Plist:P}=plist,d=load('AudioDiagnostics',{'./AudioCodec':codec,'./Bplist':plist});
 for(const name of ['setUpStreams','tearDownStreams','duckAudio','unduckAudio','flushAudio','setAudioVolume'])assert.equal(d.airPlayCommandName(P.dict(['type'],[P.str(name)])),name);
 assert.equal(d.airPlayCommandName(P.dict(['type'],[P.str('private-phone')])),'其他命令');
 const command=P.dict(['params'],[P.dict(['streams','audioType','data','password'],[P.array([P.dict(['type'],[P.int(102)]),P.dict(['type'],[P.int(999)])]),P.str('private'),P.bytes(new Uint8Array(32)),P.str('secret')])]);
 assert.equal(d.audioCommandSummary(command),'params=streams|audioType|data,streamTypes=102|other');
});
await check('codec-family masks match upstream without guessing ambiguous PCM sample layout',()=>{
 const table=[
  [0x4000,'pcm',48000,1],
  [0x400,'pcm',44100,1],
  [0x800000,'aac',48000,2],
  [0x400000,'aac',44100,2],
  [0x40000000,'opus',48000,1],
  [0x70000000,'opus',48000,1],
  [0xc00000,'aac',48000,2],
 ];
 for(const [bits,codecName,rate,channels] of table){
  const format=codec.pcmFormat(bits);
  assert.equal(`${format.codec}/${format.rate}/${format.channels}`,`${codecName}/${rate}/${channels}`,`bits=0x${bits.toString(16)}`);
 }
});
await check('single-bit behaviour is unchanged and unusable masks are still rejected',()=>{
 for(const [bits,rate,channels] of [[4,8000,1],[8,8000,2],[16,16000,1],[32,16000,2],[64,24000,1],[128,24000,2],
  [256,32000,1],[512,32000,2],[1024,44100,1],[2048,44100,2],[16384,48000,1],[32768,48000,2]]){
  const format=codec.pcmFormat(bits);assert.equal(`${format.rate}/${format.channels}`,`${rate}/${channels}`,`single bit ${bits}`);
 }
 for(const bits of [0x10000000,0x20000000,0x40000000]){
  const format=codec.pcmFormat(bits);assert.equal(format.codec,'opus');assert.equal(format.rate,48000);assert.equal(format.channels,1);
 }
 for(const bits of [0xc3fc,0x4154,0x4554,0x3fc,0x154,0x7000c3fc,0x800004,0,1,-1,0x100000004,NaN,4.5]){
  assert.throws(()=>codec.pcmFormat(bits));
 }
});
await check('declaration containment refuses bits the accessory never advertised',()=>{
 assert.equal(codec.pcmBitsAvailable(0x4154,0xc3fc),true);
 assert.equal(codec.pcmBitsAvailable(0x4154,0x4154),true);
 assert.equal(codec.pcmBitsAvailable(0x4000,0x4554),true);
 assert.equal(codec.pcmBitsAvailable(0x1000,0xc3fc),false);
 assert.equal(codec.pcmBitsAvailable(0x800000,0xc3fc),false);
 assert.equal(codec.pcmBitsAvailable(0x4154,0),false);
});
await check('diagnostic tokens are bounded and never echo sender text',()=>{
 const node=plist.Plist.dict(['type','audioType','audioFormat','dataPort','shk'],[plist.Plist.int(100),plist.Plist.str('private phone'),plist.Plist.int(0xc3fc),plist.Plist.int(41000),plist.Plist.str('private ssid')]);
 const diagnostics=load('AudioDiagnostics',{'./AudioCodec':codec}),summary=diagnostics.audioSetupSummary(node);
 assert.match(summary,/bitsDeclared=/);assert.match(summary,/selected=rejected/);
 assert.doesNotMatch(summary,/private|shk/);
 const unsupported=plist.Plist.dict(['type','audioType','audioFormat'],[plist.Plist.int(100),plist.Plist.str('media'),plist.Plist.int(0x7000c3fc)]);
 assert.match(diagnostics.audioSetupSummary(unsupported),/selected=rejected/);
});
await check('declared audio table stays the single source for /info in every microphone state',()=>{
 const receiver=load('ReceiverInfo',{'./Bplist':plist});
 for(const [opus,microphone] of [[false,0],[true,0],[true,0x4154]]){
  const table=receiver.declaredAudioFormats(opus,microphone);
  const info=receiver.receiverInfo('00:00:00:00:00:00',opus,undefined,microphone);
  const formats=info.entries.get('audioFormats').items;
  assert.equal(formats.length,table.length);
  assert.equal(formats.length,9);
  for(let i=0;i<table.length;i++){
   assert.equal(formats[i].entries.get('type').number(),table[i].type);
   assert.equal(formats[i].entries.get('audioType').text,table[i].audioType);
   assert.equal(formats[i].entries.get('audioOutputFormats').number(),table[i].output);
   assert.equal(formats[i].entries.has('audioInputFormats'),table[i].input!==0);
   if(table[i].input!==0){assert.equal(formats[i].entries.get('audioInputFormats').number(),table[i].input);}
  }
  assert.equal(info.entries.get('audioLatencies').items.length,11);
 }
 // Preserve the previously advertised camel-case wire token; normalize only when matching requests.
 const on=receiver.declaredAudioFormats(true,0x4154).filter(e=>e.input!==0).map(e=>`${e.type}/${e.audioType}`);
 assert.equal(JSON.stringify(on),JSON.stringify(['100/compatibility','100/default','100/telephony','100/speechRecognition']));
 for(const [opus,mic] of [[false,0],[true,0],[false,0x4154],[true,0x4154]]){
  const table=receiver.declaredAudioFormats(opus,mic);
  const names=['compatibility','default','alert','media','telephony','speechRecognition','compatibility','default'];
  for(let i=0;i<8;i++){
   const type=i<6?100:101,name=names[i],duplex=type===100&&['compatibility','default','telephony','speechRecognition'].includes(name)&&mic!==0;
   const wireless=!duplex&&opus&&['default','alert','telephony','speechRecognition'].includes(name)?0x70000000:0;
   assert.equal(table[i].audioType,name);assert.equal(table[i].type,type);
   assert.equal(table[i].output,(duplex?mic:['telephony','speechRecognition'].includes(name)?0x4154:0xc3fc)|wireless);
   assert.equal(table[i].input,duplex?mic:0);
  }
 }
});
await check('encoded audio latency entries include upstream zero input latency without changing output buffer declaration',()=>{
 const receiver=load('ReceiverInfo',{'./Bplist':plist});
 for(const opus of [false,true])for(const mic of [0,0x4154]){
  const info=plist.decodePlist(plist.encodePlist(receiver.receiverInfo('00:00:00:00:00:00',opus,undefined,mic)));
  const latencies=info.entries.get('audioLatencies').items;assert.equal(latencies.length,11);
  for(const entry of latencies){assert.equal(entry.entries.get('inputLatencyMicros').number(),0);assert.equal(entry.entries.get('outputLatencyMicros').number(),30000);}
  assert.ok(latencies.some(e=>e.entries.get('audioType')?.text==='speechRecognition'));
 }
});
console.log(count+' audio format negotiation tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
