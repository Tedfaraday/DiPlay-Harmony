// Touch trajectories are synthetic, in viewport-independent logical coordinates.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require(process.env.DIPLAY_TYPESCRIPT||'typescript');
function load(name){const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(__dirname+'/../entry/src/main/ets/product/'+name+'.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports});return exports;}
const {ScreenInteraction,ScreenPoint,VideoViewport}=load('ScreenInteraction');
const p=(id,x,y)=>new ScreenPoint(id,x,y),viewport=new VideoViewport(100,50,800,450);
function fixture(immersive=true){const engine=new ScreenInteraction();return {engine,feed:(kind,points,changed,time)=>engine.feed(kind,points,changed,time,immersive,viewport)};}
function values(action){return Array.from(action.reports,r=>[r.x,r.y,r.down]);}
let count=0;function check(name,fn){fn();count++;console.log('PASS '+name);}
check('quick single tap remains a complete mapped down/up despite the gesture delay',()=>{
 const f=fixture();assert.deepEqual(values(f.feed('down',[p(0,500,275)],[p(0,500,275)],0)),[]);
 assert.deepEqual(values(f.feed('up',[p(0,500,275)],[p(0,500,275)],60)),[[.5,.5,true],[.5,.5,false]]);
 assert.deepEqual(values(f.engine.flush(1000)),[]);
});
check('single-finger drag and release map the letterboxed viewport, including clamped movement',()=>{
 const f=fixture();f.feed('down',[p(0,500,275)],[p(0,500,275)],0);assert.deepEqual(values(f.engine.flush(125)),[[.5,.5,true]]);
 assert.deepEqual(values(f.feed('move',[p(0,900,500)],[p(0,900,500)],160)),[[1,1,true]]);
 assert.deepEqual(values(f.feed('up',[p(0,1000,600)],[p(0,1000,600)],170)),[[1,1,false]]);
 const normal=fixture(false);assert.deepEqual(values(normal.feed('down',[p(0,100,50)],[p(0,100,50)],0)),[[0,0,true]]);
});
check('three fingers moving down together open controls once without sending any phone touch',()=>{
 const f=fixture(),reports=[];const a=[p(0,300,100),p(1,450,100),p(2,600,100)];
 reports.push(...values(f.feed('down',[a[0]],[a[0]],0)));reports.push(...values(f.feed('down',a.slice(0,2),[a[1]],20)));
 reports.push(...values(f.feed('down',a,[a[2]],40)));assert.deepEqual(values(f.engine.flush(160)),[]);
 const moved=[p(0,310,190),p(1,460,190),p(2,610,190)];const action=f.feed('move',moved,moved,300);
 assert.equal(action.showControls,true);reports.push(...values(action));assert.deepEqual(reports,[]);
 assert.equal(f.feed('move',moved,moved,310).showControls,false);
});
check('upward, horizontal, one-finger and two-finger gestures cannot reveal fullscreen controls',()=>{
 for(const destination of [[300,10],[480,100]]){
  const f=fixture(),a=[p(0,300,100),p(1,450,100),p(2,600,100)];f.feed('down',a,a,0);
  const dx=destination[0]-300,dy=destination[1]-100;const moved=a.map(v=>p(v.id,v.x+dx,v.y+dy));assert.equal(f.feed('move',moved,moved,200).showControls,false);
 }
 for(const fingers of [1,2]){const f=fixture(),a=Array.from({length:fingers},(_,id)=>p(id,300+id*100,100));f.feed('down',a,a,0);
  const moved=a.map(v=>p(v.id,v.x,v.y+180));assert.equal(f.feed('move',moved,moved,200).showControls,false);}
});
check('extra fingers, replaced fingers or slow motions invalidate a triple-finger gesture',()=>{
 const a=[p(0,300,100),p(1,450,100),p(2,600,100)],moved=a.map(v=>p(v.id,v.x,v.y+120));
 const four=fixture();four.feed('down',[...a,p(3,700,100)],[...a,p(3,700,100)],0);four.feed('up',a,[p(3,700,100)],30);assert.equal(four.feed('move',moved,moved,200).showControls,false);
 const replaced=fixture();replaced.feed('down',a,a,0);replaced.feed('up',a,[a[2]],20);replaced.feed('down',[a[0],a[1],p(3,600,100)],[p(3,600,100)],30);
 assert.equal(replaced.feed('move',[moved[0],moved[1],p(3,600,220)],[],200).showControls,false);
 const slow=fixture();slow.feed('down',a,a,0);assert.equal(slow.feed('move',moved,moved,2000).showControls,false);
});
check('cancelled touch releases one active contact and no delayed touch can escape later',()=>{
 const f=fixture();f.feed('down',[p(0,500,275)],[p(0,500,275)],0);f.engine.flush(125);
 assert.deepEqual(values(f.engine.cancel()),[[.5,.5,false]]);assert.deepEqual(values(f.engine.cancel()),[]);assert.deepEqual(values(f.engine.flush(300)),[]);
 const delayed=fixture();delayed.feed('down',[p(0,500,275)],[p(0,500,275)],0);assert.deepEqual(values(delayed.engine.cancel()),[]);assert.deepEqual(values(delayed.engine.flush(300)),[]);
});
check('letterbox bars reject phone taps but still allow local fullscreen gesture',()=>{
 const f=fixture();f.feed('down',[p(0,500,10)],[p(0,500,10)],0);assert.deepEqual(values(f.feed('up',[p(0,500,200)],[p(0,500,200)],300)),[]);
 const a=[p(0,300,10),p(1,450,10),p(2,600,10)];f.feed('down',a,a,500);const moved=a.map(v=>p(v.id,v.x,v.y+120));assert.equal(f.feed('move',moved,moved,800).showControls,true);
 const normal=fixture(false);normal.feed('down',a,a,500);assert.equal(normal.feed('move',moved,moved,800).showControls,false);
});
check('Material color text roles preserve accessible contrast on their assigned surfaces',()=>{
 const {M3}=load('MaterialTheme');
 function luminance(hex){const channels=hex.slice(1).match(/../g).map(c=>parseInt(c,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);return .2126*channels[0]+.7152*channels[1]+.0722*channels[2];}
 for(const [background,foreground] of [[M3.primary,M3.onPrimary],[M3.primaryContainer,M3.onPrimaryContainer],[M3.secondaryContainer,M3.onSecondaryContainer],[M3.surface,M3.onSurface],[M3.surface,M3.onSurfaceVariant],[M3.surfaceContainerHighest,M3.onSurface]]){
  const a=luminance(background),b=luminance(foreground);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5);}
});
console.log(count+' screen interaction/theme tests passed');
