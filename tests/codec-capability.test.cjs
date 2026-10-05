const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
function fixture(options={}){const calls=[],timers=[];let cancelled=false;
 const native={startAudio:(rate,channels,kind)=>{calls.push(['start',rate,channels,kind]);return options.handle??7;},feedAudio:(handle,data,pts)=>{calls.push(['feed',handle,Array.from(new Uint8Array(data)),pts]);return options.feed??true;},
 readAudio:()=>{calls.push(['read']);if(options.error)throw Error('decoder error');return options.output;},stopAudio:handle=>calls.push(['stop',handle])};
 const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/../entry/src/main/ets/lab/CodecCapability.ets','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,
 {exports,Uint8Array,require:()=>({default:native}),setTimeout:(fn,ms)=>{timers.push(ms);if(options.cancelOnWait)cancelled=true;queueMicrotask(fn);}});
 return{probe:()=>exports.probeOpus(()=>cancelled),calls,timers};
}
let count=0;async function check(name,fn){await fn();count++;console.log('PASS '+name);}
(async()=>{
await check('Opus capability requires correct PCM frame after known silence packet and releases decoder',async()=>{
 const f=fixture({output:{data:new ArrayBuffer(1920),ptsUs:0}});assert.equal(await f.probe(),true);
 assert.deepEqual(f.calls[0],['start',48000,1,'opus']);assert.deepEqual(f.calls[1],['feed',7,[0xf8,0xff,0xfe],0]);assert.deepEqual(f.calls.at(-1),['stop',7]);
 for(const options of [{handle:-22},{feed:false},{output:{data:new ArrayBuffer(3840),ptsUs:0}},{error:true}]){
  const g=fixture(options);assert.equal(await g.probe(),false);assert.equal(g.calls.filter(c=>c[0]==='stop').length,options.handle<0?0:1);
 }
});
await check('capability timeout is bounded and cannot leak a decoder',async()=>{
 const f=fixture();assert.equal(await f.probe(),false);assert.equal(f.timers.length,20);assert.equal(f.timers.reduce((a,b)=>a+b,0),1000);assert.deepEqual(f.calls.at(-1),['stop',7]);
});
await check('cancellation during asynchronous probe stops decoder and never advertises support',async()=>{
 const f=fixture({cancelOnWait:true});assert.equal(await f.probe(),false);assert.equal(f.timers.length,1);assert.deepEqual(f.calls.at(-1),['stop',7]);
});
console.log(count+' codec capability tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
