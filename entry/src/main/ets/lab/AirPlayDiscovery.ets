// GPL-3.0-only. Publication/control probe follow DiPlay CarPlayBonjour.kt.
import { mdns, socket } from '@kit.NetworkKit';
import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { ReceiverIdentity } from './ReceiverIdentity';
import { receiverTxtRecords } from './ReceiverInfo';
import { HotspotMdns } from './HotspotMdns';

export class AirPlayDiscovery {
  private context:common.UIAbilityContext;private report:(message:string)=>void;private deviceId:string;
  private localAddress:string;
  private hotspot:HotspotMdns|undefined;
  private service:mdns.LocalServiceInfo|undefined;private discovery:mdns.DiscoveryService|undefined;
  private closed:boolean=false;private peer:string='';private candidates:mdns.LocalServiceInfo[]=[];
  private probing:Set<string>=new Set<string>();private clients:Map<socket.TCPSocket,number>=new Map<socket.TCPSocket,number>();
  constructor(context:common.UIAbilityContext,deviceId:string,report:(message:string)=>void,localAddress:string=''){this.context=context;this.deviceId=deviceId;this.report=report;this.localAddress=localAddress;}
  async start(identity:ReceiverIdentity):Promise<void>{
    if(this.closed){throw new Error('服务发现已关闭');}
    const key=identity.keys.pubKey.getEncoded().data.slice(12);let hex='';for(let i=0;i<key.length;i++){hex+=key[i].toString(16).padStart(2,'0');}
    if(this.localAddress){
      const hotspot=new HotspotMdns(this.localAddress,this.deviceId,this.report,(address:string,port:number):void=>{
        if(this.closed||this.candidates.length>=16){return;}this.candidates.push({serviceType:'_carplay-ctrl._tcp',serviceName:'authenticated-phone',host:{address,family:1,port:0},port});this.probeCandidates();
      });
      try{hotspot.start(identity);this.hotspot=hotspot;}
      catch(error){
        hotspot.close();const detail=/^Hotspot mDNS (interface|socket|options|bind|membership|send|receive) error (\d{1,4})$/.exec((error as Error).message);
        this.report('热点接口 mDNS 启动失败'+(detail?`：${detail[1]} ${detail[2]}`:'')+'，继续使用系统服务发现');
      }
    }
    if(!this.hotspot){
      const attributes:mdns.ServiceAttribute[]=[];receiverTxtRecords(this.deviceId,identity.pairingId,hex).forEach((value:string,name:string):void=>{
        attributes.push({key:name,value:Array.from(new util.TextEncoder().encodeInto(value))});
      });
      const service=await mdns.addLocalService(this.context,{serviceType:'_airplay._tcp',serviceName:'DiPlay Harmony',port:7000,serviceAttribute:attributes});
      if(this.closed){await mdns.removeLocalService(this.context,service).catch(():void=>{});return;}
      this.service=service;this.report('AirPlay 服务已注册，音频功能位与 /info 一致；热点可发现性待验证');
    }
    const discovery=mdns.createDiscoveryService(this.context,'_carplay-ctrl._tcp');this.discovery=discovery;
    discovery.on('serviceFound',(info:mdns.LocalServiceInfo):void=>{
      if(this.closed||this.candidates.length>=16){return;}
      mdns.resolveLocalService(this.context,info).then((resolved:mdns.LocalServiceInfo):void=>{
        if(this.closed||this.candidates.length>=16){return;}this.candidates.push(resolved);this.probeCandidates();
      }).catch((_error:BusinessError):void=>{if(!this.closed){this.report('CarPlay 控制服务解析失败');}});
    });
    discovery.startSearchingMDNS();this.report('已开始发现 iPhone CarPlay 控制服务');
  }
  approvePeer(address:string):void{this.peer=address;this.hotspot?.approvePeer(address);this.probeCandidates();}
  private probeCandidates():void{
    if(this.closed||!this.peer){return;}
    for(let i=0;i<this.candidates.length;i++){
      const info=this.candidates[i],host=info.host,port=info.port??0;
      if(!host||host.address!==this.peer||port<1||port>65535){continue;}
      const target=host.address+':'+port;if(this.probing.has(target)||this.clients.size>=4){continue;}this.probing.add(target);
      this.probe(host.address,port).catch(():void=>{if(!this.closed){this.report('CarPlay 控制入口连接未完成');}});
    }
  }
  private async probe(address:string,port:number):Promise<void>{
    if(this.closed){return;}const client=socket.constructTCPSocketInstance();let response='',done=false;
    const finish=():void=>{const timer=this.clients.get(client);if(timer!==undefined){clearTimeout(timer);}this.clients.delete(client);};
    const timer=setTimeout(():void=>{finish();client.close().catch(():void=>{});},5000);this.clients.set(client,timer);
    client.on('close',finish);client.on('error',(_error:BusinessError):void=>{finish();client.close().catch(():void=>{});});
    client.on('message',(info:socket.SocketMessageInfo):void=>{
      if(this.closed||done){return;}if(response.length+info.message.byteLength>4096){done=true;finish();client.close().catch(():void=>{});return;}
      response+=util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(info.message));
      const match=/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(response);
      if(match){done=true;this.report(`CarPlay 控制入口连接响应 ${match[1]}`);finish();client.close().catch(():void=>{});}
    });
    try{
      await client.bind({address:this.localAddress||'0.0.0.0',port:0,family:1});if(this.closed){return;}
      await client.connect({address:{address,port,family:1},timeout:4000});if(this.closed){return;}
      const request=`GET /ctrl-int/1/connect HTTP/1.1\r\nHost: ${address}:${port}\r\nUser-Agent: AirPlay/950.7.1\r\nAirPlay-Receiver-Device-ID: ${this.deviceId.replace(/:/g,'')}\r\nConnection: close\r\n\r\n`;
      await client.send({data:new util.TextEncoder().encodeInto(request).buffer as ArrayBuffer});
    }catch(_error){finish();await client.close().catch(():void=>{});throw new Error('控制服务连接失败');}
    finally{if(this.closed){finish();await client.close().catch(():void=>{});}}
  }
  async close():Promise<void>{
    if(this.closed){return;}this.closed=true;this.candidates=[];
    this.hotspot?.close();this.hotspot=undefined;
    const discovery=this.discovery;this.discovery=undefined;
    if(discovery){discovery.off('serviceFound');try{discovery.stopSearchingMDNS();}catch(_error){}}
    const clients=Array.from(this.clients.keys());for(let i=0;i<clients.length;i++){
      const timer=this.clients.get(clients[i]);if(timer!==undefined){clearTimeout(timer);}await clients[i].close().catch(():void=>{});
    }this.clients.clear();
    const service=this.service;this.service=undefined;if(service){await mdns.removeLocalService(this.context,service).catch(():void=>{});}
  }
}

