import native from 'libdiplayvideo.so';
import { util } from '@kit.ArkTS';
import { ReceiverIdentity } from './ReceiverIdentity';
import { receiverTxtRecords } from './ReceiverInfo';
import { DnsName, DnsQuestion, DnsRecord, DnsPacket, readDns, writeDns } from './DnsCodec';

class CachedDns {
  record:DnsRecord;source:string;expires:number;
  constructor(record:DnsRecord,source:string,expires:number){this.record=record;this.source=source;this.expires=expires;}
}
// IPv4 hotspot discovery/publication. Never connects until Pair-Verify approves the phone.
export class HotspotMdns {
  private address:string;private deviceId:string;private report:(message:string)=>void;
  private resolved:(address:string,port:number)=>void;private handle:number=0;private timer:number=-1;
  private closed:boolean=false;private approved:string='';private own:DnsRecord[]=[];private cache:CachedDns[]=[];
  private instance:DnsName;private hostname:DnsName;private browse:DnsName=new DnsName(['_carplay','_tcp','local']);
  private airplay:DnsName=new DnsName(['_airplay','_tcp','local']);private enumeration:DnsName=new DnsName(['_services','_dns-sd','_udp','local']);
  private ready:number=0;private probes:number=0;private announced:boolean=false;private nextAnnouncement:number=0;
  private nextBrowse:number=0;private browseCount:number=0;private lastQuery:number=-10000;private nextReport:number=0;
  private nextAnswer:number=0;private answerAt:number=0;private answerAddress:string='';
  private seen:number=0;private ptrSeen:boolean=false;private srvSeen:boolean=false;private ports:Set<number>=new Set<number>();
  private queried:Map<string,number>=new Map<string,number>();
  constructor(address:string,deviceId:string,report:(message:string)=>void,resolved:(address:string,port:number)=>void){
    this.address=address;this.deviceId=deviceId;this.report=report;this.resolved=resolved;
    const compact=deviceId.replace(/:/g,'').toLowerCase();
    this.instance=new DnsName(['DiPlay Harmony-'+compact.slice(-6),'_airplay','_tcp','local']);
    this.hostname=new DnsName(['diplay-'+compact,'local']);
  }
  start(identity:ReceiverIdentity):void{
    if(this.closed||this.handle){throw new Error('热点服务发现不能重复启动');}
    const key=identity.keys.pubKey.getEncoded().data.slice(12);let hex='';for(let i=0;i<key.length;i++){hex+=key[i].toString(16).padStart(2,'0');}
    const ptr=new DnsRecord(this.airplay,12,120,false);ptr.target=this.instance;
    const srv=new DnsRecord(this.instance,33);srv.target=this.hostname;srv.port=7000;
    const txt=new DnsRecord(this.instance,16);const attributes=receiverTxtRecords(this.deviceId,identity.pairingId,hex);
    attributes.forEach((value:string,name:string):void=>{txt.values.push(name+'='+value);});
    const address=new DnsRecord(this.hostname,1);address.address=this.address;
    const serviceBitmap=new DnsRecord(this.instance,47);serviceBitmap.values=['16','33'];
    const addressBitmap=new DnsRecord(this.hostname,47);addressBitmap.values=['1'];
    const enumeration=new DnsRecord(this.enumeration,12,120,false);enumeration.target=this.airplay;
    this.own=[ptr,srv,txt,address,serviceBitmap,addressBitmap,enumeration];
    this.handle=native.startDiscovery(this.address);
    if(this.handle<1){throw new Error('热点 mDNS 句柄无效');}
    this.ready=Date.now();this.nextBrowse=this.ready+750;this.nextReport=this.ready+10000;
    try {this.probe();this.timer=setInterval(():void=>{this.poll();},25);}
    catch(_error){this.close();throw new Error('热点 mDNS 初始探测发送失败');}
    this.report('热点 mDNS 已绑定指定网关接口，正在探测服务名称');
  }
  approvePeer(address:string):void{
    if(this.closed){return;}this.approved=address;this.cache=this.cache.filter((entry:CachedDns):boolean=>entry.source===address);
    this.nextBrowse=Date.now();this.queried.clear();this.resolve();
  }
  private encode(text:string):Uint8Array{return new util.TextEncoder().encodeInto(text);}
  private decode(data:Uint8Array):string{return util.TextDecoder.create('utf-8').decodeToString(data);}
  private send(packet:DnsPacket,address:string='',probe:boolean=false):void{
    if(this.closed||!this.handle){return;}const bytes=writeDns(packet,(text:string):Uint8Array=>this.encode(text),probe);
    const sent=address?native.sendDiscovery(this.handle,bytes.buffer as ArrayBuffer,address):native.sendDiscovery(this.handle,bytes.buffer as ArrayBuffer);
    if(!sent){throw new Error('热点 mDNS 数据发送未完成');}
  }
  private probe():void{
    const packet=new DnsPacket();packet.questions=[new DnsQuestion(this.instance,255),new DnsQuestion(this.hostname,255)];
    // Proposed unique SRV/TXT/A records go in the authority section, without cache-flush.
    packet.records=this.own.filter((record:DnsRecord):boolean=>record.type===1||record.type===16||record.type===33)
      .map((record:DnsRecord):DnsRecord=>{const proposed=new DnsRecord(record.name,record.type,record.ttl,false);proposed.target=record.target;
        proposed.port=record.port;proposed.address=record.address;proposed.values=record.values;return proposed;});
    this.send(packet,'',true);this.probes++;
  }
  private announce(address:string=''):void{
    const packet=new DnsPacket();packet.response=true;packet.records=this.own;this.send(packet,address);
    if(!this.announced){this.announced=true;this.report('AirPlay 服务已在热点接口公告，音频功能位与 /info 一致');}
    if(!address){this.nextAnswer=Date.now()+1000;}
  }
  private query(questions:DnsQuestion[]):void{
    const packet=new DnsPacket();packet.questions=questions;this.lastQuery=Date.now();
    this.send(packet);if(this.approved){this.send(packet,this.approved);}
  }
  private poll():void{
    if(this.closed){return;}const now=Date.now();
    try{
      for(let i=0;i<16;i++){
        const datagram=native.readDiscovery(this.handle);if(!datagram){break;}
        if(datagram.address===this.address){continue;}
        let packet:DnsPacket;try{packet=readDns(new Uint8Array(datagram.data),(data:Uint8Array):string=>this.decode(data));}catch(_error){continue;}
        if(packet.id!==0||(packet.response&&datagram.unicast&&now-this.lastQuery>2000)){continue;}this.seen=Math.min(this.seen+1,10000);
        if(this.conflict(packet)){this.report('热点 mDNS 名称冲突，本轮服务发现已停止');this.close();return;}
        if(packet.response){this.receive(packet,datagram.address,now);}else if(this.announced){this.answer(packet,datagram.address,now);}
      }
      if(!this.announced){
        if(this.probes<3&&now-this.ready>=this.probes*250){this.probe();}
        if(now-this.ready>=750&&this.probes===3){this.announce();this.nextAnnouncement=now+1000;}
      }else if(now>=this.nextAnnouncement){this.announce();this.nextAnnouncement=now+60000;}
      if(this.announced&&now>=this.nextBrowse){
        this.query([new DnsQuestion(this.browse)]);this.browseCount++;
        this.nextBrowse=now+(this.browseCount<3?2000:30000);this.resolve();
      }
      if(this.answerAt&&now>=this.answerAt){this.announce(this.answerAddress);this.answerAt=0;this.answerAddress='';}
      this.cache=this.cache.filter((entry:CachedDns):boolean=>entry.expires>now);
      if(now>=this.nextReport){
        const count=this.cache.filter((entry:CachedDns):boolean=>entry.source===this.approved).length;
        this.report(`热点 mDNS 诊断：有效报文 ${this.seen}，CarPlay PTR ${this.ptrSeen?1:0}，SRV ${this.srvSeen?1:0}，认证手机记录 ${count}`);
        this.nextReport=now+30000;
      }
    }catch(error){
      const detail=/^Hotspot mDNS (interface|socket|options|bind|membership|send|receive) error (\d{1,4})$/.exec((error as Error).message);
      this.report('热点 mDNS 收发失败'+(detail?`：${detail[1]} ${detail[2]}`:'')+'，本轮服务发现已停止');this.close();
    }
  }
  private conflict(packet:DnsPacket):boolean{
    if(!packet.response){return false;}
    for(let i=0;i<packet.records.length;i++){
      const record=packet.records[i];if(record.ttl===0){continue;}
      if(record.type===1&&record.name.key()===this.hostname.key()&&record.address!==this.address){return true;}
      if(record.type===33&&record.name.key()===this.instance.key()&&(record.port!==7000||record.target?.key()!==this.hostname.key())){return true;}
    }return false;
  }
  private answer(packet:DnsPacket,address:string,now:number):void{
    if(packet.truncated||now<this.nextAnswer||this.answerAt){return;}
    let matches=false,unicast=false;
    for(let i=0;i<packet.questions.length;i++){
      const question=packet.questions[i],name=question.name.key();
      if(name===this.airplay.key()||name===this.instance.key()||name===this.hostname.key()||name===this.enumeration.key()){
        matches=true;unicast=unicast||question.unicast;
      }
    }
    if(matches){this.answerAt=now+20+Math.floor(Math.random()*100);this.answerAddress=unicast?address:'';this.nextAnswer=now+1000;}
  }
  private receive(packet:DnsPacket,source:string,now:number):void{
    for(let i=0;i<packet.records.length;i++){
      const record=packet.records[i];if(![1,12,33].includes(record.type)){continue;}
      if(record.type===12&&record.name.key()!==this.browse.key()){continue;}
      if(record.type===12){this.ptrSeen=true;}if(record.type===33&&record.name.labels.slice(-3).join('.').toLowerCase()==='_carplay._tcp.local'){this.srvSeen=true;}
      this.cache=this.cache.filter((entry:CachedDns):boolean=>!(entry.source===source&&entry.record.name.key()===record.name.key()&&entry.record.type===record.type&&
        (record.flush||entry.record.target?.key()===record.target?.key())));
      if(record.ttl>0&&this.cache.length<64){this.cache.push(new CachedDns(record,source,now+Math.min(record.ttl,120)*1000));}
    }this.resolve();
  }
  private resolve():void{
    if(!this.approved||this.closed){return;}const now=Date.now();
    const records=this.cache.filter((entry:CachedDns):boolean=>entry.source===this.approved&&entry.expires>now).map((entry:CachedDns):DnsRecord=>entry.record);
    const questions:DnsQuestion[]=[];
    for(let i=0;i<records.length;i++){
      const ptr=records[i];if(ptr.type!==12||ptr.name.key()!==this.browse.key()||!ptr.target){continue;}
      const target=ptr.target;
      const services=records.filter((record:DnsRecord):boolean=>record.type===33&&record.name.key()===target.key());
      if(services.length===0){this.followup(target,33,now,questions);}
      for(let j=0;j<services.length;j++){
        const service=services[j],host=service.target;if(!host||service.port<1||service.port>65535){continue;}
        if(!records.some((record:DnsRecord):boolean=>record.type===1&&record.name.key()===host.key()&&record.address===this.approved)){
          this.followup(host,1,now,questions);continue;
        }
        if(!this.ports.has(service.port)&&this.ports.size<8){this.ports.add(service.port);this.report(`热点 CarPlay 控制服务已解析，IPv4 端口 ${service.port}`);this.resolved(this.approved,service.port);}
      }
    }
    if(questions.length>0){this.query(questions);}
  }
  private followup(name:DnsName,type:number,now:number,questions:DnsQuestion[]):void{
    const key=name.key()+':'+type,last=this.queried.get(key)??-10000;
    if(now-last<1000||this.queried.size>=32||questions.length>=8){return;}this.queried.set(key,now);questions.push(new DnsQuestion(name,type));
  }
  close():void{
    if(this.closed){return;}
    if(this.announced&&this.handle){try{for(let i=0;i<this.own.length;i++){this.own[i].ttl=0;}this.announce();}catch(_error){}}
    this.closed=true;if(this.timer>=0){clearInterval(this.timer);this.timer=-1;}
    if(this.handle){native.stopDiscovery(this.handle);this.handle=0;}this.cache=[];this.own=[];this.queried.clear();this.ports.clear();
  }
}

