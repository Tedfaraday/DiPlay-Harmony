// GPL-3.0-only. Minimal independent iAP2 runtime over the CarPlay Wi-Fi data stream.
import { Iap2Link, CsmObserver } from './Iap2Link';
import { controlMessage, identification, parameter, readParameters, parameterIds, IapControlDiagnostics } from './Iap2Control';
import { WirelessSettings, wirelessComponent, wifiConfiguration, startWirelessSession } from './WirelessControl';
export interface TunnelAuth {certificate:Uint8Array;sign(challenge:Uint8Array):Promise<Uint8Array>;}
export class TunnelControl {
  private link:Iap2Link=new Iap2Link();private csm:CsmObserver=new CsmObserver();
  private closed:boolean=false;private identified:boolean=false;private authenticated:boolean=false;
  private signed:boolean=false;
  private diagnostics:IapControlDiagnostics=new IapControlDiagnostics();
  private wifiSent:number=0;private starts:number=0;
  private auth:TunnelAuth;private settings:WirelessSettings;private mac:string;private publicKey:string;private serial:string;
  private now:()=>number;private encode:(text:string)=>Uint8Array;private send:(bytes:Uint8Array)=>Promise<void>;
  private report:(message:string)=>void;private ready:()=>void;
  constructor(auth:TunnelAuth,settings:WirelessSettings,mac:string,publicKey:string,serial:string,now:()=>number,
    encode:(text:string)=>Uint8Array,send:(bytes:Uint8Array)=>Promise<void>,report:(message:string)=>void,ready:()=>void){
    this.auth=auth;this.settings=settings;this.mac=mac;this.publicKey=publicKey;this.serial=serial;
    this.now=now;this.encode=encode;this.send=send;this.report=report;this.ready=ready;
  }
  async start():Promise<void>{if(this.closed){throw new Error('iAP runtime closed');}this.link.start(this.now(),true);await this.pump();}
  async feed(bytes:Uint8Array):Promise<void>{if(this.closed){return;}this.link.feed(bytes,this.now());await this.pump();}
  async advance():Promise<void>{if(this.closed){return;}this.link.advance(this.now());await this.pump();}
  private async pump():Promise<void>{
    if(this.closed){return;}
    const output=this.link.takeOutput();for(let i=0;i<output.length;i++){if(this.closed){return;}await this.send(output[i]);}
    const events=this.link.takeEvents();
    for(let i=0;i<events.length;i++){
      if(this.closed){return;}const event=events[i];if(event.kind==='dead'){throw new Error('iAP runtime link ended');}
      if(event.kind==='normal'){this.report('Wi-Fi iAP2 链路协商完成');}
      if(event.kind==='control'){
        const messages=this.csm.feedMessages(event.data);
        for(let j=0;j<messages.length;j++){await this.answer(messages[j].id,messages[j].body);}
      }
    }
  }
  private async answer(id:number,body:Uint8Array):Promise<void>{
    if(this.closed){return;}let response:Uint8Array|undefined;
    if(this.authenticated){const summary=this.diagnostics.observe(id,body);if(summary){this.report('Wi-Fi iAP2 诊断：'+summary);}}
    if(id===0x1d00){
      this.identified=false;this.authenticated=false;this.signed=false;
      response=identification(this.serial,this.encode,this.mac,wirelessComponent(this.settings.ssid,this.encode));
      this.report('Wi-Fi iAP2 已发送配件身份');
    }else if(id===0x1d02){this.identified=true;this.report('Wi-Fi iAP2 配件身份已获接受');}
    else if(id===0x1d03){this.report('Wi-Fi iAP2 身份被拒绝，字段 '+parameterIds(body).join(','));throw new Error('iAP identification rejected');}
    else if(id===0xaa04){this.report('Wi-Fi iAP2 MFi 认证被拒绝');throw new Error('iAP authentication rejected');}
    else if(id===0xaa00||id===0xaa02){
      if(!this.identified){throw new Error('iAP authentication before identification');}
      if(id===0xaa00){response=controlMessage(0xaa01,[parameter(0,this.auth.certificate)]);this.report('Wi-Fi iAP2 已发送认证证书');}
      else{const challenge=readParameters(body,0);if(challenge.length!==1){throw new Error('iAP challenge invalid');}
        const signature=await this.auth.sign(challenge[0]);if(this.closed){signature.fill(0);return;}
        response=controlMessage(0xaa03,[parameter(0,signature)]);this.signed=true;this.report('Wi-Fi iAP2 已发送挑战签名');}
    }else if(id===0xaa05){
      if(!this.identified||!this.signed){throw new Error('iAP success before challenge response');}
      if(!this.authenticated){this.authenticated=true;this.report('Wi-Fi iAP2 MFi 认证完成；运行控制通道已就绪');this.ready();}
    }else if(this.authenticated&&(id===0x5702||id===0x4e0e)&&this.wifiSent<7){
      response=wifiConfiguration(this.settings,this.encode);this.wifiSent++;this.report('Wi-Fi iAP2 已发送热点配置（日志不记录密码）');
    }else if(this.authenticated&&id===0x4300&&this.starts<2){
      response=startWirelessSession(this.settings,this.mac,this.publicKey,this.encode);this.starts++;this.report('Wi-Fi iAP2 已回复 CarPlay 会话入口');
    }
    if(response&&!this.closed){this.link.sendControl(response,this.now());const output=this.link.takeOutput();
      for(let i=0;i<output.length;i++){if(this.closed){return;}await this.send(output[i]);}}
  }
  close():void{this.closed=true;this.link.stop();this.csm=new CsmObserver();this.identified=false;this.authenticated=false;}
}
