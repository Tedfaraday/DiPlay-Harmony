// GPL-3.0-only. Adapted from DiPlay PairSetup.kt, Srp6a.kt and Tlv8Codec.kt.
export function concat(parts: Uint8Array[]): Uint8Array {
  let size=0;for(let i=0;i<parts.length;i++){size+=parts[i].length;}
  const result=new Uint8Array(size);let offset=0;for(let i=0;i<parts.length;i++){result.set(parts[i],offset);offset+=parts[i].length;}return result;
}
export function ascii(text:string):Uint8Array {
  const bytes=new Uint8Array(text.length);for(let i=0;i<text.length;i++){if(text.charCodeAt(i)>127){throw new Error('Expected ASCII');}bytes[i]=text.charCodeAt(i);}return bytes;
}
export function labelNonce(label:string):Uint8Array {const bytes=new Uint8Array(12);bytes.set(ascii(label).slice(0,8),4);return bytes;}
export function equalBytes(a:Uint8Array,b:Uint8Array):boolean {if(a.length!==b.length){return false;}let diff=0;for(let i=0;i<a.length;i++){diff|=a[i]^b[i];}return diff===0;}

export class TlvItem {
  type:number;value:Uint8Array;
  constructor(type:number,value:Uint8Array){this.type=type;this.value=value;}
}
export function tlvEncode(items:TlvItem[]):Uint8Array {
  const parts:Uint8Array[]=[];let previous=-1;
  for(let i=0;i<items.length;i++){
    const item=items[i];if(item.type<0||item.type>254){throw new Error('Invalid TLV8 type');}
    if(item.type===previous){parts.push(new Uint8Array([255,0]));}
    let offset=0;do{const length=Math.min(255,item.value.length-offset);parts.push(new Uint8Array([item.type,length]),item.value.slice(offset,offset+length));offset+=length;}while(offset<item.value.length);
    previous=item.type;
  }
  return concat(parts);
}
export function tlvDecode(bytes:Uint8Array):Map<number,Uint8Array> {
  if(bytes.length>16384){throw new Error('TLV8 buffer limit');}
  const result=new Map<number,Uint8Array>();let offset=0,previous=-1,previousLength=0;
  while(offset<bytes.length){
    if(offset+2>bytes.length){throw new Error('Truncated TLV8 header');}
    const type=bytes[offset],length=bytes[offset+1];offset+=2;
    if(offset+length>bytes.length){throw new Error('Truncated TLV8 value');}
    const value=bytes.slice(offset,offset+length);offset+=length;
    if(type===255){if(length!==0){throw new Error('Invalid TLV8 separator');}previous=-1;previousLength=0;continue;}
    const existing=result.get(type);
    if(type===previous&&previousLength===255&&existing){result.set(type,concat([existing,value]));}
    else{if(existing){throw new Error('Duplicate TLV8 parameter');}result.set(type,value);}
    previous=type;previousLength=length;
  }
  return result;
}

export interface PairCrypto {
  random(length:number):Uint8Array;
  sha512(parts:Uint8Array[]):Promise<Uint8Array>;
  hkdf(key:Uint8Array,salt:Uint8Array,info:Uint8Array):Promise<Uint8Array>;
  sign(data:Uint8Array):Promise<Uint8Array>;
  verify(publicKey:Uint8Array,data:Uint8Array,signature:Uint8Array):Promise<boolean>;
  seal(key:Uint8Array,nonce:Uint8Array,data:Uint8Array,aad?:Uint8Array):Promise<Uint8Array>;
  open(key:Uint8Array,nonce:Uint8Array,data:Uint8Array,aad?:Uint8Array):Promise<Uint8Array>;
}

export const SRP_N=BigInt('0x'+
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74'+
  '020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437'+
  '4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED'+
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05'+
  '98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB'+
  '9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B'+
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183'+
  '995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33A'+
  '85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7AB'+
  'F5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D8'+
  '7602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208'+
  'E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF');

