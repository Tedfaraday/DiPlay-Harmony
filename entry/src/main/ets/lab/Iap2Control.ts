// GPL-3.0-only. iAP2 CSM/TLV layout and identity fields adapted from DiPlay.
export function parameter(id: number, data: Uint8Array): Uint8Array {
  const length = data.length + 4;
  if (length > 65535) { throw new Error('parameter too long'); }
  const bytes = new Uint8Array(length);
  bytes.set([length >>> 8, length & 255, id >>> 8, id & 255]); bytes.set(data, 4); return bytes;
}

export function controlMessage(id: number, parameters: Uint8Array[]): Uint8Array {
  let length = 6; for (let i = 0; i < parameters.length; i++) { length += parameters[i].length; }
  if (length > 65535) { throw new Error('CSM too long'); }
  const bytes = new Uint8Array(length); bytes.set([64,64,length >>> 8,length & 255,id >>> 8,id & 255]);
  let offset = 6; for (let i = 0; i < parameters.length; i++) { bytes.set(parameters[i], offset); offset += parameters[i].length; }
  return bytes;
}

export function readParameters(body: Uint8Array, id: number): Uint8Array[] {
  const found: Uint8Array[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) { throw new Error('truncated TLV'); }
    const length = body[offset] * 256 + body[offset + 1];
    const current = body[offset + 2] * 256 + body[offset + 3];
    if (length < 4 || offset + length > body.length) { throw new Error('invalid TLV length'); }
    if (current === id) { found.push(body.slice(offset + 4, offset + length)); }
    offset += length;
  }
  return found;
}

export function parameterIds(body: Uint8Array): number[] {
  const result: number[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) { throw new Error('truncated TLV'); }
    const length = body[offset] * 256 + body[offset + 1];
    if (length < 4 || offset + length > body.length) { throw new Error('invalid TLV length'); }
    result.push(body[offset + 2] * 256 + body[offset + 3]); offset += length;
  }
  return result;
}

// Observation only: never echo TLV strings or change protocol responses. Bound distinct reports.
export class IapControlDiagnostics {
  private seen:string[]=[];
  observe(id:number,body:Uint8Array):string{
    if(!Number.isInteger(id)||id<0||id>65535||this.seen.length>=24){return '';}
    if([0x1d00,0x1d02,0x1d03,0xaa00,0xaa02,0xaa04,0xaa05].includes(id)){return '';}
    let summary='';
    try{
      if(id===0x4e0d){summary='wirelessUpdate='+this.availability(body);}
      else if(id===0x4300){
        const names=['wired','wireless','themeAssets'],parts:string[]=[];
        for(let i=0;i<3;i++){const groups=readParameters(body,i);parts.push(names[i]+'='+(groups.length===0?'absent':groups.length===1?this.availability(groups[0]):'invalid'));}
        summary=parts.join(',');
      }else if(id===0x4e0e){
        const bt=readParameters(body,0),usb=readParameters(body,1);
        summary='transportBluetoothPresent='+(bt.length===1&&bt[0].length>0?'yes':'no')+',transportUsbPresent='+(usb.length===1&&usb[0].length>0?'yes':'no');
      }else if(id===0x5702){summary='wifiConfigurationRequested';}
      else{summary='unhandled,bytes='+Math.min(body.length,65535);}
    }catch(_error){summary='invalidDiagnosticFields';}
    const result='id=0x'+id.toString(16)+','+summary;
    if(this.seen.includes(result)){return '';}
    this.seen.push(result);return result;
  }
  private availability(body:Uint8Array):string{
    const values=readParameters(body,0);if(values.length===0){return 'absent';}
    if(values.length!==1||values[0].length!==1||values[0][0]>1){return 'invalid';}
    return values[0][0]===1?'yes':'no';
  }
}

export function identification(serial: string, encode: (text: string) => Uint8Array, bluetoothAddress: string = '',
  wireless: Uint8Array | undefined = undefined): Uint8Array {
  const strings = ['DiPlay Harmony','MatePad-mini','DiPlayHarmony',serial,'0.11.0','HarmonyOS'];
  const fields: Uint8Array[] = [];
  for (let i = 0; i < strings.length; i++) { fields.push(parameter(i, encode(strings[i] + '\u0000'))); }
  // Only advertise the responses implemented in this prototype.
  // Identification messages are mandatory protocol machinery, not feature-list entries.
  fields.push(parameter(6, new Uint8Array(wireless?[0xaa,1,0xaa,3,0x57,3,0x43,1]:[0xaa,1,0xaa,3])));
  fields.push(parameter(7, new Uint8Array(wireless?[0xaa,0,0xaa,2,0xaa,4,0xaa,5,0x57,2,0x43,0,0x4e,13,0x4e,14]:[0xaa,0,0xaa,2,0xaa,4,0xaa,5])));
  fields.push(parameter(8, new Uint8Array([0])));
  fields.push(parameter(9, new Uint8Array([0,0])));
  fields.push(parameter(12, encode('en\u0000'))); fields.push(parameter(13, encode('en\u0000')));
  {
    const components = [parameter(0,new Uint8Array([0,0])),parameter(1,encode('blue\u0000')),
      parameter(2,new Uint8Array(0))];
    if (bluetoothAddress.length > 0) {
      if (!/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(bluetoothAddress)) { throw new Error('invalid Bluetooth address'); }
      const parts = bluetoothAddress.split(':'); const mac = new Uint8Array(6);
      for (let i = 0; i < parts.length; i++) { mac[i] = parseInt(parts[i],16); }
      components.push(parameter(3,mac));
    }
    components.push(parameter(4,encode('blue\u0000')),parameter(5,new Uint8Array(0)));
    let length = 0; for (let i = 0; i < components.length; i++) { length += components[i].length; }
    const group = new Uint8Array(length); let offset = 0;
    for (let i = 0; i < components.length; i++) { group.set(components[i],offset); offset += components[i].length; }
    fields.push(parameter(17,group));
  }
  if(wireless){fields.push(wireless);}
  return controlMessage(0x1d01, fields);
}

export function ecdsaDerToRaw(der: Uint8Array): Uint8Array {
  if (der.length < 8 || der.length > 72 || der[0] !== 48 || der[1] !== der.length - 2) {
    throw new Error('invalid ECDSA DER sequence');
  }
  const raw = new Uint8Array(64); let offset = 2;
  for (let i = 0; i < 2; i++) {
    if (der[offset] !== 2) { throw new Error('invalid ECDSA integer tag'); }
    const length = der[offset + 1]; offset += 2;
    if (length < 1 || length > 33 || offset + length > der.length || (der[offset] & 128) !== 0) {
      throw new Error('invalid ECDSA integer');
    }
    let start = offset;
    if (der[start] === 0 && length > 1) {
      if ((der[start + 1] & 128) === 0) { throw new Error('noncanonical ECDSA integer'); }
      start++;
    }
    const size = offset + length - start;
    if (size > 32) { throw new Error('ECDSA integer exceeds P-256'); }
    let nonzero = false;
    for (let j = start; j < offset + length; j++) { if (der[j] !== 0) { nonzero = true; } }
    if (!nonzero) { throw new Error('zero ECDSA integer'); }
    raw.set(der.slice(start, offset + length), i * 32 + 32 - size); offset += length;
  }
  if (offset !== der.length) { throw new Error('trailing DER bytes'); }
  return raw;
}

