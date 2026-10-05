// GPL-3.0-only. Adapted from DiPlay PairVerify.kt.
import { PairCrypto, ascii, concat, labelNonce, tlvDecode, tlvEncode, TlvItem } from './PairingCore';

export class KeyExchange {
  publicKey:Uint8Array;shared:Uint8Array;
  constructor(publicKey:Uint8Array,shared:Uint8Array){this.publicKey=publicKey;this.shared=shared;}
}
export interface VerifyCrypto extends PairCrypto {exchange(clientPublic:Uint8Array):Promise<KeyExchange>;}
export class ControlKeys {
  readKey:Uint8Array;writeKey:Uint8Array;
  constructor(readKey:Uint8Array,writeKey:Uint8Array){this.readKey=readKey;this.writeKey=writeKey;}
}
export class PairVerify {
  verified:boolean=false;lastError:string='';keys:ControlKeys|undefined;shared:Uint8Array|undefined;
  private crypto:VerifyCrypto;private pairingId:string;private lookup:(id:Uint8Array)=>Promise<Uint8Array|undefined>;
  private ownPublic:Uint8Array|undefined;private clientPublic:Uint8Array|undefined;private encryption:Uint8Array|undefined;
  private stage:number=1;private disposed:boolean=false;
  constructor(crypto:VerifyCrypto,pairingId:string,lookup:(id:Uint8Array)=>Promise<Uint8Array|undefined>){this.crypto=crypto;this.pairingId=pairingId;this.lookup=lookup;}
  async handle(body:Uint8Array):Promise<Uint8Array>{
    let state=0;
    try{
      if(this.disposed){throw new Error('Verification cancelled');}
      const tlv=tlvDecode(body),raw=tlv.get(6);if(!raw||raw.length!==1){throw new Error('Missing verification state');}
      state=raw[0];if(state!==this.stage){throw new Error('Unexpected verification state');}
      if(state===1){
        const client=tlv.get(3);if(!client||client.length!==32){throw new Error('Invalid X25519 public key');}
        const exchange=await this.crypto.exchange(client);let nonzero=0;for(let i=0;i<exchange.shared.length;i++){nonzero|=exchange.shared[i];}
        if(exchange.shared.length!==32||exchange.publicKey.length!==32||nonzero===0){throw new Error('Invalid X25519 shared secret');}
        this.shared=exchange.shared;this.ownPublic=exchange.publicKey;this.clientPublic=client;
        this.encryption=await this.crypto.hkdf(exchange.shared,ascii('Pair-Verify-Encrypt-Salt'),ascii('Pair-Verify-Encrypt-Info'));
        const id=ascii(this.pairingId),signature=await this.crypto.sign(concat([exchange.publicKey,id,client]));
        const encrypted=await this.crypto.seal(this.encryption,labelNonce('PV-Msg02'),tlvEncode([new TlvItem(1,id),new TlvItem(10,signature)]));
        this.stage=3;return tlvEncode([new TlvItem(6,new Uint8Array([2])),new TlvItem(3,exchange.publicKey),new TlvItem(5,encrypted)]);
      }
      if(state===3){
        const data=tlv.get(5);if(!data||!this.encryption||!this.shared||!this.ownPublic||!this.clientPublic){throw new Error('Missing verification data');}
        const sub=tlvDecode(await this.crypto.open(this.encryption,labelNonce('PV-Msg03'),data)),id=sub.get(1),signature=sub.get(10);
        if(!id||id.length<1||id.length>256||!signature||signature.length!==64){throw new Error('Invalid verification identity');}
        const publicKey=await this.lookup(id);if(!publicKey||!await this.crypto.verify(publicKey,concat([this.clientPublic,id,this.ownPublic]),signature)){throw new Error('Untrusted controller signature');}
        const read=await this.crypto.hkdf(this.shared,ascii('Control-Salt'),ascii('Control-Write-Encryption-Key'));
        const write=await this.crypto.hkdf(this.shared,ascii('Control-Salt'),ascii('Control-Read-Encryption-Key'));
        if(this.disposed){read.fill(0);write.fill(0);throw new Error('Verification cancelled');}
        this.keys=new ControlKeys(read,write);this.verified=true;this.stage=5;this.encryption.fill(0);this.encryption=undefined;
        return tlvEncode([new TlvItem(6,new Uint8Array([4]))]);
      }
      throw new Error('Unsupported verification state');
    }catch(error){this.lastError=(error as Error).message;this.dispose();return tlvEncode([new TlvItem(6,new Uint8Array([state+1])),new TlvItem(7,new Uint8Array([2]))]);}
    finally{if(this.disposed){this.dispose();}}
  }
  dispose():void{
    this.disposed=true;this.stage=0;this.verified=false;
    if(this.encryption){this.encryption.fill(0);this.encryption=undefined;}
    if(this.shared){this.shared.fill(0);this.shared=undefined;}
    if(this.keys){this.keys.readKey.fill(0);this.keys.writeKey.fill(0);this.keys=undefined;}
  }
}