export function bigFromBytes(bytes:Uint8Array):bigint {
  let value=BigInt(0);for(let i=0;i<bytes.length;i++){value=(value<<BigInt(8))|BigInt(bytes[i]);}return value;
}
export function bigBytes(value:bigint,pad:boolean=false):Uint8Array {
  let hex=value.toString(16);if(hex.length%2){hex='0'+hex;}
  const count=pad?384:hex.length/2;if(hex.length>count*2){throw new Error('SRP integer exceeds group');}
  const bytes=new Uint8Array(count),start=count-hex.length/2;
  for(let i=0;i<hex.length/2;i++){bytes[start+i]=parseInt(hex.slice(i*2,i*2+2),16);}return bytes;
}
export function modPow(base:bigint,exponent:bigint,modulus:bigint):bigint {
  let result=BigInt(1),value=base%modulus,power=exponent;
  while(power>BigInt(0)){if((power&BigInt(1))!==BigInt(0)){result=(result*value)%modulus;}value=(value*value)%modulus;power>>=BigInt(1);}return result;
}

export class SrpSession {
  salt:Uint8Array;publicKey:Uint8Array;
  private verifier:bigint;private secret:bigint;private crypto:PairCrypto;
  private constructor(salt:Uint8Array,publicKey:Uint8Array,verifier:bigint,secret:bigint,crypto:PairCrypto){
    this.salt=salt;this.publicKey=publicKey;this.verifier=verifier;this.secret=secret;this.crypto=crypto;
  }
  static async start(crypto:PairCrypto):Promise<SrpSession>{
    const salt=crypto.random(16),privateBytes=crypto.random(32),g=BigInt(5);
    const secret=bigFromBytes(privateBytes);privateBytes.fill(0);if(secret===BigInt(0)){throw new Error('SRP random exponent is zero');}
    const multiplier=bigFromBytes(await crypto.sha512([bigBytes(SRP_N),bigBytes(g,true)]));
    const x=bigFromBytes(await crypto.sha512([salt,await crypto.sha512([ascii('Pair-Setup:3939')])]));
    const verifier=modPow(g,x,SRP_N),publicKey=(multiplier*verifier+modPow(g,secret,SRP_N))%SRP_N;
    return new SrpSession(salt,bigBytes(publicKey,true),verifier,secret,crypto);
  }
  async verify(clientPublic:Uint8Array,proof:Uint8Array):Promise<SrpResult>{
    if(clientPublic.length!==384||proof.length!==64){throw new Error('Invalid SRP proof size');}
    const a=bigFromBytes(clientPublic);if(a<=BigInt(0)||a>=SRP_N){throw new Error('Invalid SRP client public key');}
    const u=bigFromBytes(await this.crypto.sha512([bigBytes(a,true),this.publicKey]));if(u===BigInt(0)){throw new Error('Invalid SRP scrambling parameter');}
    const s=modPow((a*modPow(this.verifier,u,SRP_N))%SRP_N,this.secret,SRP_N);
    const key=await this.crypto.sha512([bigBytes(s)]);
    const hn=await this.crypto.sha512([bigBytes(SRP_N)]),hg=await this.crypto.sha512([bigBytes(BigInt(5))]);
    for(let i=0;i<hn.length;i++){hn[i]^=hg[i];}
    const expected=await this.crypto.sha512([hn,await this.crypto.sha512([ascii('Pair-Setup')]),this.salt,bigBytes(a,true),this.publicKey,key]);
    if(!equalBytes(expected,proof)){key.fill(0);throw new Error('SRP client proof mismatch');}
    return new SrpResult(key,await this.crypto.sha512([bigBytes(a,true),proof,key]));
  }
}
export class SrpResult {
  key:Uint8Array;proof:Uint8Array;
  constructor(key:Uint8Array,proof:Uint8Array){this.key=key;this.proof=proof;}
}

