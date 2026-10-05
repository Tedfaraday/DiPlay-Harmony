// GPL-3.0-only. Adapted from DiPlay BplistCodec.kt with bounded decoding.
import { ascii, concat, equalBytes } from './PairingCore';
export class Plist {
  kind:string;integer:bigint=BigInt(0);real:number=0;text:string='';boolean:boolean=false;
  data:Uint8Array=new Uint8Array(0);items:Plist[]=[];entries:Map<string,Plist>=new Map<string,Plist>();
  constructor(kind:string){this.kind=kind;}
  static int(value:number|bigint):Plist{const node=new Plist('int');node.integer=BigInt(value);return node;}
  static str(value:string):Plist{const node=new Plist('str');node.text=value;return node;}
  static bool(value:boolean):Plist{const node=new Plist('bool');node.boolean=value;return node;}
  static bytes(value:Uint8Array):Plist{const node=new Plist('data');node.data=value;return node;}
  static array(value:Plist[]):Plist{const node=new Plist('array');node.items=value;return node;}
  static dict(keys:string[],values:Plist[]):Plist{
    if(keys.length!==values.length){throw new Error('Plist dictionary mismatch');}const node=new Plist('dict');
    for(let i=0;i<keys.length;i++){if(node.entries.has(keys[i])){throw new Error('Duplicate plist key');}node.entries.set(keys[i],values[i]);}return node;
  }
  number():number{if(this.kind!=='int'||this.integer<BigInt(0)||this.integer>BigInt(Number.MAX_SAFE_INTEGER)){throw new Error('Invalid plist integer');}return Number(this.integer);}
}
function be(value:bigint,size:number):Uint8Array{
  if(value<BigInt(0)||value>=(BigInt(1)<<BigInt(size*8))){throw new Error('Plist integer exceeds field');}
  const result=new Uint8Array(size);let remaining=value;for(let i=size-1;i>=0;i--){result[i]=Number(remaining&BigInt(255));remaining>>=BigInt(8);}return result;
}
function width(value:bigint):number{if(value<=BigInt(255)){return 1;}if(value<=BigInt(65535)){return 2;}if(value<=BigInt('4294967295')){return 4;}return 8;}
function int(value:bigint):Uint8Array{if(value<BigInt(0)){const data=new Uint8Array(8);new DataView(data.buffer).setFloat64(0,Number(value),false);return concat([new Uint8Array([35]),data]);}
  const size=width(value);return concat([new Uint8Array([16+Math.log2(size)]),be(value,size)]);}
