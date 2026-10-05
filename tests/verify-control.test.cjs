const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
function load(name,deps={}){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/../entry/src/main/ets/lab/'+name+'.ts','utf8'),
{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports,Uint8Array,require:id=>deps[id]});return exports;}
const core=load('PairingCore'),{PairVerify,KeyExchange}=load('PairVerify',{'./PairingCore':core}),{ControlCipher}=load('ControlCipher',{'./PairingCore':core});
const HK=(k,s,i)=>Buffer.from(crypto.hkdfSync('sha512',k,Buffer.from(s),Buffer.from(i),32));
const raw=p=>p.publicKey.export({format:'der',type:'spki'}).subarray(-32);
const pub=(k,oid)=>crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b65'+oid+'032100','hex'),Buffer.from(k)]),format:'der',type:'spki'});
const label=s=>Buffer.concat([Buffer.alloc(4),Buffer.from(s)]);
function seal(k,n,d,aad=Buffer.alloc(0)){const c=crypto.createCipheriv('chacha20-poly1305',k,n,{authTagLength:16});c.setAAD(aad);return Buffer.concat([c.update(d),c.final(),c.getAuthTag()]);}
function open(k,n,d,aad=Buffer.alloc(0)){const c=crypto.createDecipheriv('chacha20-poly1305',k,n,{authTagLength:16});c.setAAD(aad);c.setAuthTag(d.slice(-16));return Buffer.concat([c.update(d.slice(0,-16)),c.final()]);}
function wire(items){return core.tlvEncode(items.map(([t,v])=>new core.TlvItem(t,new Uint8Array(v))));}
function fixture(known=true){const own=crypto.generateKeyPairSync('ed25519'),controller=crypto.generateKeyPairSync('ed25519'),client=crypto.generateKeyPairSync('x25519');
const native={random:n=>crypto.randomBytes(n),sha512:async p=>crypto.createHash('sha512').update(Buffer.concat(p)).digest(),hkdf:async(k,s,i)=>HK(k,s,i),
sign:async d=>crypto.sign(null,d,own.privateKey),verify:async(k,d,s)=>crypto.verify(null,d,pub(k,'70'),s),seal:async(...a)=>seal(...a),open:async(...a)=>open(...a),
exchange:async key=>{const ownX=crypto.generateKeyPairSync('x25519');return new KeyExchange(raw(ownX),crypto.diffieHellman({privateKey:ownX.privateKey,publicKey:pub(key,'6e')}));}};
return{native,own,controller,client,server:new PairVerify(native,'accessory-id',async id=>known&&Buffer.from(id).toString()==='phone-id'?raw(controller):undefined)};}
async function m1(f){const reply=core.tlvDecode(await f.server.handle(wire([[6,[1]],[3,raw(f.client)]])));assert.equal(reply.has(7),false,f.server.lastError);
const ownX=Buffer.from(reply.get(3)),shared=crypto.diffieHellman({privateKey:f.client.privateKey,publicKey:pub(ownX,'6e')}),key=HK(shared,'Pair-Verify-Encrypt-Salt','Pair-Verify-Encrypt-Info');
const sub=core.tlvDecode(open(key,label('PV-Msg02'),Buffer.from(reply.get(5))));assert.equal(Buffer.from(sub.get(1)).toString(),'accessory-id');
assert.ok(crypto.verify(null,Buffer.concat([ownX,Buffer.from(sub.get(1)),raw(f.client)]),f.own.publicKey,sub.get(10)));return{ownX,shared,key};}
async function m3(f,r,signature){const id=Buffer.from('phone-id');signature??=crypto.sign(null,Buffer.concat([raw(f.client),id,r.ownX]),f.controller.privateKey);
return core.tlvDecode(await f.server.handle(wire([[6,[3]],[5,seal(r.key,label('PV-Msg03'),wire([[1,id],[10,signature]]))]])));}
let count=0;async function check(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
await check('independent X25519 client verifies accessory; controller verification yields directional keys',async()=>{
const f=fixture(),r=await m1(f),reply=await m3(f,r);assert.equal(reply.get(6)[0],4);assert.equal(f.server.verified,true,f.server.lastError);
assert.deepEqual(Buffer.from(f.server.keys.readKey),HK(r.shared,'Control-Salt','Control-Write-Encryption-Key'));
assert.deepEqual(Buffer.from(f.server.keys.writeKey),HK(r.shared,'Control-Salt','Control-Read-Encryption-Key'));f.server.dispose();assert.equal(f.server.keys,undefined);
});
await check('unknown controller and invalid signature cannot obtain control keys',async()=>{
for(const known of [true,false]){const f=fixture(known),r=await m1(f),reply=await m3(f,r,known?Buffer.alloc(64):undefined);
assert.equal(reply.get(7)[0],2);assert.equal(f.server.keys,undefined);assert.equal(f.server.verified,false);}
});
await check('invalid verification sequence and low-order X25519 point reject',async()=>{
for(const body of [wire([[6,[3]],[5,Buffer.alloc(32)]]),wire([[6,[1]],[3,Buffer.alloc(32)]])]){const f=fixture();const r=core.tlvDecode(await f.server.handle(body));assert.equal(r.get(7)[0],2);assert.equal(f.server.keys,undefined);}
});
await check('control records authenticate length, preserve fragmented payload and increment nonces',async()=>{
const f=fixture(),read=crypto.randomBytes(32),write=crypto.randomBytes(32),channel=new ControlCipher(f.native,read,write),data=crypto.randomBytes(40000),encrypted=Buffer.from(await channel.seal(data));
let off=0,counter=0n,out=[];while(off<encrypted.length){const len=encrypted.readUInt16LE(off),n=Buffer.alloc(12);n.writeBigUInt64LE(counter++,4);out.push(open(write,n,encrypted.subarray(off+2,off+2+len+16),encrypted.subarray(off,off+2)));off+=len+18;}
assert.deepEqual(Buffer.concat(out),data);assert.equal(counter,3n);
const incoming=[];for(let i=0;i<2;i++){const plain=Buffer.from('request-'+i),head=Buffer.alloc(2);head.writeUInt16LE(plain.length);const n=Buffer.alloc(12);n.writeBigUInt64LE(BigInt(i),4);incoming.push(head,seal(read,n,plain,head));}
const wireBytes=Buffer.concat(incoming),chunks=[];for(let i=0;i<wireBytes.length;i++)chunks.push(Buffer.from(await channel.feed(wireBytes.subarray(i,i+1))));
assert.equal(Buffer.concat(chunks).toString(),'request-0request-1');channel.dispose();await assert.rejects(channel.seal(Buffer.alloc(1)),/closed/);
});
await check('tampered encrypted record closes channel and replayed nonce rejects',async()=>{
const f=fixture(),key=crypto.randomBytes(32),head=Buffer.from([3,0]),frame=Buffer.concat([head,seal(key,Buffer.alloc(12),Buffer.from('abc'),head)]);
const c=new ControlCipher(f.native,key,key);assert.equal(Buffer.from(await c.feed(frame)).toString(),'abc');await assert.rejects(c.feed(frame),/authentication/);await assert.rejects(c.feed(frame),/closed/);
const d=new ControlCipher(f.native,key,key),bad=Buffer.from(frame);bad[bad.length-1]^=1;await assert.rejects(d.feed(bad),/authentication/);
});
console.log(count+' verify/control tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
