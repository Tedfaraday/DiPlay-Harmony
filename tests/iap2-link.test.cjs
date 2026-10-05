const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const ts = require(process.env.DIPLAY_TYPESCRIPT || 'typescript');
function load(name) {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, '../entry/src/main/ets/lab', name + '.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,
    {exports, Uint8Array, require:n=>load(n.replace('./',''))});
  return exports;
}
const { Iap2Link, CsmObserver } = load('Iap2Link');
const marker = [255,85,2,0,238,16];
const sync = [1,4,255,255,15,160,1,244,4,3,10,0,2];
function frame(control, seq, ack, session=0, payload) {
  const length = payload ? payload.length+10 : 9;
  const h = [255,90,length>>8,length&255,control,seq,ack,session];
  h.push((-h.reduce((a,b)=>a+b,0))&255);
  if (payload) h.push(...payload,(-payload.reduce((a,b)=>a+b,0))&255);
  return Uint8Array.from(h);
}
function ready(sequence=99, peer=sync) {
  const l = new Iap2Link(); l.start(0); l.takeOutput();
  l.feed(Uint8Array.from(marker),1); l.takeOutput();
  l.feed(frame(128,sequence,0,0,peer),2); l.takeOutput();
  l.feed(frame(64,sequence,99),3); l.takeOutput(); l.takeEvents();
  assert.equal(l.state,'NORMAL'); return l;
}
let count=0;
function check(name, fn) { fn(); console.log('PASS '+name); count++; }
check('every handshake fragmentation boundary and outgoing checksums',()=>{
  const bytes=Uint8Array.from([...marker,...frame(192,99,99,0,sync)]);
  for(let i=0;i<=bytes.length;i++){
    const l=new Iap2Link();l.start(0);l.takeOutput();
    l.feed(bytes.slice(0,i),1);l.feed(bytes.slice(i),2);
    assert.equal(l.state,'NORMAL');
    const output=l.takeOutput(); assert.equal(output.length,2);
    for(const f of output){assert.equal(f.slice(0,9).reduce((a,b)=>a+b,0)&255,0);
      if(f.length>9)assert.equal(f.slice(9).reduce((a,b)=>a+b,0)&255,0);}
  }
});
check('detection and SYN timers use caller clock',()=>{
  const l=new Iap2Link();l.start(100);l.takeOutput();l.advance(1099);assert.equal(l.takeOutput().length,0);
  l.advance(1100);assert.deepEqual(Array.from(l.takeOutput()[0]),marker);
  l.feed(Uint8Array.from(marker),1200);l.takeOutput();l.advance(1699);assert.equal(l.takeOutput().length,0);
  l.advance(1700);assert.equal(l.takeOutput()[0][4],128);
});
check('invalid SYN limits and absent control session fail safely',()=>{
  for(const mutate of [p=>p[1]=0,p=>{p[2]=0;p[3]=10;},p=>p[10]=11,p=>p[4]=p[5]=0]){
    const p=sync.slice(); mutate(p);const l=new Iap2Link();l.start(0);l.feed(Uint8Array.from(marker),1);
    l.feed(frame(192,99,99,0,p),2);assert.equal(l.state,'DEAD');assert.equal(l.takeOutput().length,0);
  }
});
check('corrupt payload is not delivered, ACK does not establish link without SYN',()=>{
  const l=new Iap2Link();l.start(0);l.feed(Uint8Array.from(marker),1);l.feed(frame(64,99,99),2);
  assert.equal(l.state,'NEGOTIATING');
  const normal=ready(); const bad=frame(64,100,99,10,[64,64,0,6,170,0]);bad[bad.length-1]^=1;
  normal.feed(bad,5);assert.equal(normal.takeEvents().length,0);
});
check('out of order, duplicate suppression, and sequence wrap',()=>{
  const l=ready(254);l.feed(frame(64,0,99,10,[2]),10);assert.equal(l.takeEvents().length,0);
  l.feed(frame(64,255,99,10,[1]),11);
  assert.deepEqual(Array.from(l.takeEvents(),e=>Array.from(e.data)),[[1],[2]]);
  l.feed(frame(64,0,99,10,[2]),12);assert.equal(l.takeEvents().length,0);
  assert.equal(l.takeOutput().at(-1)[6],0);
});
check('sender respects negotiated window; impossible ACK cannot free it',()=>{
  const l=ready();for(let i=0;i<5;i++)l.sendControl(Uint8Array.of(i),10);
  assert.equal(l.takeOutput().length,4);
  l.feed(frame(64,99,120),11);assert.equal(l.takeOutput().length,0);
  l.feed(frame(64,99,100),12);const frames=l.takeOutput();assert.equal(frames[0][5],104);
});
check('retransmission exhaustion closes and clears unsent output',()=>{
  const l=ready();l.sendControl(Uint8Array.of(1),10);l.takeOutput();
  for(let i=1;i<4;i++){l.advance(10+i*4000);assert.equal(l.takeOutput().length,1);}
  l.advance(16010);assert.equal(l.state,'DEAD');assert.equal(l.takeOutput().length,0);
});
check('delayed ACK and reset',()=>{
  const l=ready();l.feed(frame(64,100,99,10,[1]),10);l.takeOutput();
  l.advance(509);assert.equal(l.takeOutput().length,0);l.advance(510);assert.equal(l.takeOutput()[0][6],100);
  l.feed(frame(16,100,99),511);assert.equal(l.state,'DEAD');
});
check('CSM spans packets and coalesces messages',()=>{
  const c=new CsmObserver();assert.equal(c.feed(Uint8Array.of(64,64,0)).length,0);
  assert.deepEqual(Array.from(c.feed(Uint8Array.of(6,170,0,64,64,0,6,29,0))),[0xaa00,0x1d00]);
});
check('bounded pending queues and peer frame limit',()=>{
  const l=ready();assert.throws(()=>l.sendControl(new Uint8Array(65526),10));
  for(let i=0;i<69;i++)l.sendControl(Uint8Array.of(1),10);
  assert.equal(l.state,'DEAD');
});
console.log(count+' link tests passed');
