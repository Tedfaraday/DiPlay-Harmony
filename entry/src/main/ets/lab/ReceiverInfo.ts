// GPL-3.0-only. Adapted from DiPlay AirPlayInfoPlist.kt / AirPlayHid.kt.
import { Plist as P } from './Bplist';
import { DisplayProfile } from './DisplayProfile';
export const RECEIVER_FEATURES=BigInt('0x615653aee2');
export function receiverTxtRecords(deviceId:string,pairingId:string,publicKey:string):Map<string,string>{
  const records=new Map<string,string>();
  const names=['deviceid','features','flags','model','srcvers','protovers','pi','pk'];
  const features='0x'+(RECEIVER_FEATURES&BigInt('4294967295')).toString(16)+',0x'+(RECEIVER_FEATURES>>BigInt(32)).toString(16);
  const values=[deviceId,features,'0x4','DiPlayHarmony','950.7.1','1.1',pairingId,publicKey];
  for(let i=0;i<names.length;i++){records.set(names[i],values[i]);}return records;
}
export const DISPLAY_WIDTH=1280,DISPLAY_HEIGHT=720,DISPLAY_UUID='b7e6c5a0-1111-4000-8000-000000000001';
function finger(width:number,height:number):number[]{return [5,13,9,34,161,2,9,56,117,8,149,1,129,2,21,0,37,1,9,51,117,1,149,1,129,2,149,7,129,3,5,1,38,width&255,width>>>8,9,48,117,16,149,1,129,2,38,height&255,height>>>8,9,49,129,2,192];}
export function touchDescriptor(profile:DisplayProfile=new DisplayProfile()):Uint8Array{return new Uint8Array([5,13,9,4,161,1,...finger(profile.width,profile.height),...finger(profile.width,profile.height),192]);}
function resource(id:number):P{return P.dict(['resourceID','transferType','transferPriority','takeConstraint','borrowConstraint','unborrowConstraint'],[P.int(id),P.int(1),P.int(100),P.int(100),P.int(100),P.int(100)]);}
function area(profile:DisplayProfile):P{return P.dict(['widthPixels','heightPixels','originXPixels','originYPixels'],[P.int(profile.width),P.int(profile.height),P.int(0),P.int(0)]);}
export class DeclaredAudioFormat {
  type:number;audioType:string;output:number;input:number;
  constructor(type:number,audioType:string,output:number,input:number){this.type=type;this.audioType=audioType;this.output=output;this.input=input;}
}
const AUDIO_TYPES=[100,100,100,100,100,100,101,101];
const AUDIO_NAMES=['compatibility','default','alert','media','telephony','speechRecognition','compatibility','default'];
const DUPLEX_TYPES=['compatibility','default','telephony','speechrecognition'];
const OPUS_TYPES=['default','alert','telephony','speechrecognition'];
// Single source of truth for what /info advertises, so SETUP validation cannot drift from the declaration.
export function declaredAudioFormats(opus:boolean=false,microphone:number=0):DeclaredAudioFormat[]{
  const result:DeclaredAudioFormat[]=[],pcm=0xc3fc,mono=0x4154;
  for(let i=0;i<AUDIO_TYPES.length;i++){
    const name=AUDIO_NAMES[i],normalized=name.toLowerCase();
    const duplex=AUDIO_TYPES[i]===100&&DUPLEX_TYPES.includes(normalized)&&microphone!==0;
    const pcmBits=normalized==='telephony'||normalized==='speechrecognition'?mono:pcm;
    const wireless=!duplex&&opus&&OPUS_TYPES.includes(normalized)?0x70000000:0;
    result.push(new DeclaredAudioFormat(AUDIO_TYPES[i],name,(duplex?microphone:pcmBits)|wireless,duplex?microphone:0));
  }
  result.push(new DeclaredAudioFormat(102,'media',0x800000,0));
  return result;
}
export function receiverInfo(bluetoothAddress:string,opus:boolean=false,profile:DisplayProfile=new DisplayProfile(),microphone:number=0):P{
  const safe=area(profile);safe.entries.set('drawUIOutsideSafeArea',P.bool(true));const view=area(profile);view.entries.set('safeArea',safe);
  const display=P.dict(['uuid','type','maxFPS','widthPixels','heightPixels','widthPhysical','heightPhysical','features','primaryInputDevice','viewAreas','initialViewArea'],
    [P.str(DISPLAY_UUID),P.int(110),P.int(30),P.int(profile.width),P.int(profile.height),P.int(profile.physicalWidth),P.int(profile.physicalHeight),P.int(8),P.int(1),P.array([view]),P.int(0)]);
  const hid=P.dict(['hidProductID','hidVendorID','hidCountryCode','uuid','name','displayUUID','hidDescriptor'],
    [P.int(1),P.int(2),P.int(0),P.str('2a2a2a2a'),P.str('DiPlay Harmony Touchscreen'),P.str(DISPLAY_UUID),P.bytes(touchDescriptor(profile))]);
  const modes=P.dict(['resources','appStates'],[P.array([resource(1),resource(2)]),P.array([
    P.dict(['appStateID','state'],[P.int(2),P.bool(false)]),P.dict(['appStateID','speechMode'],[P.int(1),P.int(-1)]),P.dict(['appStateID','state'],[P.int(3),P.bool(false)])])]);
  const formats:P[]=[],latencies:P[]=[],declared=declaredAudioFormats(opus,microphone);
  for(let i=0;i<declared.length;i++){
    const entry=declared[i];
    const format=P.dict(['type','audioType','audioOutputFormats'],[P.int(entry.type),P.str(entry.audioType),P.int(entry.output)]);
    if(entry.input!==0){format.entries.set('audioInputFormats',P.int(entry.input));}
    formats.push(format);
    if(entry.type!==102){latencies.push(P.dict(['type','audioType','outputLatencyMicros'],[P.int(entry.type),P.str(entry.audioType),P.int(30000)]));}
  }
  latencies.push(P.dict(['type','outputLatencyMicros'],[P.int(100),P.int(30000)]));
  latencies.push(P.dict(['type','outputLatencyMicros'],[P.int(101),P.int(30000)]));
  latencies.push(P.dict(['type','audioType','outputLatencyMicros'],[P.int(102),P.str('default'),P.int(30000)]));
  // Match the upstream input-latency declaration; this is a protocol value, not a measured capture delay.
  for(let i=0;i<latencies.length;i++){latencies[i].entries.set('inputLatencyMicros',P.int(0));}
  return P.dict(['sourceVersion','features','statusFlags','model','manufacturer','deviceID','bluetoothIDs','name','rightHandDrive','keepAliveLowPower','keepAliveSendStatsAsBody','modes','extendedFeatures','displays','hidDevices','audioFormats','audioLatencies'],
    [P.str('950.7.1'),P.int(RECEIVER_FEATURES),P.int(4),P.str('DiPlayHarmony'),P.str('DiPlayHarmony'),P.str(bluetoothAddress),P.array([P.str(bluetoothAddress)]),P.str('DiPlay Harmony'),P.bool(false),P.bool(false),P.bool(false),modes,P.array(opus?[P.str('vocoderInfo'),P.str('enhancedRequestCarUI')]:[P.str('enhancedRequestCarUI')]),P.array([display]),P.array([hid]),P.array(formats),P.array(latencies)]);
}

