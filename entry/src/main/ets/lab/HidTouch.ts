// GPL-3.0-only. Adapted from DiPlay AirPlayHid.kt (single-contact path).
import { Plist } from './Bplist';
import { DisplayProfile } from './DisplayProfile';
export function touchCommand(x:number,y:number,down:boolean,profile:DisplayProfile=new DisplayProfile()):Plist{
  if(!Number.isFinite(x)||!Number.isFinite(y)){throw new Error('Invalid touch coordinate');}
  const report=new Uint8Array(12);report[1]=down?1:0;report[6]=1;
  const px=Math.round(Math.max(0,Math.min(1,x))*profile.width),py=Math.round(Math.max(0,Math.min(1,y))*profile.height);
  report[2]=px&255;report[3]=px>>>8;report[4]=py&255;report[5]=py>>>8;
  return Plist.dict(['type','uuid','hidReport'],[Plist.str('hidSendReport'),Plist.str('2a2a2a2a'),Plist.bytes(report)]);
}
