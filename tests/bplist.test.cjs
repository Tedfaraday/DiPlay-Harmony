const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),cp=require('node:child_process');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
function load(name,deps={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/../entry/src/main/ets/lab/'+name+'.ts','utf8'),
{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,Uint8Array,DataView,require:id=>deps[id]});return exports;}
const core=load('PairingCore'),{Plist:P,encodePlist,decodePlist}=load('Bplist',{'./PairingCore':core});
const python=process.env.DIPLAY_PYTHON||'python';
function py(code,input){const r=cp.spawnSync(python,['-c',code],{input});if(r.status!==0)throw new Error(r.stderr.toString());return r.stdout;}
let count=0;function check(name,fn){fn();count++;console.log('PASS '+name);}
check('Python plistlib reads ArkTS output including UTF16, uint64, data and nested dictionaries',()=>{
const node=P.dict(['name','streams','raw','enabled','features','negative'],[P.str('鸿蒙 🚗'),P.array([P.dict(['type','streamConnectionID'],[P.int(110),P.int(18446744073709551615n)])]),P.bytes(Uint8Array.of(0,255,1)),P.bool(true),P.int(0x615653aee2),P.int(-1)]);
const encoded=encodePlist(node),result=JSON.parse(py("import plistlib,sys,json; x=plistlib.loads(sys.stdin.buffer.read()); x['raw']=list(x['raw']); print(json.dumps(x))",encoded));
assert.equal(result.name,'鸿蒙 🚗');assert.equal(result.streams[0].type,110);assert.equal(result.enabled,true);assert.deepEqual(result.raw,[0,255,1]);assert.equal(result.features,0x615653aee2);assert.equal(result.negative,-1);
// Check uint64 separately as a decimal string; JSON numbers cannot retain this value.
assert.equal(py("import plistlib,sys;print(plistlib.loads(sys.stdin.buffer.read())['streams'][0]['streamConnectionID'] & ((1<<64)-1))",encoded).toString().trim(),'18446744073709551615');
});
check('ArkTS decodes independent Python SETUP fixture without losing 64-bit connection IDs',()=>{
const bytes=py("import plistlib,sys;sys.stdout.buffer.write(plistlib.dumps({'timingPort':5000,'keepAliveLowPower':True,'name':'测试手机','streams':[{'type':110,'streamConnectionID':18446744073709551615}],'data':b'\\x00\\xff'},fmt=plistlib.FMT_BINARY,sort_keys=False))");
const root=decodePlist(bytes);assert.equal(root.entries.get('timingPort').number(),5000);assert.equal(root.entries.get('name').text,'测试手机');
assert.equal(root.entries.get('streams').items[0].entries.get('streamConnectionID').integer,18446744073709551615n);assert.deepEqual(Array.from(root.entries.get('data').data),[0,255]);
});
check('oversized counts, cyclic references, bad offsets and truncated headers reject',()=>{
assert.throws(()=>decodePlist(Buffer.alloc(40)));const cyclic=P.array([]);cyclic.items.push(cyclic);assert.throws(()=>encodePlist(cyclic),/limit/);
const valid=Buffer.from(encodePlist(P.array([P.int(1)]))),trailer=valid.length-32;
const badCount=Buffer.from(valid);badCount.writeBigUInt64BE(2049n,trailer+8);assert.throws(()=>decodePlist(badCount));
const badOffset=Buffer.from(valid);badOffset.writeBigUInt64BE(BigInt(valid.length),trailer+24);assert.throws(()=>decodePlist(badOffset));
const loop=Buffer.from(valid);loop[9]=0;assert.throws(()=>decodePlist(loop),/reference/);
assert.throws(()=>encodePlist(P.bytes(Buffer.alloc(65536))),/limit/);
});
check('multi-byte reference and offset tables remain interoperable',()=>{
const values=Array.from({length:300},(_,i)=>P.str('item-'+i+'-'.repeat(180))),data=encodePlist(P.array(values));
assert.equal(JSON.parse(py("import plistlib,sys,json;print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))",data)).length,300);
const decoded=decodePlist(data);assert.equal(decoded.items[299].text,values[299].text);
});
console.log(count+' bplist tests passed');
