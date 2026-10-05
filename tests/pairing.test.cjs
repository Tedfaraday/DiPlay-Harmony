const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
const exportsCore={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/../entry/src/main/ets/lab/PairingCore.ts','utf8'),
 {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:exportsCore,Uint8Array});
const {PairSetup,tlvDecode,tlvEncode,TlvItem,SRP_N}=exportsCore;
const H=(...parts)=>crypto.createHash('sha512').update(Buffer.concat(parts.map(x=>Buffer.from(x)))).digest();
const HK=(key,salt,info)=>Buffer.from(crypto.hkdfSync('sha512',key,Buffer.from(salt),Buffer.from(info),32));
const integer=bytes=>BigInt('0x'+Buffer.from(bytes).toString('hex'));
function bytes(n,pad=false){let h=n.toString(16);if(h.length%2)h='0'+h;return Buffer.from(pad?h.padStart(768,'0'):h,'hex');}
function power(n,e,m){let result=1n;for(const bit of e.toString(2)){result=result*result%m;if(bit==='1')result=result*n%m;}return result;}
const nonce=label=>Buffer.concat([Buffer.alloc(4),Buffer.from(label)]);
function seal(key,iv,data){const c=crypto.createCipheriv('chacha20-poly1305',key,iv,{authTagLength:16});return Buffer.concat([c.update(data),c.final(),c.getAuthTag()]);}
function open(key,iv,data){const c=crypto.createDecipheriv('chacha20-poly1305',key,iv,{authTagLength:16});c.setAuthTag(data.slice(-16));return Buffer.concat([c.update(data.slice(0,-16)),c.final()]);}
function raw(pair){return pair.publicKey.export({type:'spki',format:'der'}).subarray(-32);}
function publicObject(key){return crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key]),type:'spki',format:'der'});}
function wire(items){return tlvEncode(items.map(([type,value])=>new TlvItem(type,new Uint8Array(value))));}
function fixture(){const own=crypto.generateKeyPairSync('ed25519'),saved=[];
 const native={random:n=>crypto.randomBytes(n),sha512:async p=>H(...p),hkdf:async(k,s,i)=>HK(k,s,i),
 sign:async d=>crypto.sign(null,d,own.privateKey),verify:async(k,d,s)=>crypto.verify(null,d,publicObject(Buffer.from(k)),s),seal:async(...a)=>seal(...a),open:async(...a)=>open(...a)};
 return{server:new PairSetup(native,'accessory-test-id',raw(own),async(id,key)=>saved.push({id:Buffer.from(id),key:Buffer.from(key)})),own,saved};}
async function prove(f){const m2=tlvDecode(await f.server.handle(wire([[6,[1]],[0,[0]]]))),salt=Buffer.from(m2.get(2)),B=Buffer.from(m2.get(3));
 // Independent client uses the standard MODP-3072 group supplied by OpenSSL.
 const N=integer(crypto.getDiffieHellman('modp15').getPrime()),g=5n,a=integer(crypto.randomBytes(32)),A=bytes(power(g,a,N),true);
 assert.equal(N,SRP_N);const x=integer(H(salt,H(Buffer.from('Pair-Setup:3939')))),k=integer(H(bytes(N),bytes(g,true))),u=integer(H(A,B));
 const base=(integer(B)-k*power(g,x,N)%N+N)%N,K=H(bytes(power(base,a+u*x,N)));
 const hn=H(bytes(N)),hg=H(bytes(g));for(let i=0;i<hn.length;i++)hn[i]^=hg[i];
 const M=H(hn,H(Buffer.from('Pair-Setup')),salt,A,B,K),m4=tlvDecode(await f.server.handle(wire([[6,[3]],[3,A],[4,M]])));
 assert.equal(m4.has(7),false,f.server.lastError);assert.deepEqual(Buffer.from(m4.get(4)),H(A,M,K));return K;}
let count=0;async function check(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
await check('SRP client and server agree; encrypted M5/M6 signatures bind identities',async()=>{
 const f=fixture(),K=await prove(f),phone=crypto.generateKeyPairSync('ed25519'),id=Buffer.from('controller-test-id'),pub=raw(phone),key=HK(K,'Pair-Setup-Encrypt-Salt','Pair-Setup-Encrypt-Info');
 const signature=crypto.sign(null,Buffer.concat([HK(K,'Pair-Setup-Controller-Sign-Salt','Pair-Setup-Controller-Sign-Info'),id,pub]),phone.privateKey);
 const m6=tlvDecode(await f.server.handle(wire([[6,[5]],[5,seal(key,nonce('PS-Msg05'),wire([[1,id],[3,pub],[10,signature]]))]])));
 assert.equal(f.server.complete,true,f.server.lastError);assert.equal(f.saved.length,1);assert.deepEqual(f.saved[0],{id,key:pub});
 const sub=tlvDecode(open(key,nonce('PS-Msg06'),Buffer.from(m6.get(5))));assert.equal(Buffer.from(sub.get(1)).toString(),'accessory-test-id');
 assert.ok(crypto.verify(null,Buffer.concat([HK(K,'Pair-Setup-Accessory-Sign-Salt','Pair-Setup-Accessory-Sign-Info'),Buffer.from(sub.get(1)),Buffer.from(sub.get(3))]),f.own.publicKey,sub.get(10)));
});
await check('zero SRP public value and wrong state do not store a pairing',async()=>{
 for(const body of [wire([[6,[3]],[3,Buffer.alloc(384)],[4,Buffer.alloc(64)]]),wire([[6,[5]],[5,Buffer.alloc(32)]])]){
 const f=fixture();await f.server.handle(wire([[6,[1]]]));const reply=tlvDecode(await f.server.handle(body));assert.equal(reply.get(7)[0],2);assert.equal(f.saved.length,0);assert.equal(f.server.complete,false);}
});
await check('tampered encrypted controller identity is rejected without persistence',async()=>{
 const f=fixture(),K=await prove(f),key=HK(K,'Pair-Setup-Encrypt-Salt','Pair-Setup-Encrypt-Info');const encrypted=seal(key,nonce('PS-Msg05'),wire([[1,Buffer.from('id')],[3,Buffer.alloc(32)],[10,Buffer.alloc(64)]]));encrypted[encrypted.length-1]^=1;
 const reply=tlvDecode(await f.server.handle(wire([[6,[5]],[5,encrypted]])));assert.equal(reply.get(7)[0],2);assert.equal(f.saved.length,0);
});
await check('valid encryption with invalid Ed25519 signature cannot pair',async()=>{
 const f=fixture(),K=await prove(f),phone=crypto.generateKeyPairSync('ed25519'),key=HK(K,'Pair-Setup-Encrypt-Salt','Pair-Setup-Encrypt-Info');
 const encrypted=seal(key,nonce('PS-Msg05'),wire([[1,Buffer.from('id')],[3,raw(phone)],[10,Buffer.alloc(64)]]));
 const reply=tlvDecode(await f.server.handle(wire([[6,[5]],[5,encrypted]])));assert.equal(reply.get(7)[0],2);assert.match(f.server.lastError,/signature/);assert.equal(f.saved.length,0);
});
await check('fragmented TLV8 public key roundtrips and duplicate/truncated parameters reject',()=>{
 const key=crypto.randomBytes(384);assert.deepEqual(Buffer.from(tlvDecode(wire([[3,key]])).get(3)),key);
 for(const malformed of [Uint8Array.of(3,2,0),Uint8Array.of(6,1,1,6,1,1),Uint8Array.of(255,1,0)])assert.throws(()=>tlvDecode(malformed));
});
console.log(count+' pairing tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
