const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
function load(name,deps={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/../entry/src/main/ets/lab/'+name+'.ts','utf8'),
{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,Uint8Array,require:id=>deps[id]});return exports;}
const core=load('PairingCore'),{mfiSap}=load('MfiSap',{'./PairingCore':core});
const raw=pair=>pair.publicKey.export({format:'der',type:'spki'}).subarray(-32);
const pub=raw=>crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b656e032100','hex'),Buffer.from(raw)]),format:'der',type:'spki'});
const digest=(name,parts)=>crypto.createHash(name.toLowerCase()).update(Buffer.concat(parts)).digest();
let count=0;async function check(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
await check('MFiSAP v3 response matches independent X25519/AES client and signs both public keys',async()=>{
const phone=crypto.generateKeyPairSync('x25519'),own=crypto.generateKeyPairSync('x25519'),signature=crypto.randomBytes(64),certificate=crypto.randomBytes(607);let challenge;
const native={exchange:async k=>({publicKey:raw(own),shared:crypto.diffieHellman({privateKey:own.privateKey,publicKey:pub(k)})}),digest:async(...a)=>digest(...a),
aesCtr:async(k,iv,d)=>{const c=crypto.createCipheriv('aes-128-ctr',k,iv);return Buffer.concat([c.update(d),c.final()]);}};
const result=Buffer.from(await mfiSap(Buffer.concat([Buffer.from([1]),raw(phone)]),native,{certificate,sign:async d=>{challenge=Buffer.from(d);return Buffer.from(signature);}}));
assert.deepEqual(result.subarray(0,32),raw(own));assert.deepEqual(challenge,digest('SHA256',[raw(own),raw(phone)]));
const size=result.readUInt32BE(32);assert.equal(size,607);assert.deepEqual(result.subarray(36,36+size),certificate);assert.equal(result.readUInt32BE(36+size),64);
const shared=crypto.diffieHellman({privateKey:phone.privateKey,publicKey:pub(result.subarray(0,32))}),key=digest('SHA1',[Buffer.from('AES-KEY'),shared]).subarray(0,16),iv=digest('SHA1',[Buffer.from('AES-IV'),shared]).subarray(0,16);
const c=crypto.createDecipheriv('aes-128-ctr',key,iv);assert.deepEqual(Buffer.concat([c.update(result.subarray(40+size)),c.final()]),signature);
});
await check('wrong version, length and all-zero shared secret reject without signing',async()=>{
let signed=0;const native={exchange:async()=>({publicKey:Buffer.alloc(32),shared:Buffer.alloc(32)})},auth={certificate:Buffer.alloc(607),sign:async()=>{signed++;return Buffer.alloc(64);}};
for(const body of [Buffer.alloc(33),Buffer.from([1]),Buffer.concat([Buffer.from([1]),Buffer.alloc(32)])])await assert.rejects(mfiSap(body,native,auth));assert.equal(signed,0);
});
console.log(count+' MFiSAP tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
