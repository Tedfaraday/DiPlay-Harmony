// Bounded DNS wire codec for link-local discovery (RFC 6762/6763).
export class DnsName {
  labels:string[];
  constructor(labels:string[]){this.labels=labels;}
  key():string{return this.labels.map((s:string):string=>s.toLowerCase()).join('\u0000');}
}
export class DnsQuestion {
  name:DnsName;type:number;unicast:boolean;
  constructor(name:DnsName,type:number=12,unicast:boolean=true){this.name=name;this.type=type;this.unicast=unicast;}
}
export class DnsRecord {
  name:DnsName;type:number;ttl:number;flush:boolean;target:DnsName|undefined;
  port:number=0;address:string='';values:string[]=[];
  constructor(name:DnsName,type:number,ttl:number=120,flush:boolean=true){this.name=name;this.type=type;this.ttl=ttl;this.flush=flush;}
}
export class DnsPacket {
  id:number=0;response:boolean=false;truncated:boolean=false;questions:DnsQuestion[]=[];records:DnsRecord[]=[];
}
class NameRead {name:DnsName;end:number;constructor(name:DnsName,end:number){this.name=name;this.end=end;}}
function u16(bytes:Uint8Array,offset:number):number{
  if(offset<0||offset+2>bytes.length){throw new Error('Truncated DNS field');}return bytes[offset]*256+bytes[offset+1];
}
function readName(bytes:Uint8Array,start:number,decode:(data:Uint8Array)=>string):NameRead{
  let offset=start,end=-1,hops=0,length=0;const labels:string[]=[];
  while(true){
    if(offset>=bytes.length||++hops>144){throw new Error('Invalid DNS name');}const size=bytes[offset++];
    if(size===0){if(end<0){end=offset;}return new NameRead(new DnsName(labels),end);}
    if((size&192)===192){
      if(offset>=bytes.length){throw new Error('Truncated DNS pointer');}const target=(size&63)*256+bytes[offset++];
      if(target>=offset-2||target<12||hops>128){throw new Error('Invalid DNS compression pointer');}
      if(end<0){end=offset;}offset=target;continue;
    }
    if(size>63||offset+size>bytes.length||(length+=size+1)>254||labels.length>=127){throw new Error('Invalid DNS label');}
    const text=decode(bytes.slice(offset,offset+size));if(text.includes('\u0000')){throw new Error('Invalid DNS label text');}
    labels.push(text);offset+=size;
  }
}
export function readDns(bytes:Uint8Array,decode:(data:Uint8Array)=>string):DnsPacket{
  if(bytes.length<12||bytes.length>9000){throw new Error('DNS packet limit');}
  const packet=new DnsPacket(),flags=u16(bytes,2),questions=u16(bytes,4),records=u16(bytes,6)+u16(bytes,8)+u16(bytes,10);
  if((flags&0x780f)!==0||questions>32||records>64){throw new Error('Unsupported DNS header');}
  packet.id=u16(bytes,0);packet.response=(flags&0x8000)!==0;packet.truncated=(flags&0x200)!==0;let offset=12;
  for(let i=0;i<questions;i++){
    const name=readName(bytes,offset,decode);offset=name.end;const type=u16(bytes,offset),klass=u16(bytes,offset+2);offset+=4;
    if((klass&0x7fff)===1){packet.questions.push(new DnsQuestion(name.name,type,(klass&0x8000)!==0));}
  }
  for(let i=0;i<records;i++){
    const name=readName(bytes,offset,decode);offset=name.end;
    const type=u16(bytes,offset),klass=u16(bytes,offset+2);const ttl=u16(bytes,offset+4)*65536+u16(bytes,offset+6),size=u16(bytes,offset+8);
    offset+=10;const end=offset+size;if(end>bytes.length){throw new Error('Truncated DNS record');}
    if((klass&0x7fff)===1){
      const record=new DnsRecord(name.name,type,ttl,(klass&0x8000)!==0);
      if(type===1){if(size!==4){throw new Error('Invalid DNS A record');}record.address=Array.from(bytes.slice(offset,end)).join('.');}
      else if(type===12||type===33){
        const start=offset+(type===33?6:0);if(start>=end){throw new Error('Invalid DNS service record');}
        const target=readName(bytes,start,decode);if(target.end!==end){throw new Error('Invalid DNS record name length');}
        record.target=target.name;if(type===33){record.port=u16(bytes,offset+4);}
      }else if(type===16){
        let index=offset;while(index<end){const length=bytes[index++];if(index+length>end||record.values.length>=32){throw new Error('Invalid DNS TXT');}
          record.values.push(decode(bytes.slice(index,index+length)));index+=length;}
      }
      packet.records.push(record);
    }
    offset=end;
  }
  if(offset!==bytes.length){throw new Error('Unexpected DNS trailing data');}return packet;
}
class DnsWriter {
  bytes:number[]=[];encode:(text:string)=>Uint8Array;
  constructor(encode:(text:string)=>Uint8Array){this.encode=encode;}
  short(value:number):void{if(!Number.isInteger(value)||value<0||value>65535){throw new Error('Invalid DNS uint16');}this.bytes.push(value>>>8,value&255);}
  long(value:number):void{if(!Number.isInteger(value)||value<0||value>4294967295){throw new Error('Invalid DNS TTL');}this.short(Math.floor(value/65536));this.short(value&65535);}
  name(name:DnsName):void{
    let length=1;for(let i=0;i<name.labels.length;i++){
      const data=this.encode(name.labels[i]);if(data.length<1||data.length>63||name.labels[i].includes('\u0000')||(length+=data.length+1)>255){throw new Error('DNS label limit');}
      this.bytes.push(data.length);for(let j=0;j<data.length;j++){this.bytes.push(data[j]);}
    }this.bytes.push(0);
  }
  record(record:DnsRecord):void{
    this.name(record.name);this.short(record.type);this.short(record.flush?0x8001:1);this.long(record.ttl);
    const data=new DnsWriter(this.encode);
    if(record.type===12||record.type===33){
      if(!record.target){throw new Error('Missing DNS target');}if(record.type===33){data.short(0);data.short(0);data.short(record.port);}data.name(record.target);
    }else if(record.type===1){
      const parts=record.address.split('.');if(parts.length!==4||parts.some((p:string):boolean=>!/^\d{1,3}$/.test(p)||Number(p)>255)){throw new Error('Invalid DNS address');}
      for(let i=0;i<4;i++){data.bytes.push(Number(parts[i]));}
    }else if(record.type===16){
      for(let i=0;i<record.values.length;i++){const value=this.encode(record.values[i]);if(value.length>255){throw new Error('DNS TXT limit');}data.bytes.push(value.length);for(let j=0;j<value.length;j++){data.bytes.push(value[j]);}}
    }else if(record.type===47){
      data.name(record.name);const types=record.values.map((s:string):number=>Number(s)),maximum=Math.max(...types);
      if(types.length<1||types.some((type:number):boolean=>!Number.isInteger(type)||type<1||type>255)){throw new Error('DNS bitmap limit');}
      const bitmap=new Uint8Array(Math.floor(maximum/8)+1);for(let i=0;i<types.length;i++){bitmap[Math.floor(types[i]/8)]|=128>>(types[i]%8);}
      data.bytes.push(0,bitmap.length);for(let i=0;i<bitmap.length;i++){data.bytes.push(bitmap[i]);}
    }else{throw new Error('Unsupported outgoing DNS record');}
    this.short(data.bytes.length);for(let i=0;i<data.bytes.length;i++){this.bytes.push(data.bytes[i]);}
  }
}
export function writeDns(packet:DnsPacket,encode:(text:string)=>Uint8Array,probe:boolean=false):Uint8Array{
  if(packet.questions.length>32||packet.records.length>16){throw new Error('DNS output limit');}
  const writer=new DnsWriter(encode);writer.short(packet.id);writer.short(packet.response?0x8400:0);
  writer.short(packet.questions.length);writer.short(probe?0:packet.records.length);writer.short(probe?packet.records.length:0);writer.short(0);
  for(let i=0;i<packet.questions.length;i++){const question=packet.questions[i];writer.name(question.name);writer.short(question.type);writer.short(question.unicast?0x8001:1);}
  for(let i=0;i<packet.records.length;i++){writer.record(packet.records[i]);}
  if(writer.bytes.length>1400){throw new Error('DNS output datagram limit');}return new Uint8Array(writer.bytes);
}
