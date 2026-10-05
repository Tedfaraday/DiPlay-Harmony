import { socket } from '@kit.NetworkKit';
import { systemDateTime, BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { NativePairCrypto } from './NativePairCrypto';
import { ControlCipher } from './ControlCipher';
import { ascii, concat } from './PairingCore';
import { TimingClock } from './TimingClock';
import { RtspProbe } from './RtspProbe';
import { Plist, encodePlist } from './Bplist';
import { touchCommand } from './HidTouch';
import { DisplayProfile } from './DisplayProfile';

export class SessionResources {
  private profile:DisplayProfile;
  clock:TimingClock=new TimingClock(():number=>systemDateTime.getUptime(systemDateTime.TimeType.STARTUP,false));
  private timing:socket.UDPSocket|undefined;private keepAlive:socket.UDPSocket|undefined;
  private eventServer:socket.TCPSocketServer|undefined;private eventClient:socket.TCPSocketConnection|undefined;
  private eventCipher:ControlCipher|undefined;private eventParser:RtspProbe=new RtspProbe(true);
  private timer:number=-1;private closed:boolean=false;private report:(message:string)=>void;
  private eventChunks:Uint8Array[]=[];private reading:boolean=false;private queuedBytes:number=0;
  private writing:Promise<void>=Promise.resolve();private pendingWrites:number=0;private cseq:number=0;
  private touchSent:boolean=false;private responseSeen:boolean=false;
  private contactDown:boolean=false;private lastTouch:number=0;
  constructor(report:(message:string)=>void,profile:DisplayProfile=new DisplayProfile()){this.report=report;this.profile=profile;}
  async start(remote:socket.NetAddress,peerPort:number,lowPower:boolean,shared:Uint8Array,crypto:NativePairCrypto,iap:boolean=false):Promise<Plist>{
    if(this.closed){throw new Error('会话资源已关闭');}
    const read=await crypto.hkdf(shared,ascii('Events-Salt'),ascii('Events-Read-Encryption-Key'));
    const write=await crypto.hkdf(shared,ascii('Events-Salt'),ascii('Events-Write-Encryption-Key'));
    this.eventCipher=new ControlCipher(crypto,read,write);read.fill(0);write.fill(0);
    if(this.closed){this.eventCipher.dispose();throw new Error('会话资源已关闭');}
    const timing=socket.constructUDPSocketInstance();this.timing=timing;
    timing.on('message',(message:socket.SocketMessageInfo):void=>{
      if(this.closed||message.remoteInfo.address!==remote.address||(peerPort>0&&message.remoteInfo.port!==peerPort)){return;}
      const wasSynced=this.clock.synced,response=this.clock.handle(new Uint8Array(message.message));
      if(response){timing.send({data:response.buffer as ArrayBuffer,address:{address:message.remoteInfo.address,port:message.remoteInfo.port,family:1}}).catch(():void=>{});}
      if(!wasSynced&&this.clock.synced){this.report('AirPlay 时钟双向同步已完成');}
    });
    timing.on('error',(error:BusinessError):void=>{if(!this.closed){this.report(`AirPlay 时钟错误 ${error.code}`);}});
    await timing.bind({address:'0.0.0.0',port:0,family:1});
    if(this.closed){await timing.close().catch(():void=>{});throw new Error('会话资源已关闭');}
    const timingAddress=await timing.getLocalAddress();
    if(this.closed){throw new Error('会话资源已关闭');}
    if(peerPort>0&&peerPort<=65535){
      const send=():void=>{if(this.closed){return;}timing.send({data:this.clock.request().buffer as ArrayBuffer,address:{address:remote.address,port:peerPort,family:1}}).catch(():void=>{});};
      this.timer=setInterval(send,1000);send();
    }
    const server=socket.constructTCPSocketServerInstance();this.eventServer=server;
    server.on('connect',(client:socket.TCPSocketConnection):void=>{
      if(this.closed||this.eventClient){client.close().catch(():void=>{});return;}
      this.eventClient=client;this.report('AirPlay 加密事件连接已到达');
      client.on('message',(message:socket.SocketMessageInfo):void=>{
        if(this.closed){return;}
        if(this.eventChunks.length>=8||this.queuedBytes+message.message.byteLength>81920){this.close().catch(():void=>{});return;}
        const chunk=new Uint8Array(message.message);this.eventChunks.push(chunk);this.queuedBytes+=chunk.length;
        this.receive(client).catch(():void=>{this.report('AirPlay 事件通道认证或解析失败');this.close().catch(():void=>{});});
      });
      client.on('error',(_error:BusinessError):void=>{this.close().catch(():void=>{});});
      client.on('close',():void=>{this.close().catch(():void=>{});});
    });
    server.on('error',(error:BusinessError):void=>{if(!this.closed){this.report(`AirPlay 事件监听错误 ${error.code}`);}});
    await server.listen({address:'0.0.0.0',port:0,family:1});
    if(this.closed){await server.close().catch(():void=>{});throw new Error('会话资源已关闭');}const eventAddress=await server.getLocalAddress();
    if(this.closed){throw new Error('会话资源已关闭');}
    const features=iap?[Plist.str('iAPChannel'),Plist.str('viewAreas')]:[Plist.str('viewAreas')];
    const keys=['timingPort','eventPort','enabledFeatures'],values=[Plist.int(timingAddress.port),Plist.int(eventAddress.port),Plist.array(features)];
    if(lowPower){const keep=socket.constructUDPSocketInstance();this.keepAlive=keep;keep.on('message',(_message:socket.SocketMessageInfo):void=>{});keep.on('error',(_error:BusinessError):void=>{});
      await keep.bind({address:'0.0.0.0',port:0,family:1});if(this.closed){await keep.close().catch(():void=>{});throw new Error('会话资源已关闭');}keys.push('keepAlivePort');values.push(Plist.int((await keep.getLocalAddress()).port));}
    if(this.closed){throw new Error('会话资源已关闭');}
    this.report(`AirPlay 会话端口已准备：时钟 ${timingAddress.port}，事件 ${eventAddress.port}`);return Plist.dict(keys,values);
  }
  private async receive(client:socket.TCPSocketConnection):Promise<void>{
    if(this.reading){return;}this.reading=true;
    try{while(this.eventChunks.length>0&&!this.closed&&this.eventCipher){
      const chunk=this.eventChunks.shift();if(!chunk){break;}this.queuedBytes-=chunk.length;
      const plain=await this.eventCipher.feed(chunk);if(this.closed){return;}const messages=this.eventParser.feed(plain);
      for(let i=0;i<messages.length;i++){
        const message=messages[i];if(message.method==='RESPONSE'){
          if(!this.responseSeen){this.responseSeen=true;this.report(`AirPlay 事件命令获手机应答 ${message.path}`);}continue;
        }
        const response=`${message.protocol} 200 OK\r\nCSeq: ${message.cseq}\r\nContent-Length: 0\r\n\r\n`;
        await this.write(new util.TextEncoder().encodeInto(response));this.report(`AirPlay 事件请求 ${message.method} 已应答`);
      }
    }}finally{this.reading=false;}
  }
  async touch(x:number,y:number,down:boolean):Promise<void>{
    if(this.closed||!this.eventClient){return;}
    const now=Date.now();if(down&&this.contactDown&&now-this.lastTouch<16){return;}this.contactDown=down;this.lastTouch=now;
    const body=encodePlist(touchCommand(x,y,down,this.profile));
    const head=`POST /command RTSP/1.0\r\nContent-Type: application/x-apple-binary-plist\r\nContent-Length: ${body.length}\r\nCSeq: ${++this.cseq}\r\n\r\n`;
    await this.write(concat([new util.TextEncoder().encodeInto(head),body]),!down);
    if(!this.touchSent){this.touchSent=true;this.report('AirPlay 首个触控 HID 报告已发送');}
  }
  async iap(bytes:Uint8Array):Promise<void>{
    if(bytes.length<1||bytes.length>65535){throw new Error('iAP event size invalid');}
    const body=encodePlist(Plist.dict(['type','params'],[Plist.str('iAPSendMessage'),Plist.dict(['data'],[Plist.bytes(bytes)])]));
    const head=`POST /command RTSP/1.0\r\nContent-Type: application/x-apple-binary-plist\r\nContent-Length: ${body.length}\r\nCSeq: ${++this.cseq}\r\n\r\n`;
    await this.write(concat([new util.TextEncoder().encodeInto(head),body]));
  }
  private write(bytes:Uint8Array,release:boolean=false):Promise<void>{
    if(this.pendingWrites>=(release?34:32)){return Promise.reject(new Error('事件发送队列超限'));}this.pendingWrites++;
    const pending=this.writing.catch(():void=>{}).then(async():Promise<void>=>{
      const client=this.eventClient,cipher=this.eventCipher;if(this.closed||!client||!cipher){throw new Error('事件通道已关闭');}
      const wire=await cipher.seal(bytes);if(this.closed){throw new Error('事件通道已关闭');}await client.send({data:wire.buffer as ArrayBuffer});
    }).finally(():void=>{this.pendingWrites--;});
    this.writing=pending;return pending;
  }
  async close():Promise<void>{
    if(this.closed){return;}this.closed=true;if(this.timer>=0){clearInterval(this.timer);this.timer=-1;}
    this.eventCipher?.dispose();this.eventChunks=[];this.queuedBytes=0;
    const timing=this.timing,keep=this.keepAlive,server=this.eventServer,client=this.eventClient;
    this.timing=undefined;this.keepAlive=undefined;this.eventServer=undefined;this.eventClient=undefined;
    if(client){await client.close().catch(():void=>{});}if(server){await server.close().catch(():void=>{});}
    if(timing){await timing.close().catch(():void=>{});}if(keep){await keep.close().catch(():void=>{});}
  }
}
