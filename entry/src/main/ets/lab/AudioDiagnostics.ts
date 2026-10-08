import { Plist as P, decodePlist } from './Bplist';
import { pcmFormat, describePcmBits } from './AudioCodec';
// Strict allowlist: no device IDs, addresses, key material, payloads, or arbitrary strings.
export function audioSetupSummary(stream:P):string{
  const values:string[]=[];
  const fields=['type','audioFormat','sampleRate','channels','framesPerPacket','audioLatencyMs','dataPort','controlPort'];
  for(let i=0;i<fields.length;i++){
    const node=stream.entries.get(fields[i]);
    if(node?.kind==='int'&&node.integer>=BigInt(0)&&node.integer<=BigInt('4294967295')){values.push(fields[i]+'='+node.integer.toString());}
  }
  const name=stream.entries.get('audioType');
  const allowed=['compatibility','default','media','alert','telephony','speechrecognition'];
  values.push('audioType='+(name?.kind==='str'&&allowed.includes(name.text.toLowerCase())?name.text.toLowerCase():'other-or-absent'));
  values.push('inputPortPresent='+(stream.entries.has('dataPort')?'yes':'no'));
  // Only the negotiated mask is inspected, and only fixed tokens are emitted.
  const node=stream.entries.get('audioFormat');
  if(node?.kind==='int'&&node.integer>=BigInt(0)&&node.integer<=BigInt('4294967295')){
    const bits=Number(node.integer);
    values.push('bitsDeclared='+describePcmBits(bits));
    try{const format=pcmFormat(bits);values.push('selected='+format.codec+'/'+format.rate+'/'+format.channels);}
    catch(_error){values.push('selected=rejected');}
  }
  return values.join(',');
}

export function airPlayCommandName(command:P):string{
  const node=command.entries.get('type'),names=['requestUI','modesChanged','updateHIDDevice','updateVehicleInformation','setNightMode',
    'disableBluetooth','disable-bluetooth','setUpStreams','tearDownStreams','duckAudio','unduckAudio','flushAudio','setAudioVolume',
    'hidSetReport','hidSetInputMode','hidCopyInputMode','iAPSendMessage'];
  return node?.kind==='str'&&names.includes(node.text)?node.text:'其他命令';
}
// Presence and fixed tokens only: never print a query, arbitrary key, identifier, data or URL.
export function capabilityRequestSummary(body:Uint8Array):string{
  if(body.length===0){return 'body=empty';}
  try{
    const root=decodePlist(body);if(root.kind!=='dict'){return 'body=non-dict';}
    const known=['qualifier','features','audioFormats','audioLatencies','supportsAudio','isScreenMirroring','streams','enabledFeatures'];
    const present:string[]=[];for(let i=0;i<known.length;i++){if(root.entries.has(known[i])){present.push(known[i]);}}
    const qualifier=root.entries.get('qualifier'),tokens:string[]=[];
    const allowed=['txtAirPlay','features','audioFormats','audioLatencies','displays','hidDevices','modes'];
    if(qualifier?.kind==='array'){
      for(let i=0;i<Math.min(qualifier.items.length,32);i++){const item=qualifier.items[i];if(item.kind==='str'&&allowed.includes(item.text)&&!tokens.includes(item.text)){tokens.push(item.text);}}
    }
    return 'keys='+(present.join('|')||'other')+',qualifier='+(tokens.join('|')||'none-known');
  }catch(_error){return 'body=unparsed';}
}
export function audioCommandSummary(command:P):string{
  const params=command.entries.get('params');if(params?.kind!=='dict'){return 'params=absent';}
  const fields=['streams','audioType','streamType','dB','durationMs','data','status'],parts:string[]=[];
  for(let i=0;i<fields.length;i++){if(params.entries.has(fields[i])){parts.push(fields[i]);}}
  const streams=params.entries.get('streams'),types:string[]=[];
  if(streams?.kind==='array'){
    for(let i=0;i<Math.min(streams.items.length,8);i++){
      const type=streams.items[i].entries.get('type');types.push(type?.kind==='int'&&[100,101,102,103,110,111,130].includes(Number(type.integer))?type.integer.toString():'other');
    }
  }
  return 'params='+(parts.join('|')||'other')+',streamTypes='+(types.join('|')||'none');
}
