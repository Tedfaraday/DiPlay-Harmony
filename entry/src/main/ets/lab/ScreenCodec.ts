// GPL-3.0-only. Adapted from DiPlay ScreenStream.kt / ScreenCodec.
import { concat, ascii, equalBytes } from './PairingCore';
export class ScreenPacket {header:Uint8Array;body:Uint8Array;constructor(header:Uint8Array,body:Uint8Array){this.header=header;this.body=body;}}
class ScreenBlock {
  data:Uint8Array=new Uint8Array(65536);used:number=0;
}
// TCP callbacks are arbitrary fragments, not video frames. Bound bytes and normalize fragments
// into fixed blocks so a burst of tiny reads does not exhaust an object-count limit.
export class ScreenReceiveQueue {
  private blocks:ScreenBlock[]=[];
  size:number=0;
  push(bytes:Uint8Array):void{
    if(bytes.length>16*1024*1024-this.size){throw new Error('视频接收队列字节超限');}
    let offset=0;
    while(offset<bytes.length){
      let block=this.blocks[this.blocks.length-1];
      if(!block||block.used===block.data.length){block=new ScreenBlock();this.blocks.push(block);}
      const count=Math.min(bytes.length-offset,block.data.length-block.used);
      block.data.set(bytes.subarray(offset,offset+count),block.used);block.used+=count;offset+=count;this.size+=count;
    }
  }
  take():Uint8Array|undefined{
    const block=this.blocks.shift();if(!block){return undefined;}this.size-=block.used;return block.data.subarray(0,block.used);
  }
  clear():void{this.blocks=[];this.size=0;}
}
export class ScreenParser {
  private buffer:Uint8Array=new Uint8Array(0);
  feed(bytes:Uint8Array):ScreenPacket[]{
    if(this.buffer.length+bytes.length>16*1024*1024){throw new Error('Screen buffer limit');}this.buffer=concat([this.buffer,bytes]);
    const packets:ScreenPacket[]=[];let offset=0;
    while(this.buffer.length-offset>=128){
      const size=new DataView(this.buffer.buffer,this.buffer.byteOffset+offset,4).getUint32(0,true);
      if(size>8*1024*1024){throw new Error('Screen body limit');}if(this.buffer.length-offset<128+size){break;}
      // Yield a bounded batch and retain the rest for feed(empty), without discarding TCP data.
      if(packets.length>=64){break;}
      packets.push(new ScreenPacket(this.buffer.slice(offset,offset+128),this.buffer.slice(offset+128,offset+128+size)));offset+=128+size;
    }
    this.buffer=this.buffer.slice(offset);return packets;
  }
  clear():void{this.buffer.fill(0);this.buffer=new Uint8Array(0);}
}
export function h264Configuration(payload:Uint8Array):Uint8Array{
  let offset=0;for(let i=4;i+4<=Math.min(payload.length,256);i++){if(equalBytes(payload.slice(i,i+4),ascii('avcC'))){offset=i+4;break;}}
  const avc=payload.slice(offset);if(avc.length<7||avc[0]!==1||(avc[4]&3)!==3){throw new Error('Only 4-byte-length H.264 avcC is supported');}
  let at=6;const out:Uint8Array[]=[];
  function nal(type:number):void{
    if(at+2>avc.length){throw new Error('Truncated H.264 configuration');}const size=(avc[at]<<8)|avc[at+1];at+=2;
    if(size<1||at+size>avc.length||(avc[at]&31)!==type){throw new Error('Invalid H.264 parameter set');}
    out.push(new Uint8Array([0,0,0,1]),avc.slice(at,at+size));at+=size;
  }
  const sps=avc[5]&31;if(sps<1){throw new Error('Missing H.264 SPS');}for(let i=0;i<sps;i++){nal(7);}
  if(at>=avc.length){throw new Error('Missing H.264 PPS');}const pps=avc[at++];if(pps<1){throw new Error('Missing H.264 PPS');}for(let i=0;i<pps;i++){nal(8);}return concat(out);
}
export function annexB(payload:Uint8Array):Uint8Array{
  if(payload.length>=4&&payload[0]===0&&payload[1]===0&&payload[2]===0&&payload[3]===1){return payload;}
  const bytes=payload.slice();let at=0;while(at<bytes.length){
    if(at+4>bytes.length){throw new Error('Truncated H.264 NAL length');}const size=new DataView(bytes.buffer,bytes.byteOffset+at,4).getUint32(0,false);
    if(size<1||at+4+size>bytes.length){throw new Error('Invalid H.264 NAL size');}bytes.set(new Uint8Array([0,0,0,1]),at);at+=4+size;
  }
  if(bytes.length===0){throw new Error('Empty H.264 frame');}return bytes;
}
export function screenNonce(counter:bigint):Uint8Array{
  if(counter< BigInt(0)||counter>BigInt('18446744073709551615')){throw new Error('Screen nonce exhausted');}
  const nonce=new Uint8Array(12);let value=counter;for(let i=4;i<12;i++){nonce[i]=Number(value&BigInt(255));value>>=BigInt(8);}return nonce;
}
