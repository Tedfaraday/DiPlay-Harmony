// GPL-3.0-only. Adapted from DiPlay ControlCipher.kt.
import { PairCrypto, concat } from './PairingCore';
export class ControlCipher {
  private read:Uint8Array;private write:Uint8Array;private crypto:PairCrypto;
  private readCounter:bigint=BigInt(0);private writeCounter:bigint=BigInt(0);
  private buffer:Uint8Array=new Uint8Array(0);private disposed:boolean=false;
  constructor(crypto:PairCrypto,read:Uint8Array,write:Uint8Array){this.crypto=crypto;this.read=new Uint8Array(read);this.write=new Uint8Array(write);}
  private nonce(counter:bigint):Uint8Array{
    if(counter>BigInt('18446744073709551615')){throw new Error('Control nonce exhausted');}
    const nonce=new Uint8Array(12);let value=counter;for(let i=4;i<12;i++){nonce[i]=Number(value&BigInt(255));value>>=BigInt(8);}return nonce;
  }
  async feed(data:Uint8Array):Promise<Uint8Array>{
    if(this.disposed){throw new Error('Control channel closed');}
    if(this.buffer.length+data.length>81920){throw new Error('Encrypted control buffer limit');}
    this.buffer=concat([this.buffer,data]);let offset=0;const parts:Uint8Array[]=[];
    try{
      while(this.buffer.length-offset>=2){
        const length=this.buffer[offset]|(this.buffer[offset+1]<<8),end=offset+2+length+16;
        if(this.buffer.length<end){break;}
        const aad=this.buffer.slice(offset,offset+2),sealed=this.buffer.slice(offset+2,end);
        const plain=await this.crypto.open(this.read,this.nonce(this.readCounter),sealed,aad);
        if(this.disposed){plain.fill(0);throw new Error('Control channel closed');}
        parts.push(plain);this.readCounter++;offset=end;
      }
      this.buffer=this.buffer.slice(offset);return concat(parts);
    }catch(error){for(let i=0;i<parts.length;i++){parts[i].fill(0);}this.dispose();throw new Error('Control frame authentication failed');}
  }
  async seal(data:Uint8Array):Promise<Uint8Array>{
    if(this.disposed){throw new Error('Control channel closed');}const parts:Uint8Array[]=[];
    for(let offset=0;offset<data.length||offset===0;offset+=16384){
      const chunk=data.slice(offset,offset+16384),header=new Uint8Array([chunk.length&255,chunk.length>>>8]);
      const sealed=await this.crypto.seal(this.write,this.nonce(this.writeCounter),chunk,header);
      if(this.disposed){throw new Error('Control channel closed');}this.writeCounter++;parts.push(header,sealed);
    }
    return concat(parts);
  }
  dispose():void{this.disposed=true;this.read.fill(0);this.write.fill(0);this.buffer.fill(0);this.buffer=new Uint8Array(0);}
}
