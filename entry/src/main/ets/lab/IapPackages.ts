// GPL-3.0-only. APTransportPackage layout adapted from DiPlay IapTunnel.kt.
import { concat } from './PairingCore';
export const IAP_DATASTREAM_UUID='E9459FD0-BCAD-4C45-820F-1E72447EF2F2';
export class IapPackages {
  private buffer:Uint8Array=new Uint8Array(0);
  feed(data:Uint8Array):Uint8Array[]{
    if(this.buffer.length+data.length>1048576){throw new Error('iAP package buffer limit');}
    this.buffer=concat([this.buffer,data]);let offset=0;const bodies:Uint8Array[]=[];
    while(this.buffer.length-offset>=32){
      const view=new DataView(this.buffer.buffer,this.buffer.byteOffset+offset,32),size=view.getUint32(0,false);
      if(size<32||size>1048576){throw new Error('iAP package size invalid');}
      if(this.buffer.length-offset<size){break;}
      if(view.getUint32(16,false)===0x636f6d6d){bodies.push(this.buffer.slice(offset+32,offset+size));}
      if(bodies.length>256){throw new Error('iAP package count limit');}offset+=size;
    }this.buffer=this.buffer.slice(offset);return bodies;
  }
  clear():void{this.buffer.fill(0);this.buffer=new Uint8Array(0);}
}
