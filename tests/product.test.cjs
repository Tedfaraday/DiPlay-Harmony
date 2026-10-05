// Synthetic configuration only: never read real device preferences or the asset vault.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
function load(name,deps={},ext='.ts'){
  const exports={};const source=fs.readFileSync(__dirname+'/../entry/src/main/ets/product/'+name+ext,'utf8');
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,
    {exports,Uint8Array,Map,Date,require:id=>{if(!(id in deps))throw Error('Unexpected import '+id);return deps[id];}});return exports;
}
const profiles=load('ConnectionProfile'),{ReconnectPolicy}=load('ReconnectPolicy'),{diagnosticReport}=load('Diagnostics');
function valid(){const p=new profiles.ConnectionProfile();Object.assign(p,{ssid:'test-hotspot',gateway:'192.168.43.1',localMac:'AA:BB:CC:DD:EE:FF',phoneAddress:'10:20:30:40:50:60',phoneName:'Test phone'});return p;}
function vaultFixture(){
  let saved,addFail=false,removeFail=false,gate;const puts=[],ops=[],buffers=[];const disk=new Map();
  const Tag={ALIAS:1,SECRET:2,RETURN_TYPE:3,ACCESSIBILITY:4,SYNC_TYPE:5,CONFLICT_RESOLUTION:6};
  const asset={Tag,ReturnType:{ALL:0},Accessibility:{DEVICE_UNLOCKED:2},SyncType:{NEVER:0},ConflictResolution:{OVERWRITE:0},
    add:async m=>{ops.push('add');buffers.push(m.get(Tag.SECRET));if(gate)await gate;if(addFail)throw Error('synthetic add failure');saved=new Map(m);saved.set(Tag.SECRET,m.get(Tag.SECRET).slice());},
    remove:async()=>{ops.push('remove');if(removeFail)throw {code:24000003};saved=undefined;},
    query:async()=>{if(!saved)throw {code:24000002};const result=new Map(saved);result.set(Tag.SECRET,saved.get(Tag.SECRET).slice());buffers.push(result.get(Tag.SECRET));return [result];}};
  const pref={get:async(k,f)=>disk.get(k)||f,put:async(k,v)=>{puts.push(v);ops.push('put');disk.set(k,v);},flush:async()=>{ops.push('flush');}};
  const util={TextEncoder:class{encodeInto(s){return new TextEncoder().encode(s);}},TextDecoder:{create:()=>({decodeToString:b=>new TextDecoder().decode(b)})}};
  const {ProfileStore}=load('ProfileStore',{'@kit.ArkData':{preferences:{getPreferences:async()=>pref}},'@kit.AssetStoreKit':{asset},'@kit.ArkTS':{util},'./ConnectionProfile':profiles},'.ets');
  return {ProfileStore,asset,disk,puts,ops,buffers,secret:()=>saved,
    failAdd:v=>{addFail=v;},failRemove:v=>{removeFail=v;},gate:v=>{gate=v;}};
}
let tests=0;async function check(name,fn){await fn();tests++;console.log('PASS '+name);}
const tick=()=>new Promise(r=>setImmediate(r));
(async()=>{
  await check('corrupt or newer profiles reset safely and discard unknown secret fields',()=>{
    for(const bad of ['', 'null','{','{"schema":2,"rememberPassword":true}','x'.repeat(8193)])assert.equal(profiles.decodeProfile(bad).ssid,'');
    const p=profiles.decodeProfile(JSON.stringify({...valid(),password:'synthetic-secret',security:9,channel:-1}));
    assert.equal(p.password,undefined);assert.equal(p.security,2);assert.equal(p.channel,0);assert.equal(p.keepAwake,true);
  });
  await check('connection validation checks addresses, Unicode SSID bytes and password limits',()=>{
    const p=valid();assert.equal(profiles.profileIssue(p,'test-password'),'');
    for(const ip of ['127.0.0.1','0.0.0.0','224.0.0.1','192.168.43.999','192.168.43.255','router']){
      p.gateway=ip;assert.notEqual(profiles.profileIssue(p,'test-password'),'');}
    p.gateway='192.168.43.1';p.ssid='😀'.repeat(8);assert.equal(profiles.profileIssue(p,'test-password'),'');
    p.ssid+='a';assert.notEqual(profiles.profileIssue(p,'test-password'),'');p.ssid='test';
    assert.notEqual(profiles.profileIssue(p,'short'),'');p.channel=NaN;assert.notEqual(profiles.profileIssue(p,'test-password'),'');
    p.channel=0;p.security=0;assert.equal(profiles.profileIssue(p,''),'');
  });
  await check('default save never persists a password and clears a previous vault entry',async()=>{
    const f=vaultFixture(),store=await f.ProfileStore.open({}),p=valid();p.rememberPassword=true;
    await store.save(p,'synthetic-password');assert.ok(f.secret());p.rememberPassword=false;await store.save(p,'synthetic-password');
    assert.equal(f.secret(),undefined);assert.ok(f.puts.every(v=>!v.includes('synthetic-password')));assert.equal((await store.load()).password,'');
  });
  await check('opt-in password uses an unlocked, local-only asset and wipes buffers',async()=>{
    const f=vaultFixture(),store=await f.ProfileStore.open({}),p=valid();p.rememberPassword=true;await store.save(p,'synthetic-password');
    const secret=f.secret();assert.equal(secret.get(f.asset.Tag.ACCESSIBILITY),f.asset.Accessibility.DEVICE_UNLOCKED);
    assert.equal(secret.get(f.asset.Tag.SYNC_TYPE),f.asset.SyncType.NEVER);assert.equal(secret.get(f.asset.Tag.CONFLICT_RESOLUTION),f.asset.ConflictResolution.OVERWRITE);
    const result=await store.load();assert.equal(result.password,'synthetic-password');assert.equal(result.secretUnavailable,false);
    assert.ok(f.buffers.every(b=>b.every(v=>v===0)));assert.ok(f.puts.every(v=>!v.includes('synthetic-password')));
  });
  await check('mismatched SSID or missing vault secret requires re-entry',async()=>{
    const f=vaultFixture(),store=await f.ProfileStore.open({}),p=valid();p.rememberPassword=true;await store.save(p,'synthetic-password');
    const newer={...p,ssid:'different-hotspot'};f.disk.set('profile',JSON.stringify(newer));
    assert.equal((await store.load()).secretUnavailable,true);assert.equal((await store.load()).password,'');
    await f.asset.remove();assert.equal((await store.load()).secretUnavailable,true);
  });
  await check('asset failure cannot claim a successful saved profile; future saves recover',async()=>{
    const f=vaultFixture(),store=await f.ProfileStore.open({}),p=valid();p.rememberPassword=true;f.failAdd(true);
    await assert.rejects(store.save(p,'synthetic-password'),/无法保存/);assert.equal(f.puts.length,0);assert.ok(f.buffers[0].every(v=>v===0));
    f.failAdd(false);await store.save(p,'synthetic-password');assert.equal(f.puts.length,1);
    p.rememberPassword=false;f.failRemove(true);await assert.rejects(store.save(p,''),/无法清除/);assert.equal(f.puts.length,1);
  });
  await check('queued saves capture their own profiles and final state follows user order',async()=>{
    const f=vaultFixture(),store=await f.ProfileStore.open({}),p=valid();p.rememberPassword=true;
    let release;f.gate(new Promise(r=>{release=r;}));const first=store.save(p,'first-password');await tick();
    p.ssid='second-hotspot';p.rememberPassword=false;const second=store.save(p,'second-password');release();await Promise.all([first,second]);
    assert.equal(JSON.parse(f.puts[0]).ssid,'test-hotspot');assert.equal(JSON.parse(f.puts[1]).ssid,'second-hotspot');assert.equal(f.secret(),undefined);
  });
  await check('clear profile removes opted-in secret and restores safe defaults',async()=>{
    const f=vaultFixture(),store=await f.ProfileStore.open({}),p=valid();p.rememberPassword=true;await store.save(p,'synthetic-password');await store.clear();
    const loaded=await store.load();assert.equal(loaded.profile.phoneAddress,'');assert.equal(loaded.profile.rememberPassword,false);assert.equal(loaded.password,'');assert.equal(f.secret(),undefined);
  });
  await check('reconnect is bounded and manual stop, background or missing credentials suppress it',()=>{
    const p=new ReconnectPolicy();assert.deepEqual([p.next(true,true,true),p.next(true,true,true),p.next(true,true,true),p.next(true,true,true)],[2000,4000,8000,-1]);
    p.reset();for(const args of [[false,true,true],[true,false,true],[true,true,false]])assert.equal(p.next(...args),-1);
    assert.equal(p.attempts,0);p.cancel();assert.equal(p.next(true,true,true),-1);p.reset();assert.equal(p.next(true,true,true),2000);
    p.connected();assert.equal(p.attempts,0);
  });
  await check('diagnostic report redacts literal metacharacters, names, addresses and UUIDs',()=>{
    const secret='pa$$[word].*';const report=diagnosticReport('已连接','已开启',`safe command 200\n${secret}\nTest phone\nAA:BB:CC:DD:EE:FF\n192.168.43.1\n12345678-1234-1234-1234-123456789abc`,[secret,'Test phone']);
    for(const value of [secret,'Test phone','AA:BB:CC:DD:EE:FF','192.168.43.1','12345678-1234-1234-1234-123456789abc'])assert.ok(!report.includes(value));
    assert.ok(report.includes('safe command 200'));assert.ok(report.includes('音频：当前版本不可用'));
  });
  await check('both application and video are immersive; background restores bars, back and screen settings',async()=>{
    const calls=[];const {Presentation}=load('Presentation',{'@kit.PerformanceAnalysisKit':{hilog:{info(){},warn(){}}},'@kit.ArkUI':{window:{Orientation:{AUTO_ROTATION_LANDSCAPE:7,AUTO_ROTATION_UNSPECIFIED:12}}}},'.ets');
    const p=new Presentation();p.attach({setWindowKeepScreenOn:async v=>calls.push(['awake',v]),setPreferredOrientation:async v=>calls.push(['orientation',v]),setWindowLayoutFullScreen:async v=>calls.push(['full',v]),setWindowSystemBarEnable:async v=>calls.push(['bars',Array.from(v)]),
      setSpecificSystemBarEnabled:async(n,v)=>calls.push([n,v]),setGestureBackEnabled:async v=>calls.push(['back',v])});
    await p.apply(true,true);assert.deepEqual(calls.slice(-6),[['full',true],['bars',[]],['navigationIndicator',false],['back',false],['awake',true],['orientation',7]]);
    await p.apply(false,false);assert.deepEqual(calls.slice(-6),[['full',true],['bars',[]],['navigationIndicator',false],['back',true],['awake',false],['orientation',12]]);
    p.suspend();await p.apply(true,true);assert.deepEqual(calls.slice(-6),[['full',false],['bars',['status','navigation']],['navigationIndicator',true],['back',true],['awake',false],['orientation',12]]);
    p.resume();await p.apply(false,false);assert.equal(calls.at(-6)[1],true);assert.equal(calls.at(-4)[1],false);
  });
  await check('late queued fullscreen request cannot restore an obsolete landscape mode',async()=>{
    const orientations=[];const {Presentation}=load('Presentation',{'@kit.PerformanceAnalysisKit':{hilog:{info(){},warn(){}}},'@kit.ArkUI':{window:{Orientation:{AUTO_ROTATION_LANDSCAPE:7,AUTO_ROTATION_UNSPECIFIED:12}}}},'.ets');
    const p=new Presentation();p.attach({setWindowKeepScreenOn:async()=>{},setPreferredOrientation:async v=>orientations.push(v),setWindowLayoutFullScreen:async()=>{},setWindowSystemBarEnable:async()=>{},setSpecificSystemBarEnabled:async()=>{},setGestureBackEnabled:async()=>{}});
    await Promise.all([p.apply(true,true),p.apply(false,false)]);assert.ok(orientations.every(v=>v===12));
  });
  console.log(tests+' product tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
