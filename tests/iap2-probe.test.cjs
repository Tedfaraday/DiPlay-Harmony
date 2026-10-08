// Runs the actual .ts protocol parser without HarmonyOS hardware.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const compilerPath = process.env.DIPLAY_TYPESCRIPT || 'typescript';
const ts = require(compilerPath);
const source = fs.readFileSync(path.join(__dirname, '../entry/src/main/ets/lab/Iap2Probe.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const exportsObject = {};
vm.runInNewContext(compiled.outputText, { exports: exportsObject, Uint8Array });
const { Iap2Probe, IAP2_MARKER } = exportsObject;
let tests = 0;
function check(name, fn) { fn(); tests++; console.log(`PASS ${name}`); }
function kinds(events) { return Array.from(events, e => e.kind); }
// Captured wire-layout fixtures, checksums calculated independently by hand:
// ff+5a+00+09+40+63+00+00 = 0x205 => checksum fb.
const ACK = [0xff,0x5a,0x00,0x09,0x40,0x63,0x00,0x00,0xfb];
const SYN = [0xff,0x5a,0x00,0x0d,0x80,0x63,0x00,0x00,0xb7,0x01,0x02,0x03,0xfa];
check('marker and SYN split at every byte boundary', () => {
  const wire = [...IAP2_MARKER, ...SYN];
  for (let split = 0; split <= wire.length; split++) {
    const p = new Iap2Probe();
    const events = [...p.feed(Uint8Array.from(wire.slice(0, split))), ...p.feed(Uint8Array.from(wire.slice(split)))];
    assert.deepEqual(kinds(events), ['marker','frame','sync']);
  }
});
check('byte-by-byte delivery and multiple coalesced frames', () => {
  const p = new Iap2Probe(); let result = [];
  for (const byte of [...IAP2_MARKER, ...ACK, ...SYN, ...ACK]) { result.push(...p.feed(Uint8Array.of(byte))); }
  assert.deepEqual(kinds(result), ['marker','frame','frame','sync','frame']);
});
check('invalid header recovers to next valid frame', () => {
  const p = new Iap2Probe();
  const broken = ACK.slice(); broken[8] = 0;
  assert.deepEqual(kinds(p.feed(Uint8Array.from([...IAP2_MARKER, ...broken, ...ACK]))), ['marker','invalid','frame']);
});
check('payload checksum failure is never reported as SYN', () => {
  const p = new Iap2Probe(); const broken = SYN.slice(); broken[12] = 0;
  assert.deepEqual(kinds(p.feed(Uint8Array.from([...IAP2_MARKER,...broken,...ACK]))), ['marker','invalid','frame']);
});
check('noise and partial marker are handled', () => {
  const p = new Iap2Probe();
  assert.deepEqual(kinds(p.feed(Uint8Array.from([1,2,0xff,0x55]))), []);
  assert.deepEqual(kinds(p.feed(Uint8Array.from(IAP2_MARKER.slice(2)))), ['marker']);
});
check('valid frames alone do not imply detection success', () => {
  const p = new Iap2Probe(); assert.deepEqual(kinds(p.feed(Uint8Array.from(ACK))), []);
});
check('buffer overflow is bounded', () => {
  const p = new Iap2Probe(); assert.deepEqual(kinds(p.feed(new Uint8Array(131071))), ['overflow']);
});
console.log(`${tests} protocol tests passed`);
