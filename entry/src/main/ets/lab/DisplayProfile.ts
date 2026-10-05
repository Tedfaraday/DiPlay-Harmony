// One immutable display declaration is shared by /info, HID and the decoder.
export class DisplayProfile {
  readonly width:number;readonly height:number;readonly physicalWidth:number;readonly physicalHeight:number;
  readonly panelWidth:number;readonly panelHeight:number;readonly measuredPpi:boolean;
  constructor(width:number=1280,height:number=720,physicalWidth:number=180,physicalHeight:number=101,
    panelWidth:number=0,panelHeight:number=0,measuredPpi:boolean=false) {
    this.width=width;this.height=height;this.physicalWidth=physicalWidth;this.physicalHeight=physicalHeight;
    this.panelWidth=panelWidth;this.panelHeight=panelHeight;this.measuredPpi=measuredPpi;
  }
}
export function displayProfile(width:number,height:number,xDpi:number,yDpi:number):DisplayProfile {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<320||height<320||width>16384||height>16384){return new DisplayProfile();}
  const landscape=width>=height,long=Math.round(Math.max(width,height)),short=Math.round(Math.min(width,height));
  // Keep the proven 1280-pixel decode budget while matching the panel's aspect.
  const w=Math.min(1280,long);const h=Math.round((w*short/long)/2)*2;
  if(h<320){return new DisplayProfile();}
  const dx=landscape?xDpi:yDpi,dy=landscape?yDpi:xDpi;
  const measured=Number.isFinite(dx)&&Number.isFinite(dy)&&dx>=80&&dx<=1000&&dy>=80&&dy<=1000;
  // Logical vp density is deliberately not used as physical PPI.
  const mmW=measured?Math.round(long/dx*25.4):180;
  const mmH=measured?Math.round(short/dy*25.4):Math.round(180*short/long);
  return new DisplayProfile(w-w%2,h,mmW,mmH,long,short,measured);
}
export function fitVideo(width:number,height:number,profile:DisplayProfile):number[] {
  const w=Math.min(Math.max(1,width),Math.max(1,height)*profile.width/profile.height);
  return [w,w*profile.height/profile.width];
}
