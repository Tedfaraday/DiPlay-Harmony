// GPL-3.0-only. Encrypted APTransportPackage/iAP2 transport adapted from DiPlay.
import { socket } from '@kit.NetworkKit';
import { systemDateTime, BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { NativePairCrypto } from './NativePairCrypto';
import { ControlCipher } from './ControlCipher';
import { IapPackages } from './IapPackages';
import { TunnelControl } from './TunnelControl';
import { ExperimentalAuth } from './ExperimentalAuth';
import { WirelessSettings } from './WirelessControl';
import { SessionResources } from './SessionResources';
export class NativeIapTunnel {
  private server:socket.TCPSocketServer|undefined;private client:socket.TCPSocketConnection|undefined;
  private cipher:ControlCipher;private packages:IapPackages=new IapPackages();private runtime:TunnelControl;
  private closed:boolean=false;private reading:boolean=false;private verified:Promise<void>=Promise.resolve();
  private chunks:Uint8Array[]=[];private queuedBytes:number=0;private timer:number=-1;private ticking:boolean=false;
  private remote:string;private report:(message:string)=>void;private ended:()=>void;
  constructor(key:Uint8Array,crypto:NativePairCrypto,remote:string,resources:SessionResources,auth:ExperimentalAuth,
    settings:WirelessSettings,mac:string,publicKey:string,serial:string,report:(message:string)=>void,ready:()=>void,ended:()=>void){
    this.cipher=new ControlCipher(crypto,key,new Uint8Array(32));this.remote=remote;this.report=report;this.ended=ended;
    this.runtime=new TunnelControl(auth,settings,mac,publicKey,serial,
      ():number=>systemDateTime.getUptime(systemDateTime.TimeType.STARTUP,false),
      (text:string):Uint8Array=>new util.TextEncoder().encodeInto(text),
      (bytes:Uint8Array):Promise<void>=>resources.iap(bytes),report,ready);
  }
  async start():Promise<number>{
    if(this.closed){throw new Error('iAP 隧道已关闭');}const server=socket.constructTCPSocketServerInstance();this.server=server;
    server.on('connect',(client:socket.TCPSocketConnection):void=>{
      if(this.closed||this.client){client.close().catch(():void=>{});return;}this.client=client;
      this.verified=this.verifyClient(client);this.verified.catch(():void=>{this.fail();});
      client.on('message',(info:socket.SocketMessageInfo):void=>{
        if(this.closed){return;}if(this.chunks.length>=16||this.queuedBytes+info.message.byteLength>1048576){this.fail();return;}
        const chunk=new Uint8Array(info.message);this.chunks.push(chunk);this.queuedBytes+=chunk.length;
        this.receive().catch(():void=>{this.fail();});
      });
      client.on('error',(_error:BusinessError):void=>{this.fail();});client.on('close',():void=>{this.fail();});
    });
    server.on('error',(_error:BusinessError):void=>{this.fail();});
    try{await server.listen({address:'0.0.0.0',port:0,family:1});if(this.closed){await server.close().catch(():void=>{});throw new Error('iAP 隧道已关闭');}
      const local=await server.getLocalAddress();if(this.closed){throw new Error('iAP 隧道已关闭');}
      const port=local.port??0;if(port<1||port>65535){throw new Error('iAP 隧道端口无效');}this.report(`AirPlay iAP2 数据端口 ${port} 已监听`);return port;
    }catch(error){await this.close();throw new Error((error as Error).message);}
  }
  private async verifyClient(client:socket.TCPSocketConnection):Promise<void>{
    const remote=await client.getRemoteAddress();if(this.closed){return;}
    if(remote.address!==this.remote){throw new Error('iAP peer mismatch');}
    this.report('AirPlay iAP2 数据连接已到达');await this.runtime.start();if(this.closed){return;}
    this.timer=setInterval(():void=>{if(this.closed||this.ticking){return;}this.ticking=true;
      this.runtime.advance().catch(():void=>{this.fail();}).finally(():void=>{this.ticking=false;});},50);
  }
  private async receive():Promise<void>{
    if(this.reading){return;}this.reading=true;
    try{await this.verified;while(this.chunks.length>0&&!this.closed){
      const chunk=this.chunks.shift();if(!chunk){break;}this.queuedBytes-=chunk.length;
      const plain=await this.cipher.feed(chunk);if(this.closed){plain.fill(0);return;}
      const bodies=this.packages.feed(plain);plain.fill(0);
      for(let i=0;i<bodies.length;i++){if(this.closed){return;}await this.runtime.feed(bodies[i]);bodies[i].fill(0);}
    }}finally{this.reading=false;}
  }
  private fail():void{if(this.closed){return;}this.report('AirPlay iAP2 隧道停止：连接、认证或协议检查失败');this.close().catch(():void=>{});this.ended();}
  async close():Promise<void>{
    if(this.closed){return;}this.closed=true;this.runtime.close();this.cipher.dispose();this.packages.clear();
    this.chunks.forEach((chunk:Uint8Array):void=>{chunk.fill(0);});this.chunks=[];this.queuedBytes=0;
    if(this.timer>=0){clearInterval(this.timer);this.timer=-1;}const client=this.client,server=this.server;this.client=undefined;this.server=undefined;
    if(client){await client.close().catch(():void=>{});}if(server){await server.close().catch(():void=>{});}
  }
}
