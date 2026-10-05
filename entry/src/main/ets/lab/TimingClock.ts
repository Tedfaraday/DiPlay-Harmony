// GPL-3.0-only. Adapted from DiPlay NtpClock.kt.
export function ntpRead(bytes:Uint8Array,offset:number):bigint{
  if(offset+8>bytes.length){throw new Error('Truncated NTP timestamp');}let value=BigInt(0);
  for(let i=0;i<8;i++){value=(value<<BigInt(8))|BigInt(bytes[offset+i]);}return value;
}
export function ntpWrite(bytes:Uint8Array,offset:number,value:bigint):void{
  let remaining=value;for(let i=7;i>=0;i--){bytes[offset+i]=Number(remaining&BigInt(255));remaining>>=BigInt(8);}
}
export class TimingClock {
  synced:boolean=false;private epochMs:number;private started:number;private now:()=>number;
  private offset:bigint=BigInt(0);private pending:bigint|undefined;
  private picked:bigint=BigInt(0);private bestRtt:number=Infinity;private samples:number=0;
  constructor(now:()=>number,epochMs:number=Date.now()){this.now=now;this.started=now();this.epochMs=epochMs;}
  ntp():bigint{
    const ms=this.epochMs+this.now()-this.started,seconds=BigInt(Math.floor(ms/1000)+2208988800);
    const fraction=BigInt(Math.floor((ms%1000)*4294967296/1000));return ((seconds<<BigInt(32))+fraction+this.offset)&BigInt('18446744073709551615');
  }
  request():Uint8Array{const bytes=new Uint8Array(32);bytes[0]=128;bytes[1]=210;bytes[3]=7;this.pending=this.ntp();ntpWrite(bytes,24,this.pending);return bytes;}
  handle(bytes:Uint8Array):Uint8Array|undefined{
    if(bytes.length!==32||bytes[0]!==128||bytes[2]!==0||bytes[3]!==7){return undefined;}
    if(bytes[1]===210){const out=new Uint8Array(32);out[0]=128;out[1]=211;out[3]=7;out.set(bytes.slice(24,32),8);ntpWrite(out,16,this.ntp());ntpWrite(out,24,this.ntp());return out;}
    if(bytes[1]!==211||this.pending===undefined){return undefined;}
    const t1=ntpRead(bytes,8);if(t1!==this.pending){return undefined;}this.pending=undefined;
    const t2=ntpRead(bytes,16),t3=ntpRead(bytes,24),t4=this.ntp(),rtt=Number(t4-t1-(t3-t2))/4294967296;
    if(rtt<0||rtt>10){return undefined;}
    const offset=(t2-t1+t3-t4)/BigInt(2);if(rtt<this.bestRtt){this.bestRtt=rtt;this.picked=offset;}
    if(++this.samples>=2){this.offset+=this.synced?this.picked/BigInt(8):this.picked;this.synced=true;this.samples=0;this.bestRtt=Infinity;}
    return undefined;
  }
}
