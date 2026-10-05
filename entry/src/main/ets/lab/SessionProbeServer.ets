import { socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { RtspProbe, RtspRequest } from './RtspProbe';
import { PairSetup, concat, ascii } from './PairingCore';
import { NativePairCrypto } from './NativePairCrypto';
import { ReceiverIdentity } from './ReceiverIdentity';
import { PairingStore } from './PairingStore';
import { PairVerify } from './PairVerify';
import { ControlCipher } from './ControlCipher';
import { mfiSap } from './MfiSap';
import { ExperimentalAuth } from './ExperimentalAuth';
import { Plist, decodePlist, encodePlist } from './Bplist';
import { receiverInfo } from './ReceiverInfo';
import { DisplayProfile } from './DisplayProfile';
import { SessionResources } from './SessionResources';
import { NativeScreenServer } from './NativeScreenServer';
import { NativeAudioServer } from './NativeAudioServer';
import { pcmFormat } from './AudioCodec';
import { AirPlayDiscovery } from './AirPlayDiscovery';
import { modeSummary } from './ModeDiagnostics';
import { probeOpus } from './CodecCapability';
import { NativeIapTunnel } from './NativeIapTunnel';
import { IAP_DATASTREAM_UUID } from './IapPackages';
import { WirelessSettings } from './WirelessControl';

class SessionPeer {
  client:socket.TCPSocketConnection;
  parser:RtspProbe=new RtspProbe();
  timer:number=-1;closed:boolean=false;working:boolean=false;
  queue:RtspRequest[]=[];pairing:PairSetup|undefined;
  verify:PairVerify|undefined;cipher:ControlCipher|undefined;crypto:NativePairCrypto|undefined;
  chunks:Uint8Array[]=[];reading:boolean=false;queuedBytes:number=0;authenticated:boolean=false;
  resources:SessionResources|undefined;bluetoothAddress:string='';
  screen:NativeScreenServer|undefined;display:DisplayProfile=new DisplayProfile();
  audio:NativeAudioServer[]=[];remoteAddress:string='';
  tunnel:NativeIapTunnel|undefined;wireless:WirelessSettings|undefined;publicKey:string='';serial:string='';
  constructor(client:socket.TCPSocketConnection){this.client=client;}
}

export class SessionProbeServer {
  private server:socket.TCPSocketServer|undefined;
  private peers:SessionPeer[]=[];private generation:number=0;
  private discovery:AirPlayDiscovery|undefined;
  private opus:boolean=false;
  private report:(message:string)=>void;
  private tunnelReady:()=>void;
  private sessionEvent:(event:string)=>void;
  constructor(report:(message:string)=>void,tunnelReady:()=>void=():void=>{},sessionEvent:(event:string)=>void=(_event:string):void=>{}){
    this.report=report;this.tunnelReady=tunnelReady;this.sessionEvent=sessionEvent;}
  async start(identity?:ReceiverIdentity,context?:common.UIAbilityContext,bluetoothAddress:string='',gateway:string='',wireless?:WirelessSettings,profile:DisplayProfile=new DisplayProfile()):Promise<void>{
    const stopping=this.stop();const generation=this.generation;await stopping;
    if(generation!==this.generation){throw new Error('会话监听启动已取消');}
    let store:PairingStore|undefined;
    let auth:ExperimentalAuth|undefined;
    if(identity){if(!context){throw new Error('缺少配对存储上下文');}store=await PairingStore.load(context);auth=await ExperimentalAuth.load(context);}
    if(generation!==this.generation){throw new Error('会话监听启动已取消');}
    if(identity){
      const supported=await probeOpus(():boolean=>generation!==this.generation);
      if(generation!==this.generation){throw new Error('会话监听启动已取消');}this.opus=supported;
      this.report(supported?'Opus 原生解码自检通过：48 kHz 单声道，已启用无线音频格式':'Opus 原生解码自检未通过，暂不声明该格式');
    }
    const server=socket.constructTCPSocketServerInstance();this.server=server;
    server.on('connect',(client:socket.TCPSocketConnection):void=>{
      if(generation!==this.generation||this.peers.length>=4){client.close().catch(():void=>{});return;}
      const peer=new SessionPeer(client);peer.bluetoothAddress=bluetoothAddress;peer.wireless=wireless;peer.display=profile;
      if(wireless&&identity){peer.publicKey=identity.publicKeyHex;peer.serial=util.generateRandomUUID(true);}
      this.peers.push(peer);this.refresh(peer);
      const pairingStore=store;
      if(identity&&pairingStore){
        peer.crypto=new NativePairCrypto(identity);
        peer.pairing=new PairSetup(peer.crypto,identity.pairingId,identity.keys.pubKey.getEncoded().data.slice(12),
          async(id:Uint8Array,key:Uint8Array):Promise<void>=>{
            if(peer.closed||generation!==this.generation){throw new Error('配对已取消');}
            await pairingStore.save(id,key);
          });
        peer.verify=new PairVerify(peer.crypto,identity.pairingId,(id:Uint8Array):Promise<Uint8Array|undefined>=>pairingStore.get(id));
      }
      client.on('close',():void=>{peer.closed=true;this.forget(peer);});
      client.on('error',(_error:BusinessError):void=>{this.close(peer);});
      client.on('message',(info:socket.SocketMessageInfo):void=>{
        if(peer.closed||generation!==this.generation){return;}
        try{
          if(peer.chunks.length>=8||peer.queuedBytes+info.message.byteLength>81920){throw new Error('会话接收队列超限');}
          const bytes=new Uint8Array(info.message);peer.chunks.push(bytes);peer.queuedBytes+=bytes.length;this.refresh(peer);
          this.receive(peer,generation,auth).catch((error:Error):void=>{this.report(`会话请求处理失败：${error.message}`);this.close(peer);});
        }catch(error){this.report(`会话入口拒绝请求 ${(error as Error).message}`);this.close(peer);}
      });
    });
    server.on('error',(error:BusinessError):void=>{if(generation===this.generation){this.report(`会话 TCP 错误 ${error.code}`);}});
    try{
      await server.listen({address:'0.0.0.0',port:7000,family:1});
      if(generation!==this.generation){await server.close().catch(():void=>{});throw new Error('会话监听启动已取消');}
      this.report(identity?'会话入口 TCP 7000 已监听（AirPlay 配对）':'会话入口 TCP 7000 已监听（诊断模式）');
      if(identity&&context){
        const discovery=new AirPlayDiscovery(context,bluetoothAddress,(message:string):void=>{if(generation===this.generation){this.report(message);}},gateway);this.discovery=discovery;
        try{await discovery.start(identity);}catch(_error){await discovery.close();if(generation===this.generation){this.report('AirPlay 服务发现启动失败；保留蓝牙直连入口');}}
        if(generation!==this.generation){await discovery.close();throw new Error('会话监听启动已取消');}
      }
    }catch(error){if(this.server===server){this.server=undefined;}await server.close().catch(():void=>{});throw new Error((error as Error).message);}
  }
  private async receive(peer:SessionPeer,generation:number,auth:ExperimentalAuth|undefined):Promise<void>{
    if(peer.reading){return;}peer.reading=true;
    try{
      while(peer.chunks.length>0&&!peer.closed&&generation===this.generation){
        const chunk=peer.chunks.shift();if(!chunk){break;}peer.queuedBytes-=chunk.length;
        const plain=peer.cipher?await peer.cipher.feed(chunk):chunk;
        if(peer.closed||generation!==this.generation){return;}
        const requests=peer.parser.feed(plain);if(peer.queue.length+requests.length>8){throw new Error('会话请求队列超限');}
        peer.queue.push(...requests);await this.drain(peer,generation,auth);
      }
    }finally{peer.reading=false;}
  }
  private async drain(peer:SessionPeer,generation:number,auth:ExperimentalAuth|undefined):Promise<void>{
    if(peer.working){return;}peer.working=true;
    try{
      while(peer.queue.length>0&&!peer.closed&&generation===this.generation){
        const request=peer.queue.shift();if(!request){break;}
        const rawPath=request.path.split('?')[0];
        const known=['/info','/pair-setup','/pair-verify','/auth-setup','/fp-setup','/command','/feedback'];
        const path=known.includes(rawPath)?rawPath:'其他路径';
        if(request.method==='POST'&&rawPath==='/pair-setup'&&peer.pairing&&!peer.cipher){
          const body=await peer.pairing.handle(request.body);
          if(peer.closed||generation!==this.generation){return;}
          await this.respond(peer,request,200,'OK',body,false);
          if(peer.pairing.lastError){this.report(`AirPlay 配对拒绝：${peer.pairing.lastError}`);this.close(peer);}
          else if(peer.pairing.complete){this.report('AirPlay Pair-Setup 已完成，手机配对公钥已保存');}
          else{this.report(`AirPlay Pair-Setup M${body[2]} 已发送`);}
        }else if(request.method==='POST'&&rawPath==='/pair-verify'&&peer.verify&&!peer.cipher){
          const body=await peer.verify.handle(request.body);
          if(peer.closed||generation!==this.generation){return;}
          // M4 is the final plaintext response. Subsequent records are encrypted.
          await this.respond(peer,request,200,'OK',body,false);
          if(peer.verify.lastError){this.report(`AirPlay 验证拒绝：${peer.verify.lastError}`);this.close(peer);}
          else if(peer.verify.verified&&peer.verify.keys&&peer.crypto){
            peer.cipher=new ControlCipher(peer.crypto,peer.verify.keys.readKey,peer.verify.keys.writeKey);
            this.report('AirPlay Pair-Verify 已完成，加密控制通道已建立');
            this.sessionEvent('paired');
            if(this.discovery){const remote=await peer.client.getRemoteAddress();if(!peer.closed&&generation===this.generation){this.discovery.approvePeer(remote.address);}}
          }else{this.report(`AirPlay Pair-Verify M${body[2]} 已发送`);}
        }else if(request.method==='POST'&&rawPath==='/auth-setup'&&peer.cipher&&peer.crypto&&auth){
          if(peer.authenticated){throw new Error('重复 MFiSAP 认证');}
          const body=await mfiSap(request.body,peer.crypto,auth);
          if(peer.closed||generation!==this.generation){return;}
          await this.respond(peer,request,200,'OK',body,false,'application/octet-stream');peer.authenticated=true;
          this.report('AirPlay MFiSAP 认证响应已发送，等待手机后续请求');
        }else if(request.method==='SETUP'&&peer.authenticated&&peer.verify?.shared&&peer.crypto){
          const setup=decodePlist(request.body);if(setup.kind!=='dict'){throw new Error('SETUP 需要 plist 字典');}
          const streams=setup.entries.get('streams');
          if(streams){
            if(streams.kind!=='array'){throw new Error('SETUP streams 格式错误');}
            if(!peer.resources||streams.items.length>8){throw new Error('无效媒体流 SETUP');}
            const responseStreams:Plist[]=[];
            for(let i=0;i<streams.items.length;i++){
              const stream=streams.items[i];if(stream.kind!=='dict'){throw new Error('无效媒体流字典');}
              const type=stream.entries.get('type');if(!type){throw new Error('媒体流缺少类型');}const number=type.number();
              if(number===130){
                const uuid=stream.entries.get('clientTypeUUID'),seed=stream.entries.get('seed'),connection=stream.entries.get('streamConnectionID');
                if(uuid?.kind!=='str'||uuid.text.toUpperCase()!==IAP_DATASTREAM_UUID||!seed||seed.kind!=='int'||seed.integer<BigInt(0)||
                  seed.integer>BigInt('18446744073709551615')||!peer.wireless||!auth||!peer.resources||peer.tunnel){throw new Error('不支持或重复的 iAP 数据流');}
                const remote=await peer.client.getRemoteAddress();
                const key=await peer.crypto.hkdf(peer.verify.shared,ascii('DataStream-Salt'+seed.integer.toString()),ascii('DataStream-Output-Encryption-Key'));
                if(peer.closed||generation!==this.generation){key.fill(0);return;}
                peer.tunnel=new NativeIapTunnel(key,peer.crypto,remote.address,peer.resources,auth,peer.wireless,peer.bluetoothAddress,peer.publicKey,peer.serial,
                  (message:string):void=>{if(!peer.closed&&generation===this.generation){this.report(message);}},
                  ():void=>{if(!peer.closed&&generation===this.generation){this.tunnelReady();}},
                  ():void=>{if(!peer.closed&&generation===this.generation){this.close(peer);}});key.fill(0);
                const port=await peer.tunnel.start();if(peer.closed||generation!==this.generation){await peer.tunnel.close();return;}
                const response=Plist.dict(['type','streamID','dataPort'],[Plist.int(130),Plist.int(1),Plist.int(port)]);
                if(connection){if(connection.kind!=='int'||connection.integer<BigInt(0)||connection.integer>BigInt('18446744073709551615')){throw new Error('iAP 连接编号无效');}
                  response.entries.set('streamConnectionID',Plist.int(connection.integer));}responseStreams.push(response);
              }else if(number===110){
                if(peer.screen){throw new Error('重复主屏幕流');}const connection=stream.entries.get('streamConnectionID');
                if(!connection||connection.kind!=='int'){throw new Error('屏幕流缺少连接编号');}
                const key=await peer.crypto.hkdf(peer.verify.shared,ascii('DataStream-Salt'+connection.integer.toString()),ascii('DataStream-Output-Encryption-Key'));
                if(peer.closed||generation!==this.generation){key.fill(0);return;}
                peer.screen=new NativeScreenServer(key,peer.crypto,(message:string):void=>{if(!peer.closed&&generation===this.generation){this.report(message);}},
                  ():void=>{if(!peer.closed&&generation===this.generation){this.sessionEvent('streaming');}},
                  ():void=>{if(!peer.closed&&generation===this.generation){this.close(peer);}},peer.display);key.fill(0);
                const dataPort=await peer.screen.start();if(peer.closed||generation!==this.generation){await peer.screen.close();return;}
                responseStreams.push(Plist.dict(['type','dataPort'],[Plist.int(110),Plist.int(dataPort)]));
              }else if(number===100||number===101||number===102){
                const connection=stream.entries.get('streamConnectionID'),bits=stream.entries.get('audioFormat');
                if(!connection||connection.kind!=='int'||!bits){throw new Error('音频流缺少格式或连接编号');}
                const format=pcmFormat(bits.number()),name=stream.entries.get('audioType');
                if(format.codec==='opus'&&!this.opus){throw new Error('本机 Opus 解码尚未验证');}
                const names=['compatibility','default','alert','media','telephony','speechRecognition'];
                const audioType=name?.kind==='str'?name.text:'default';
                if(!names.includes(audioType)){throw new Error('音频用途无效');}
                for(let j=peer.audio.length-1;j>=0;j--){if(peer.audio[j].type===number&&peer.audio[j].audioType===audioType){const old=peer.audio.splice(j,1)[0];await old.close();}}
                if(peer.closed||generation!==this.generation){return;}if(peer.audio.length>=4){throw new Error('音频流数量超限');}
                const key=await peer.crypto.hkdf(peer.verify.shared,ascii('DataStream-Salt'+connection.integer.toString()),ascii('DataStream-Output-Encryption-Key'));
                if(peer.closed||generation!==this.generation){key.fill(0);return;}
                const audio=new NativeAudioServer(number,audioType,connection.integer,format,key,peer.crypto,peer.remoteAddress,
                  (message:string):void=>{if(!peer.closed&&generation===this.generation){this.report(message);}});key.fill(0);peer.audio.push(audio);
                const response=await audio.start();if(peer.closed||generation!==this.generation){await audio.close();return;}responseStreams.push(response);
              }else{this.report(`暂未支持 AirPlay 媒体流类型 ${number}`);}
            }
            await this.respond(peer,request,200,'OK',encodePlist(Plist.dict(['streams'],[Plist.array(responseStreams)])),false,'application/x-apple-binary-plist');
            this.report('AirPlay 媒体流 SETUP 已应答');
          }else{
            if(peer.resources){throw new Error('重复初始化媒体会话');}
            const timing=setup.entries.get('timingPort'),port=timing?timing.number():0;if(port>65535){throw new Error('无效时钟端口');}
            const lowPower=setup.entries.get('keepAliveLowPower'),remote=await peer.client.getRemoteAddress();
            if(peer.closed||generation!==this.generation){return;}
            peer.remoteAddress=remote.address;
            peer.resources=new SessionResources((message:string):void=>{if(!peer.closed&&generation===this.generation){this.report(message);}},peer.display);
            const response=await peer.resources.start(remote,port,lowPower?.boolean===true,peer.verify.shared,peer.crypto,peer.wireless!==undefined&&auth!==undefined);
            if(peer.closed||generation!==this.generation){await peer.resources.close();return;}
            await this.respond(peer,request,200,'OK',encodePlist(response),false,'application/x-apple-binary-plist');
            this.report('AirPlay 初始 SETUP 已应答，等待媒体流配置');
          }
        }else if(rawPath==='/info'&&peer.authenticated){
          await this.respond(peer,request,200,'OK',encodePlist(receiverInfo(peer.bluetoothAddress,this.opus,peer.display)),false,'application/x-apple-binary-plist');
          this.report(`AirPlay /info 已发送：${peer.display.width}×${peer.display.height}、30 FPS、H.264，PCM/AAC`+(this.opus?'/Opus':'')+' 音频输出已启用');
        }else if(request.method==='POST'&&rawPath==='/command'&&peer.authenticated){
          const command=decodePlist(request.body);if(command.kind!=='dict'){throw new Error('command 需要 plist 字典');}
          const type=command.entries.get('type'),name=type?.kind==='str'?type.text:'';
          const commands=['requestUI','modesChanged','updateHIDDevice','updateVehicleInformation','setNightMode','disableBluetooth','disable-bluetooth'];
          this.report(`AirPlay 控制命令 ${commands.includes(name)?name:'其他命令'} 已接收`);
          if(name==='modesChanged'){this.report('AirPlay 资源状态：'+modeSummary(command));}
          await this.respond(peer,request,200,'OK',new Uint8Array(0),false);
        }else if(rawPath==='/feedback'&&peer.resources){
          const feedback=Plist.dict(['streams'],[Plist.array(peer.audio.map((audio:NativeAudioServer):Plist=>audio.feedback(peer.resources!.clock)))]);
          await this.respond(peer,request,200,'OK',encodePlist(feedback),false,'application/x-apple-binary-plist');
        }else if(request.method==='OPTIONS'||request.method==='RECORD'||request.method==='GET_PARAMETER'||request.method==='SET_PARAMETER'){
          if(!peer.authenticated){throw new Error('控制请求未经认证');}
          await this.respond(peer,request,200,'OK',new Uint8Array(0),false);this.report(`AirPlay ${request.method} 已应答`);
        }else if(request.method==='TEARDOWN'&&peer.authenticated){
          const teardown=request.body.length>0?decodePlist(request.body):undefined;
          const streams=teardown?.entries.get('streams');
          if(streams){
            if(streams.kind!=='array'||streams.items.length>8){throw new Error('无效媒体流 TEARDOWN');}
            let screenStopped=false;
            for(let i=0;i<streams.items.length;i++){
              const type=streams.items[i].entries.get('type');if(!type){throw new Error('TEARDOWN 缺少类型');}const number=type.number();
              if(number===110){const screen=peer.screen;peer.screen=undefined;if(screen){await screen.close();screenStopped=true;}}
              if(number===130){const streamId=streams.items[i].entries.get('streamID');
                if(!streamId||streamId.number()===1){const tunnel=peer.tunnel;peer.tunnel=undefined;if(tunnel){await tunnel.close();}}}
              for(let j=peer.audio.length-1;j>=0;j--){if(peer.audio[j].type===number){const audio=peer.audio.splice(j,1)[0];await audio.close();}}
            }
            if(peer.closed||generation!==this.generation){return;}
            await this.respond(peer,request,200,'OK',new Uint8Array(0),false);this.report('AirPlay 指定媒体流已拆除，会话继续');
            if(screenStopped&&!peer.closed&&generation===this.generation){this.sessionEvent('ended');}
          }else{await this.respond(peer,request,200,'OK',new Uint8Array(0),true);this.report('AirPlay 会话已拆除');this.close(peer);}
        }else{
          this.report(`收到 AirPlay ${request.method} ${path}；会话处理尚未实现`);
          await this.respond(peer,request,501,'Not Implemented',new Uint8Array(0),true);this.close(peer);
        }
      }
    }finally{peer.working=false;}
  }
  private async respond(peer:SessionPeer,request:RtspRequest,status:number,reason:string,body:Uint8Array,close:boolean,contentType:string='application/pairing+tlv8'):Promise<void>{
    const header=`${request.protocol} ${status} ${reason}\r\nCSeq: ${request.cseq}\r\nContent-Type: ${contentType}\r\nContent-Length: ${body.length}\r\n${close?'Connection: close\r\n':''}\r\n`;
    const bytes=concat([new util.TextEncoder().encodeInto(header),body]);
    const wire=peer.cipher?await peer.cipher.seal(bytes):bytes;
    await peer.client.send({data:wire.buffer as ArrayBuffer});
  }
  private refresh(peer:SessionPeer):void{
    if(peer.timer>=0){clearTimeout(peer.timer);}peer.timer=setTimeout(():void=>{this.close(peer);},45000);
  }
  async touch(x:number,y:number,down:boolean):Promise<void>{
    for(let i=0;i<this.peers.length;i++){
      const peer=this.peers[i];if(!peer.closed&&peer.authenticated&&peer.screen&&peer.resources){await peer.resources.touch(x,y,down);return;}
    }
  }
  private forget(peer:SessionPeer):void{
    const hadScreen=peer.screen!==undefined;
    peer.pairing?.dispose();peer.verify?.dispose();peer.cipher?.dispose();peer.chunks=[];peer.queue=[];peer.queuedBytes=0;
    peer.resources?.close().catch(():void=>{});
    peer.screen?.close().catch(():void=>{});
    peer.tunnel?.close().catch(():void=>{});peer.tunnel=undefined;peer.wireless=undefined;
    peer.audio.forEach((audio:NativeAudioServer):void=>{audio.close().catch(():void=>{});});peer.audio=[];
    if(peer.timer>=0){clearTimeout(peer.timer);peer.timer=-1;}
    const index=this.peers.indexOf(peer);if(index>=0){this.peers.splice(index,1);}
    if(hadScreen&&!this.peers.some((current:SessionPeer):boolean=>current.screen!==undefined&&!current.closed)){peer.screen=undefined;this.sessionEvent('ended');}
  }
  private close(peer:SessionPeer):void{peer.closed=true;peer.queue=[];this.forget(peer);peer.client.close().catch(():void=>{});}
  async stop():Promise<void>{
    this.generation++;this.opus=false;const peers=this.peers.slice();for(let i=0;i<peers.length;i++){this.close(peers[i]);}
    const server=this.server;this.server=undefined;if(server){await server.close().catch(():void=>{});}
    const discovery=this.discovery;this.discovery=undefined;if(discovery){await discovery.close();}
  }
}
