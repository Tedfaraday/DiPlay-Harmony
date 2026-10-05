import native from 'libdiplayvideo.so';
import { PcmFormat, aacAdts } from './AudioCodec';
export class DecodedPcm {
  pcm:Uint8Array;sample:number;
  constructor(pcm:Uint8Array,sample:number){this.pcm=pcm;this.sample=sample;}
}
export class AudioDecodeBridge {
  private handle:number=0;private format:PcmFormat;
  constructor(format:PcmFormat){this.format=format;}
  start():void{
    this.handle=native.startAudio(this.format.rate,this.format.channels,this.format.codec);
    if(this.handle<=0){throw new Error(`原生音频解码器启动失败 ${this.handle}`);}
  }
  feed(payload:Uint8Array,sample:number):void{
    const frame=this.format.codec==='opus'?new Uint8Array(payload):aacAdts(payload,this.format),pts=Math.floor(sample*1000000/this.format.rate);
    if(this.handle<=0||!native.feedAudio(this.handle,frame.buffer as ArrayBuffer,pts)){throw new Error('音频解码输入队列不可用');}
  }
  read():DecodedPcm|undefined{
    if(this.handle<=0){return undefined;}const output=native.readAudio(this.handle);if(!output){return undefined;}
    return new DecodedPcm(new Uint8Array(output.data),Math.round(output.ptsUs*this.format.rate/1000000)>>>0);
  }
  close():void{if(this.handle>0){native.stopAudio(this.handle);this.handle=0;}}
}