function marker(type:number,count:number):Uint8Array{return count<15?new Uint8Array([type*16+count]):concat([new Uint8Array([type*16+15]),int(BigInt(count))]);}
class EncodedNode {head:Uint8Array;refs:number[];constructor(head:Uint8Array,refs:number[]=[]){this.head=head;this.refs=refs;}}
export function encodePlist(root:Plist):Uint8Array{
  const nodes:EncodedNode[]=[];const ancestors:Plist[]=[];
  function add(value:Plist,depth:number):number{
    if(depth>32||nodes.length>=2048||ancestors.includes(value)){throw new Error('Plist object/depth limit');}
    const index=nodes.length;nodes.push(new EncodedNode(new Uint8Array(0)));ancestors.push(value);
    if(value.kind==='int'){nodes[index]=new EncodedNode(int(value.integer));}
    else if(value.kind==='bool'){nodes[index]=new EncodedNode(new Uint8Array([value.boolean?9:8]));}
    else if(value.kind==='null'){nodes[index]=new EncodedNode(new Uint8Array([0]));}
    else if(value.kind==='real'){const bytes=new Uint8Array(8);new DataView(bytes.buffer).setFloat64(0,value.real,false);nodes[index]=new EncodedNode(concat([new Uint8Array([35]),bytes]));}
    else if(value.kind==='data'){nodes[index]=new EncodedNode(concat([marker(4,value.data.length),value.data]));}
    else if(value.kind==='str'){
      let isAscii=true;for(let i=0;i<value.text.length;i++){if(value.text.charCodeAt(i)>127){isAscii=false;break;}}
      if(isAscii){nodes[index]=new EncodedNode(concat([marker(5,value.text.length),ascii(value.text)]));}
      else{const bytes=new Uint8Array(value.text.length*2);for(let i=0;i<value.text.length;i++){const ch=value.text.charCodeAt(i);bytes[i*2]=ch>>>8;bytes[i*2+1]=ch&255;}
        nodes[index]=new EncodedNode(concat([marker(6,value.text.length),bytes]));}
    }else if(value.kind==='array'){const refs:number[]=[];for(let i=0;i<value.items.length;i++){refs.push(add(value.items[i],depth+1));}nodes[index]=new EncodedNode(marker(10,refs.length),refs);}
    else if(value.kind==='dict'){
      const keys=Array.from(value.entries.keys()),refs:number[]=[];for(let i=0;i<keys.length;i++){refs.push(add(Plist.str(keys[i]),depth+1));}
      for(let i=0;i<keys.length;i++){const child=value.entries.get(keys[i]);if(!child){throw new Error('Missing plist value');}refs.push(add(child,depth+1));}
      nodes[index]=new EncodedNode(marker(13,keys.length),refs);
    }else{throw new Error('Unsupported plist value');}
    ancestors.pop();return index;
  }
  const top=add(root,0),refSize=width(BigInt(nodes.length-1)),parts:Uint8Array[]=[ascii('bplist00')],offsets:number[]=[];let cursor=8;
  for(let i=0;i<nodes.length;i++){
    offsets.push(cursor);const node=nodes[i],refs:Uint8Array[]=[];for(let j=0;j<node.refs.length;j++){refs.push(be(BigInt(node.refs[j]),refSize));}
    const bytes=concat([node.head,...refs]);parts.push(bytes);cursor+=bytes.length;if(cursor>65536){throw new Error('Plist output limit');}
  }
  const offsetSize=width(BigInt(cursor)),table=cursor;
  for(let i=0;i<offsets.length;i++){parts.push(be(BigInt(offsets[i]),offsetSize));}
  const trailer=new Uint8Array(32);trailer[6]=offsetSize;trailer[7]=refSize;trailer.set(be(BigInt(nodes.length),8),8);trailer.set(be(BigInt(top),8),16);trailer.set(be(BigInt(table),8),24);parts.push(trailer);
  const result=concat(parts);if(result.length>65536){throw new Error('Plist output limit');}return result;
}
export function decodePlist(bytes:Uint8Array):Plist{
  if(bytes.length<40||bytes.length>65536||!equalBytes(bytes.slice(0,8),ascii('bplist00'))){throw new Error('Invalid bplist header/size');}
  function read(at:number,size:number,limit:number=bytes.length):bigint{
    if(size<1||size>16||at<0||at+size>limit){throw new Error('Truncated bplist integer');}
    let value=BigInt(0);for(let i=0;i<size;i++){value=(value<<BigInt(8))|BigInt(bytes[at+i]);}return value;
  }
  function count(at:number,size:number,limit:number=bytes.length):number{const value=read(at,size,limit);if(value>BigInt(65536)){throw new Error('Bplist count limit');}return Number(value);}
  const trailer=bytes.length-32,offsetSize=bytes[trailer+6],refSize=bytes[trailer+7];
  if(![1,2,4,8].includes(offsetSize)||![1,2,4,8].includes(refSize)){throw new Error('Invalid bplist field width');}
  const total=count(trailer+8,8),top=count(trailer+16,8),table=count(trailer+24,8);
  if(total<1||total>2048||top>=total||table<8||table+total*offsetSize>trailer){throw new Error('Invalid bplist offset table');}
  const offsets:number[]=[];for(let i=0;i<total;i++){const offset=count(table+i*offsetSize,offsetSize,trailer);if(offset<8||offset>=table){throw new Error('Invalid bplist object offset');}offsets.push(offset);}
  const cache:Map<number,Plist>=new Map<number,Plist>(),active:Set<number>=new Set<number>();let visited=0;
  function object(index:number,depth:number):Plist{
    if(index<0||index>=total||depth>32||active.has(index)||++visited>8192){throw new Error('Bplist reference/depth limit');}
    const previous=cache.get(index);if(previous){return previous;}active.add(index);
    let at=offsets[index];const byte=bytes[at++],type=byte>>>4,nibble=byte&15;let node:Plist;
    function length():number{
      if(nibble!==15){return nibble;}if(at>=table){throw new Error('Missing bplist length');}const m=bytes[at++];
      if((m>>>4)!==1||(m&15)>3){throw new Error('Invalid bplist length marker');}const size=1<<(m&15),n=count(at,size,table);at+=size;return n;
    }
    function span(size:number):void{if(at+size>table){throw new Error('Truncated bplist object');}}
    if(type===0&&[0,8,9].includes(nibble)){node=nibble===0?new Plist('null'):Plist.bool(nibble===9);}
    else if(type===1||type===8){const size=type===8?nibble+1:1<<nibble;const value=read(at,size,table);if(value>BigInt('18446744073709551615')){throw new Error('Bplist integer exceeds uint64');}node=Plist.int(value);}
    else if(type===2){const size=1<<nibble;if(![4,8].includes(size)){throw new Error('Invalid bplist real');}span(size);node=new Plist('real');const view=new DataView(bytes.buffer,bytes.byteOffset+at,size);node.real=size===4?view.getFloat32(0,false):view.getFloat64(0,false);}
    else if(type===4){const n=length();span(n);node=Plist.bytes(bytes.slice(at,at+n));}
    else if(type===5||type===6){const n=length(),unit=type===5?1:2;span(n*unit);let text='';for(let i=0;i<n;i++){
      const ch=unit===1?bytes[at+i]:(bytes[at+i*2]<<8)|bytes[at+i*2+1];if(unit===1&&ch>127){throw new Error('Invalid plist ASCII');}text+=String.fromCharCode(ch);}
      node=Plist.str(text);
    }else if(type===10||type===12||type===13){
      const n=length();if(n>2048){throw new Error('Bplist container limit');}span(n*refSize*(type===13?2:1));
      if(type===13){const keys:string[]=[],values:Plist[]=[];for(let i=0;i<n;i++){const key=object(count(at+i*refSize,refSize,table),depth+1);if(key.kind!=='str'){throw new Error('Non-string plist key');}keys.push(key.text);values.push(object(count(at+(i+n)*refSize,refSize,table),depth+1));}node=Plist.dict(keys,values);}
      else{const items:Plist[]=[];for(let i=0;i<n;i++){items.push(object(count(at+i*refSize,refSize,table),depth+1));}node=Plist.array(items);}
    }else{throw new Error('Unsupported bplist object');}
    active.delete(index);cache.set(index,node);return node;
  }
  return object(top,0);
}
