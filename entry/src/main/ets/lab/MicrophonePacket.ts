// GPL-3.0-only. Adapted from DiPlay MicrophonePacketizer.kt.
import { concat } from './PairingCore';
import { pcmLittleEndian } from './AudioCodec';
export interface MicrophoneCrypto {
  seal(key:Uint8Array,nonce:Uint8Array,plain:Uint8Array,aad:Uint8Array):Promise<Uint8Array>;
}
export class MicrophonePacketizer {
  private sequence:number=0;private sample:number=0;private counter:bigint=BigInt(0);
  async packet(pcm:Uint8Array,key:Uint8Array,crypto:MicrophoneCrypto):Promise<Uint8Array>{
    if(pcm.length===0||pcm.length%2!==0||pcm.length>5760){throw new Error('麦克风 PCM 帧无效');}
    if(this.counter>=BigInt('18446744073709551615')){throw new Error('麦克风计数器已耗尽');}
    const header=new Uint8Array(12),view=new DataView(header.buffer);header[0]=128;header[1]=100;
    view.setUint16(2,this.sequence,false);view.setUint32(4,this.sample,false);
    const nonce=new Uint8Array(12);let value=this.counter;
    for(let i=4;i<12;i++){nonce[i]=Number(value&BigInt(255));value>>=BigInt(8);}
    // Reserve the nonce before the asynchronous operation; never reuse it on failure.
    this.sequence=(this.sequence+1)&65535;this.sample=(this.sample+pcm.length/2)>>>0;this.counter++;
    const wirePcm=pcmLittleEndian(pcm,1);
    try{return concat([header,await crypto.seal(key,nonce,wirePcm,header.slice(4)),nonce.slice(4)]);}
    finally{wirePcm.fill(0);}
  }
}
