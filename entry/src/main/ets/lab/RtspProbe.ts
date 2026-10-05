export class RtspRequest {
  method: string;
  path: string;
  protocol: string;
  cseq: string;
  body: Uint8Array;
  constructor(method: string,path: string,protocol: string,cseq: string,body:Uint8Array) {
    this.method=method;this.path=path;this.protocol=protocol;this.cseq=cseq;this.body=body;
  }
}

export class RtspProbe {
  private buffer: number[] = [];
  private responses:boolean;
  constructor(responses:boolean=false){this.responses=responses;}
  feed(bytes: Uint8Array): RtspRequest[] {
    if (this.buffer.length + bytes.length > 81920) { throw new Error('RTSP buffer limit'); }
    for (let i=0;i<bytes.length;i++) { this.buffer.push(bytes[i]); }
    const requests: RtspRequest[] = [];
    while (this.buffer.length>0) {
      let end=-1;
      for (let i=0;i+3<this.buffer.length;i++) {
        if (this.buffer[i]===13&&this.buffer[i+1]===10&&this.buffer[i+2]===13&&this.buffer[i+3]===10) {end=i+4;break;}
      }
      if (end<0) {if(this.buffer.length>16384){throw new Error('RTSP header limit');}break;}
      if (end>16384) {throw new Error('RTSP header limit');}
      let header='';for(let i=0;i<end;i++){if(this.buffer[i]>127){throw new Error('Non-ASCII RTSP header');}header+=String.fromCharCode(this.buffer[i]);}
      const lines=header.split('\r\n');const first=lines[0].split(' ');
      const response=this.responses&&['RTSP/1.0','HTTP/1.1','HTTP/1.0'].includes(first[0])&&/^\d{3}$/.test(first[1]);
      if(!response&&(first.length!==3||!['RTSP/1.0','HTTP/1.1','HTTP/1.0'].includes(first[2])||!/^[A-Z_]+$/.test(first[0]))){throw new Error('Invalid RTSP request');}
      let length=0,seenLength=false,cseq='0';
      for(let i=1;i<lines.length;i++){
        const colon=lines[i].indexOf(':');if(colon<0){continue;}
        const name=lines[i].slice(0,colon).toLowerCase(),value=lines[i].slice(colon+1).trim();
        if(name==='content-length'){
          if(seenLength||!/^\d{1,5}$/.test(value)||Number(value)>65536){throw new Error('Invalid RTSP content length');}
          length=Number(value);seenLength=true;
        }
        if(name==='transfer-encoding'){throw new Error('Unsupported RTSP transfer encoding');}
        if(name==='cseq'){if(!/^\d{1,10}$/.test(value)){throw new Error('Invalid CSeq');}cseq=value;}
      }
      if(this.buffer.length<end+length){break;}
      if(requests.length>=16){throw new Error('RTSP request queue limit');}
      requests.push(new RtspRequest(response?'RESPONSE':first[0],first[1],response?first[0]:first[2],cseq,new Uint8Array(this.buffer.slice(end,end+length))));this.buffer.splice(0,end+length);
    }
    return requests;
  }
}
