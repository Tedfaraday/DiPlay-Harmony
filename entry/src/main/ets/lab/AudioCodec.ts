// GPL-3.0-only. Wire format adapted from DiPlay AudioStream.kt.
export class PcmFormat {
  rate:number;channels:number;codec:string;
  constructor(rate:number,channels:number,codec:string='pcm'){this.rate=rate;this.channels=channels;this.codec=codec;}
}
export function pcmFormat(bits:number):PcmFormat{
  if([0x10000000,0x20000000,0x40000000].includes(bits)){return new PcmFormat(48000,1,'opus');}
  if(bits===0x400000||bits===0x800000){return new PcmFormat(bits===0x400000?44100:48000,2,'aac');}
  const flags=[4,8,16,32,64,128,256,512,1024,2048,16384,32768];
  const rates=[8000,8000,16000,16000,24000,24000,32000,32000,44100,44100,48000,48000];
  const index=flags.indexOf(bits);if(index<0){throw new Error('尚未支持该音频编码');}
  return new PcmFormat(rates[index],index%2+1);
}
// GPL-3.0-only. ADTS framing follows DiPlay MediaCodecSupport.adtsFrame.
export function aacAdts(payload:Uint8Array,format:PcmFormat):Uint8Array{
  const index=format.rate===48000?3:format.rate===44100?4:-1;
  if(index<0||format.channels!==2||payload.length<1||payload.length+7>8191){throw new Error('AAC 帧格式错误');}
  if(payload.length>=7&&payload[0]===255&&(payload[1]&246)===240){
    const length=((payload[3]&3)<<11)|(payload[4]<<3)|(payload[5]>>>5);
    if(length!==payload.length){throw new Error('AAC ADTS 长度错误');}return new Uint8Array(payload);
  }
  const length=payload.length+7,frame=new Uint8Array(length);
  frame.set([255,241,64|(index<<2),128|(length>>>11),(length>>>3)&255,((length&7)<<5)|31,252]);frame.set(payload,7);return frame;
}
export class AudioPacket {
  nonce:Uint8Array;sealed:Uint8Array;aad:Uint8Array;sample:number;counter:bigint;
  constructor(wire:Uint8Array){
    // This implementation negotiates the fixed 12-byte RTP header only.
    if(wire.length<38||wire.length>8192||wire[0]!==128){throw new Error('音频 RTP 包格式错误');}
    const end=wire.length-8;this.nonce=new Uint8Array(12);this.nonce.set(wire.slice(end),4);
    this.sealed=wire.slice(12,end);this.aad=wire.slice(4,12);
    this.sample=new DataView(wire.buffer,wire.byteOffset,wire.byteLength).getUint32(4,false);
    this.counter=BigInt(0);for(let i=7;i>=0;i--){this.counter=(this.counter<<BigInt(8))|BigInt(wire[end+i]);}
  }
}
// Authenticate before committing a nonce. A sliding window permits UDP reordering.
export class AudioReplayWindow {
  private top:bigint=BigInt(-1);private mask:bigint=BigInt(0);
  accepts(counter:bigint):boolean{
    if(counter>this.top){return true;}const delta=this.top-counter;
    return delta<BigInt(256)&&(this.mask&(BigInt(1)<<delta))===BigInt(0);
  }
  commit(counter:bigint):void{
    if(!this.accepts(counter)){throw new Error('重复音频包');}
    if(counter>this.top){const distance=counter-this.top;this.mask=distance>=BigInt(256)?BigInt(1):(this.mask<<distance)|BigInt(1);this.top=counter;}
    else{this.mask|=BigInt(1)<<(this.top-counter);}
    this.mask&=(BigInt(1)<<BigInt(256))-BigInt(1);
  }
}
export function pcmLittleEndian(bytes:Uint8Array,channels:number):Uint8Array{
  if(bytes.length===0||bytes.length%(channels*2)!==0){throw new Error('PCM 样本长度错误');}
  const pcm=new Uint8Array(bytes.length);for(let i=0;i<bytes.length;i+=2){pcm[i]=bytes[i+1];pcm[i+1]=bytes[i];}return pcm;
}
function distance(sample:number,origin:number):number{return ((sample-origin+2147483648)>>>0)-2147483648;}
class PcmSegment {
  sample:number;pcm:Uint8Array;offset:number=0;
  constructor(sample:number,pcm:Uint8Array){this.sample=sample;this.pcm=pcm;}
}
// A bounded, timestamp-ordered buffer. Missing samples become silence, never uninitialized memory.
export class PcmJitterBuffer {
  private segments:PcmSegment[]=[];private cursor:number=0;private initialized:boolean=false;private playing:boolean=false;
  private bytes:number=0;private frameBytes:number;private maxFrames:number;private prefillBytes:number;
  constructor(format:PcmFormat){this.frameBytes=format.channels*2;this.maxFrames=Math.floor(format.rate/5);this.prefillBytes=Math.ceil(format.rate*0.03)*this.frameBytes;}
  get queuedBytes():number{return this.bytes;}
  push(sample:number,pcm:Uint8Array):void{
    if(pcm.length===0||pcm.length%this.frameBytes!==0||pcm.length>this.maxFrames*this.frameBytes){throw new Error('音频缓冲样本错误');}
    if(!this.initialized||(this.segments.length===0&&Math.abs(distance(sample,this.cursor))>this.maxFrames)){
      this.cursor=sample;this.initialized=true;this.playing=false;
    }
    let delta=distance(sample,this.cursor);
    if(!this.playing&&delta<0&&delta>=-this.maxFrames){this.cursor=sample;delta=0;}
    if(delta>this.maxFrames){this.clear();this.cursor=sample;this.initialized=true;delta=0;}
    if(delta<0){const skip=-delta*this.frameBytes;if(skip>=pcm.length){return;}pcm=pcm.slice(skip);sample=this.cursor;}
    if(this.segments.some((segment:PcmSegment):boolean=>segment.sample===sample)){return;}
    this.segments.push(new PcmSegment(sample,pcm));this.bytes+=pcm.length;
    this.segments.sort((a:PcmSegment,b:PcmSegment):number=>distance(a.sample,this.cursor)-distance(b.sample,this.cursor));
    while(this.bytes>this.maxFrames*this.frameBytes||this.segments.length>64){
      const oldest=this.segments.shift();if(oldest){this.bytes-=oldest.pcm.length-oldest.offset;oldest.pcm.fill(0);}
      const first=this.segments[0];if(first){this.cursor=(first.sample+first.offset/this.frameBytes)>>>0;}
    }
  }
  fill(target:Uint8Array,force:boolean=false):number{
    target.fill(0);if(target.length%this.frameBytes!==0){return 0;}
    if(!this.playing){if(this.bytes===0||(!force&&this.bytes<this.prefillBytes)){return 0;}this.playing=true;}
    let written=0,real=0;
    while(written<target.length){
      const segment=this.segments[0];if(!segment){this.cursor=(this.cursor+(target.length-written)/this.frameBytes)>>>0;break;}
      const delta=distance((segment.sample+segment.offset/this.frameBytes)>>>0,this.cursor);
      if(delta<0){const skip=Math.min(-delta*this.frameBytes,segment.pcm.length-segment.offset);segment.offset+=skip;this.bytes-=skip;}
      else if(delta>0){const gap=Math.min(delta*this.frameBytes,target.length-written);written+=gap;this.cursor=(this.cursor+gap/this.frameBytes)>>>0;}
      else{
        const amount=Math.min(segment.pcm.length-segment.offset,target.length-written);
        target.set(segment.pcm.subarray(segment.offset,segment.offset+amount),written);segment.offset+=amount;written+=amount;real+=amount;this.bytes-=amount;this.cursor=(this.cursor+amount/this.frameBytes)>>>0;
      }
      if(segment.offset===segment.pcm.length){this.segments.shift();segment.pcm.fill(0);}
    }
    return real;
  }
  clear():void{this.segments.forEach((segment:PcmSegment):void=>{segment.pcm.fill(0);});this.segments=[];this.bytes=0;this.initialized=false;this.playing=false;}
}
