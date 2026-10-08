import { socket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { NativePairCrypto } from './NativePairCrypto';
import { ScreenParser, ScreenReceiveQueue, h264Configuration, annexB, screenNonce } from './ScreenCodec';
import { VideoBridge } from './VideoBridge';
import { DisplayProfile } from './DisplayProfile';

export class NativeScreenServer {
  private profile:DisplayProfile;
  private server:socket.TCPSocketServer|undefined;private client:socket.TCPSocketConnection|undefined;
  private parser:ScreenParser=new ScreenParser();private key:Uint8Array;private crypto:NativePairCrypto;
  private closed:boolean=false;private counter:bigint=BigInt(0);private owner:number=0;private configured:boolean=false;
  private chunks:ScreenReceiveQueue=new ScreenReceiveQueue();private reading:boolean=false;private frames:number=0;
  private report:(message:string)=>void;private timer:number=-1;private rendered:boolean=false;
  private metadataSeen:boolean=false;
  private onRendered:()=>void;private onEnded:()=>void;
  constructor(key:Uint8Array,crypto:NativePairCrypto,report:(message:string)=>void,onRendered:()=>void=():void=>{},onEnded:()=>void=():void=>{},profile:DisplayProfile=new DisplayProfile()){
    this.key=new Uint8Array(key);this.crypto=crypto;this.report=report;this.profile=profile;this.onRendered=onRendered;this.onEnded=onEnded;}
  async start():Promise<number>{
    if(this.closed){throw new Error('视频流已关闭');}this.owner=VideoBridge.instance.claim(this.profile);
    const server=socket.constructTCPSocketServerInstance();this.server=server;
    server.on('connect',(client:socket.TCPSocketConnection):void=>{
      if(this.closed||this.client){client.close().catch(():void=>{});return;}this.client=client;this.report('AirPlay 屏幕数据连接已到达');
      client.on('message',(message:socket.SocketMessageInfo):void=>{
        if(this.closed){return;}
        try{
          this.chunks.push(new Uint8Array(message.message));
          this.receive().catch((error:Error):void=>{this.fail(error.message);});
        }catch(error){this.fail((error as Error).message);}
      });
      client.on('error',(_error:BusinessError):void=>{this.fail('屏幕数据连接错误');});
      client.on('close',():void=>{if(!this.closed){this.report('AirPlay 屏幕数据连接关闭');this.close().catch(():void=>{});this.onEnded();}});
    });
    server.on('error',(error:BusinessError):void=>{if(!this.closed){this.fail(`屏幕监听错误 ${error.code}`);}});
    try{
      await server.listen({address:'0.0.0.0',port:0,family:1});if(this.closed){await server.close().catch(():void=>{});throw new Error('视频流已关闭');}
      const address=await server.getLocalAddress();if(this.closed){throw new Error('视频流已关闭');}
      const port=address.port??0;if(port<1||port>65535){throw new Error('视频数据端口无效');}
      this.timer=setInterval(():void=>{
        if(this.closed){return;}const stats=VideoBridge.instance.stats(this.owner);
        if(stats[2]!==0){this.fail(`原生解码错误 ${stats[2]}`);}
        else if(!this.rendered&&stats[1]>0){if(stats.length>=6&&stats[4]>0&&stats[5]>0){
          this.report(`手机实际视频 ${stats[4]}×${stats[5]}；协商 ${this.profile.width}×${this.profile.height}`);
          if(Math.abs(stats[4]/stats[5]-this.profile.width/this.profile.height)>0.01){this.fail('手机返回的视频比例与协商不一致，请断开后重连');return;}
        }
        this.rendered=true;this.report('鸿蒙原生解码器已输出首帧画面');this.onRendered();}
      },1000);
      this.report(`AirPlay H.264 数据端口 ${port} 已监听`);return port;
    }catch(error){await this.close();throw new Error((error as Error).message);}
  }
  private async receive():Promise<void>{
    if(this.reading){return;}this.reading=true;
    try{
      while(this.chunks.size>0&&!this.closed){
        let chunk=this.chunks.take();if(!chunk){break;}
        let more=true;
        while(more&&!this.closed){
          const packets=this.parser.feed(chunk);more=packets.length===64;chunk=new Uint8Array(0);
          for(let i=0;i<packets.length;i++){
            const packet=packets[i],opcode=packet.header[4];
            if(opcode===1){
              const config=h264Configuration(packet.body);VideoBridge.instance.feed(this.owner,config,true,0);this.configured=true;
              this.report('AirPlay H.264 SPS/PPS 已提交给原生解码器');
            }else if(opcode===0){
              if(!this.configured||packet.body.length<16){throw new Error('视频帧缺少配置或认证标签');}
              const plain=await this.crypto.open(this.key,screenNonce(this.counter),packet.body,packet.header);
              if(this.closed){plain.fill(0);return;}this.counter++;
              const frame=annexB(plain);VideoBridge.instance.feed(this.owner,frame,false,Math.floor(this.frames*1000000/30));this.frames++;
              if(this.frames===1){this.report('AirPlay 首个视频帧已认证、解密并提交解码');}
            }else if(!this.metadataSeen){this.metadataSeen=true;this.report(`AirPlay 屏幕元数据类型 ${opcode} 已跳过，继续接收视频`);}
          }
        }
      }
    }finally{this.reading=false;}
  }
  private fail(message:string):void{if(this.closed){return;}this.report(`AirPlay 视频停止：${message}`);this.close().catch(():void=>{});this.onEnded();}
  async close():Promise<void>{
    if(this.closed){return;}this.closed=true;if(this.timer>=0){clearInterval(this.timer);this.timer=-1;}
    this.key.fill(0);this.parser.clear();this.chunks.clear();VideoBridge.instance.release(this.owner);this.owner=0;
    const client=this.client,server=this.server;this.client=undefined;this.server=undefined;
    if(client){await client.close().catch(():void=>{});}if(server){await server.close().catch(():void=>{});}
  }
}