export class PairSetup {
  complete:boolean=false;lastError:string='';
  private stage:number=1;private crypto:PairCrypto;private pairingId:string;private publicKey:Uint8Array;
  private store:(id:Uint8Array,key:Uint8Array)=>Promise<void>;
  private srp:SrpSession|undefined;private key:Uint8Array|undefined;
  private disposed:boolean=false;
  constructor(crypto:PairCrypto,pairingId:string,publicKey:Uint8Array,store:(id:Uint8Array,key:Uint8Array)=>Promise<void>){
    this.crypto=crypto;this.pairingId=pairingId;this.publicKey=publicKey;this.store=store;
  }
  async handle(body:Uint8Array):Promise<Uint8Array>{
    let state=0;
    try{
      if(this.disposed){throw new Error('Pairing cancelled');}
      const tlv=tlvDecode(body),rawState=tlv.get(6);if(!rawState||rawState.length!==1){throw new Error('Missing pairing state');}
      state=rawState[0];if(state!==this.stage){throw new Error('Unexpected pairing state');}
      if(state===1){
        this.srp=await SrpSession.start(this.crypto);this.stage=3;
        return tlvEncode([new TlvItem(6,new Uint8Array([2])),new TlvItem(3,this.srp.publicKey),new TlvItem(2,this.srp.salt)]);
      }
      if(state===3){
        const a=tlv.get(3),proof=tlv.get(4);if(!a||!proof||!this.srp){throw new Error('Missing SRP proof');}
        const result=await this.srp.verify(a,proof);this.key=result.key;this.stage=5;this.srp=undefined;
        return tlvEncode([new TlvItem(6,new Uint8Array([4])),new TlvItem(4,result.proof)]);
      }
      if(state===5){
        const encrypted=tlv.get(5);if(!this.key||!encrypted){throw new Error('Missing encrypted pairing data');}
        const key=this.key,encryption=await this.crypto.hkdf(key,ascii('Pair-Setup-Encrypt-Salt'),ascii('Pair-Setup-Encrypt-Info'));
        const plain=await this.crypto.open(encryption,labelNonce('PS-Msg05'),encrypted),sub=tlvDecode(plain);
        const id=sub.get(1),publicKey=sub.get(3),signature=sub.get(10);
        if(!id||id.length<1||id.length>256||!publicKey||publicKey.length!==32||!signature||signature.length!==64){throw new Error('Invalid controller identity');}
        const signKey=await this.crypto.hkdf(key,ascii('Pair-Setup-Controller-Sign-Salt'),ascii('Pair-Setup-Controller-Sign-Info'));
        if(!await this.crypto.verify(publicKey,concat([signKey,id,publicKey]),signature)){throw new Error('Controller signature mismatch');}
        const accessoryId=ascii(this.pairingId),accessoryKey=await this.crypto.hkdf(key,ascii('Pair-Setup-Accessory-Sign-Salt'),ascii('Pair-Setup-Accessory-Sign-Info'));
        const accessorySignature=await this.crypto.sign(concat([accessoryKey,accessoryId,this.publicKey]));
        const response=tlvEncode([new TlvItem(1,accessoryId),new TlvItem(3,this.publicKey),new TlvItem(10,accessorySignature)]);
        const sealed=await this.crypto.seal(encryption,labelNonce('PS-Msg06'),response);
        if(this.disposed){throw new Error('Pairing cancelled');}
        await this.store(id,publicKey);this.complete=true;this.stage=7;key.fill(0);this.key=undefined;
        return tlvEncode([new TlvItem(6,new Uint8Array([6])),new TlvItem(5,sealed)]);
      }
      throw new Error('Unsupported pairing state');
    }catch(error){
      this.lastError=(error as Error).message;this.stage=0;this.srp=undefined;if(this.key){this.key.fill(0);this.key=undefined;}
      return tlvEncode([new TlvItem(6,new Uint8Array([state+1])),new TlvItem(7,new Uint8Array([2]))]);
    }finally{if(this.disposed){this.dispose();}}
  }
  dispose():void{this.disposed=true;this.stage=0;this.srp=undefined;if(this.key){this.key.fill(0);this.key=undefined;}}
}
