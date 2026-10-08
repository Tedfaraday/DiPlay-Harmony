import { socket } from '@kit.NetworkKit';
import { audio } from '@kit.AudioKit';
import { BusinessError, systemDateTime } from '@kit.BasicServicesKit';
import { NativePairCrypto } from './NativePairCrypto';
import { Plist as P } from './Bplist';
import { TimingClock } from './TimingClock';
import { PcmFormat, AudioPacket, AudioReplayWindow, PcmJitterBuffer, pcmLittleEndian } from './AudioCodec';
import { AudioDecodeBridge } from './AudioDecodeBridge';
import { NativeMicrophone } from './NativeMicrophone';

export class NativeAudioServer {
  readonly type:number;readonly audioType:string;
  private connection:bigint;private format:PcmFormat;private key:Uint8Array;private crypto:NativePairCrypto;
  private report:(message:string)=>void;private remote:string;private replay:AudioReplayWindow=new AudioReplayWindow();
  private pcm:PcmJitterBuffer;private renderer:audio.AudioRenderer|undefined;
  private data:socket.UDPSocket|undefined;private control:socket.UDPSocket|undefined;private closed:boolean=false;
  private chunks:Uint8Array[]=[];private reading:boolean=false;private starting:boolean=false;
  private firstSample:number=0;private origin:number=-1;private packets:number=0;private renderedBytes:number=0;
  private badPackets:number=0;private timer:number=-1;private outputReported:boolean=false;
  private decoder:AudioDecodeBridge|undefined;private decodeTimer:number=-1;
  microphone:NativeMicrophone|undefined;
  private datagrams:number=0;private decodedBytes:number=0;private ticks:number=0;
  constructor(type:number,audioType:string,connection:bigint,format:PcmFormat,key:Uint8Array,crypto:NativePairCrypto,remote:string,report:(message:string)=>void){
    this.type=type;this.audioType=audioType;this.connection=connection;this.format=format;this.key=new Uint8Array(key);this.crypto=crypto;this.remote=remote;this.report=report;this.pcm=new PcmJitterBuffer(format);
  }
  private now():number{return systemDateTime.getUptime(systemDateTime.TimeType.STARTUP,false);}
  private check():void{if(this.closed){throw new Error('音频流已关闭');}}
  async start():Promise<P>{
    this.check();
    try{
      if(this.format.codec==='aac'||this.format.codec==='opus'){this.decoder=new AudioDecodeBridge(this.format);this.decoder.start();
        this.decodeTimer=setInterval(():void=>{if(this.closed){return;}try{
          for(let i=0;i<16;i++){const output=this.decoder?.read();if(!output){break;}this.decodedBytes+=output.pcm.length;this.pcm.push(output.sample,output.pcm);}
        }catch(error){this.fail((error as Error).message);}},10);
      }
      const renderer=await audio.createAudioRenderer({
        streamInfo:{samplingRate:this.format.rate as audio.AudioSamplingRate,channels:this.format.channels as audio.AudioChannel,
          sampleFormat:audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,encodingType:audio.AudioEncodingType.ENCODING_TYPE_RAW},
        rendererInfo:{usage:audio.StreamUsage.STREAM_USAGE_MUSIC,rendererFlags:0}
      });
      if(this.closed){await renderer.release();this.check();}this.renderer=renderer;
      renderer.getCurrentOutputDevices().then((devices:audio.AudioDeviceDescriptors):void=>{
        if(!this.closed){this.report(`音频输出设备类型：${devices.slice(0,4).map((device:audio.AudioDeviceDescriptor):string=>String(device.deviceType)).join(',')}`);}
      }).catch(():void=>{});
      renderer.on('writeData',(buffer:ArrayBuffer):audio.AudioDataCallbackResult=>{
        const output=new Uint8Array(buffer);output.fill(0);
        if(this.closed){return audio.AudioDataCallbackResult.INVALID;}
        this.renderedBytes+=this.pcm.fill(output,this.origin>=0&&this.now()-this.origin>=50);return audio.AudioDataCallbackResult.VALID;
      });
      const data=socket.constructUDPSocketInstance();this.data=data;
      data.on('message',(info:socket.SocketMessageInfo):void=>{
        if(this.closed||info.remoteInfo.address!==this.remote||info.message.byteLength>8192){return;}
        if(++this.datagrams===1){this.report(`音频 UDP 首包到达：流 ${this.type}，${info.message.byteLength} 字节`);}
        if(this.chunks.length>=64){return;}this.chunks.push(new Uint8Array(info.message));
        this.receive().catch((error:Error):void=>{this.fail(error.message);});
      });
      data.on('error',(error:BusinessError):void=>{this.fail(`音频数据错误 ${error.code}`);});
      await data.bind({address:'0.0.0.0',port:0,family:1});if(this.closed){await data.close().catch(():void=>{});this.check();}
      await data.setExtraOptions({receiveBufferSize:512*1024}).catch(():void=>{});this.check();
      const dataPort=(await data.getLocalAddress()).port??0;this.check();
      const control=socket.constructUDPSocketInstance();this.control=control;
      control.on('message',(_info:socket.SocketMessageInfo):void=>{});
      control.on('error',(error:BusinessError):void=>{this.fail(`音频控制错误 ${error.code}`);});
      await control.bind({address:'0.0.0.0',port:0,family:1});if(this.closed){await control.close().catch(():void=>{});this.check();}
      const controlPort=(await control.getLocalAddress()).port??0;this.check();
      if(dataPort<1||controlPort<1||dataPort>65535||controlPort>65535){throw new Error('音频端口无效');}
      this.timer=setInterval(():void=>{
        if(this.closed){return;}
        if(!this.outputReported&&this.renderedBytes>0){this.outputReported=true;this.report(`鸿蒙 AudioRenderer 已提交首段 PCM：流 ${this.type}，${this.format.rate} Hz，${this.format.channels} 声道（听感待确认）`);}
        if(++this.ticks===5||this.ticks%30===0){this.report(`音频阶段计数：流 ${this.type}，UDP=${this.datagrams}，认证=${this.packets}，失败=${this.badPackets}，PCM=${this.decodedBytes} B，提交=${this.renderedBytes} B`);}
      },1000);
      this.report(`AirPlay ${this.format.codec.toUpperCase()} 音频流 ${this.type} 已监听：${this.format.rate} Hz，${this.format.channels} 声道`);
      return P.dict(['type','dataPort','controlPort','streamConnectionID'],[P.int(this.type),P.int(dataPort),P.int(controlPort),P.int(this.connection)]);
    }catch(error){await this.close();throw new Error((error as Error).message);}
  }
  private async receive():Promise<void>{
    if(this.reading){return;}this.reading=true;
    try{while(!this.closed&&this.chunks.length>0){
      const wire=this.chunks.shift();if(!wire){break;}
      let packet:AudioPacket,plain:Uint8Array;
      try{
        packet=new AudioPacket(wire);if(!this.replay.accepts(packet.counter)){continue;}
        plain=await this.crypto.open(this.key,packet.nonce,packet.sealed,packet.aad);
      }catch(_error){if(!this.closed&&++this.badPackets===1){this.report(`AirPlay 音频流 ${this.type} 丢弃格式或认证失败的数据包`);}continue;}
      if(this.closed){plain.fill(0);return;}
      this.replay.commit(packet.counter);
      try{
        if(this.decoder){this.decoder.feed(plain,packet.sample);}
        else{this.decodedBytes+=plain.length;this.pcm.push(packet.sample,pcmLittleEndian(plain,this.format.channels));}
      }finally{plain.fill(0);}this.packets++;
      if(this.origin<0){this.origin=this.now();this.firstSample=packet.sample;this.report(`AirPlay 音频流 ${this.type} 首包已认证、解密`);this.microphone?.start().catch(():void=>{});}
      if(!this.starting&&this.renderer){
        this.starting=true;const renderer=this.renderer;await renderer.start();
        if(this.closed){await renderer.stop().catch(():void=>{});await renderer.release().catch(():void=>{});return;}
        this.report(`鸿蒙 AudioRenderer 已启动：流 ${this.type}`);
      }
    }}finally{this.reading=false;}
  }
  feedback(clock:TimingClock):P{
    if(this.origin<0){return P.dict(['type','sampleRate'],[P.int(this.type),P.int(this.format.rate)]);}
    const now=this.now(),sample=(this.firstSample+Math.floor(Math.max(0,now-this.origin-30)*this.format.rate/1000))>>>0;
    return P.dict(['type','sampleRate','streamConnectionID','timestamp','timestampRawNs','sampleTime'],
      [P.int(this.type),P.int(this.format.rate),P.int(this.connection),P.int(clock.ntp()),P.int(BigInt(Math.floor(now*1000000))),P.int(sample)]);
  }
  private fail(message:string):void{if(!this.closed){this.report(`AirPlay 音频停止：${message}`);this.close().catch(():void=>{});}}
  async close():Promise<void>{
    if(this.closed){return;}this.closed=true;this.key.fill(0);this.chunks=[];this.pcm.clear();
    const microphone=this.microphone;this.microphone=undefined;if(microphone){await microphone.close();}
    if(this.timer>=0){clearInterval(this.timer);this.timer=-1;}
    if(this.decodeTimer>=0){clearInterval(this.decodeTimer);this.decodeTimer=-1;}this.decoder?.close();this.decoder=undefined;
    const data=this.data,control=this.control,renderer=this.renderer;this.data=undefined;this.control=undefined;this.renderer=undefined;
    if(data){await data.close().catch(():void=>{});}if(control){await control.close().catch(():void=>{});}
    if(renderer){renderer.off('writeData');await renderer.stop().catch(():void=>{});await renderer.release().catch(():void=>{});}
  }
}
