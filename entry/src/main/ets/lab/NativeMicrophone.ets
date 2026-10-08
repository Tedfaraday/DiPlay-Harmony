import { audio } from '@kit.AudioKit';
import { socket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { PcmFormat, pcmFormat } from './AudioCodec';
import { NativePairCrypto } from './NativePairCrypto';
import { MicrophonePacketizer } from './MicrophonePacket';

function options(rate:number):audio.AudioCapturerOptions{
  return {streamInfo:{samplingRate:rate as audio.AudioSamplingRate,channels:audio.AudioChannel.CHANNEL_1,
    sampleFormat:audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,encodingType:audio.AudioEncodingType.ENCODING_TYPE_RAW},
    capturerInfo:{source:audio.SourceType.SOURCE_TYPE_MIC,capturerFlags:0}};
}
// Permission is obtained explicitly in Settings. Probe creation only: never start recording here.
export async function probeMicrophone(cancelled:()=>boolean):Promise<number>{
  let mask=0;const bits=[4,16,64,256,16384];
  for(let i=0;i<bits.length;i++){
    if(cancelled()){return 0;}let capturer:audio.AudioCapturer|undefined;
    try{
      const rate=pcmFormat(bits[i]).rate;capturer=await audio.createAudioCapturer(options(rate));
      const actual=await capturer.getStreamInfo();
      if(actual.samplingRate===rate&&actual.channels===audio.AudioChannel.CHANNEL_1&&actual.sampleFormat===audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE){mask|=bits[i];}
    }catch(_error){}finally{if(capturer){await capturer.release().catch(():void=>{});}}
  }
  return cancelled()?0:mask;
}

export class NativeMicrophone {
  private key:Uint8Array;private format:PcmFormat;private crypto:NativePairCrypto;
  private host:string;private port:number;private report:(message:string)=>void;
  private capturer:audio.AudioCapturer|undefined;private udp:socket.UDPSocket|undefined;
  private closed:boolean=false;private active:boolean=false;private sending:boolean=false;
  private packetizer:MicrophonePacketizer=new MicrophonePacketizer();
  private queue:Uint8Array[]=[];private frame:Uint8Array;private filled:number=0;private packets:number=0;
  constructor(format:PcmFormat,key:Uint8Array,crypto:NativePairCrypto,host:string,port:number,frames:number,report:(message:string)=>void){
    if(format.codec!=='pcm'||format.channels!==1||port<1||port>65535){throw new Error('麦克风协商参数无效');}
    if(frames===0){frames=Math.floor(format.rate/50);}
    if(!Number.isInteger(frames)||frames<Math.ceil(format.rate*0.005)||frames>Math.floor(format.rate*0.06)){throw new Error('麦克风分包长度无效');}
    this.format=format;this.key=new Uint8Array(key);this.crypto=crypto;this.host=host;this.port=port;this.report=report;this.frame=new Uint8Array(frames*2);
  }
  async start():Promise<void>{
    if(this.closed||this.active){return;}this.active=true;
    try{
      const capturer=await audio.createAudioCapturer(options(this.format.rate));
      if(this.closed){await capturer.release();return;}this.capturer=capturer;
      const actual=await capturer.getStreamInfo();
      if(this.closed){return;}
      if(actual.samplingRate!==this.format.rate||actual.channels!==1||actual.sampleFormat!==audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE){throw new Error('麦克风实际格式与协商不符');}
      const udp=socket.constructUDPSocketInstance();this.udp=udp;
      udp.on('error',(_error:BusinessError):void=>{this.fail();});
      await udp.bind({address:'0.0.0.0',port:0,family:1});
      if(this.closed){await udp.close().catch(():void=>{});return;}
      capturer.on('readData',(buffer:ArrayBuffer):void=>{this.read(new Uint8Array(buffer));});
      await capturer.start();
      if(this.closed){await capturer.stop().catch(():void=>{});return;}
      this.report(`麦克风已按手机请求启动：PCM ${this.format.rate} Hz 单声道；仅回传当前配对手机`);
    }catch(_error){this.fail();}
  }
  private read(bytes:Uint8Array):void{
    if(this.closed){return;}if(bytes.length%2!==0||bytes.length>192000){this.fail();return;}
    let offset=0;
    while(offset<bytes.length){
      const size=Math.min(this.frame.length-this.filled,bytes.length-offset);
      this.frame.set(bytes.subarray(offset,offset+size),this.filled);this.filled+=size;offset+=size;
      if(this.filled===this.frame.length){
        // Fail rather than grow an unbounded queue or transmit stale captured speech.
        if(this.queue.length>=8){this.fail();return;}
        this.queue.push(this.frame);this.frame=new Uint8Array(this.frame.length);this.filled=0;
      }
    }
    this.send().catch(():void=>{this.fail();});
  }
  private async send():Promise<void>{
    if(this.sending){return;}this.sending=true;
    try{while(!this.closed&&this.queue.length>0){
      const frame=this.queue.shift();if(!frame){break;}let wire:Uint8Array;
      try{wire=await this.packetizer.packet(frame,this.key,this.crypto);}finally{frame.fill(0);}
      if(this.closed){wire.fill(0);return;}const udp=this.udp;if(!udp){wire.fill(0);return;}
      try{await udp.send({data:wire.buffer as ArrayBuffer,address:{address:this.host,port:this.port,family:1}});}
      finally{wire.fill(0);}
      if(!this.closed&&++this.packets===1){this.report('麦克风首个加密 PCM 数据包已发送；不保存录音');}
    }}finally{this.sending=false;}
  }
  private fail():void{if(!this.closed){this.report('麦克风回传停止：初始化、采集或发送失败；音频输出继续');this.close().catch(():void=>{});}}
  async close():Promise<void>{
    if(this.closed){return;}this.closed=true;this.key.fill(0);this.frame.fill(0);this.queue.forEach((frame:Uint8Array):void=>{frame.fill(0);});this.queue=[];
    const capturer=this.capturer,udp=this.udp;this.capturer=undefined;this.udp=undefined;
    if(capturer){try{capturer.off('readData');}catch(_error){}await capturer.stop().catch(():void=>{});await capturer.release().catch(():void=>{});}
    if(udp){await udp.close().catch(():void=>{});}
  }
}
