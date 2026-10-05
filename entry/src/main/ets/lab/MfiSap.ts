// GPL-3.0-only. Adapted from DiPlay MfiSapAuthSetup.kt (local MFi v3 path).
import { VerifyCrypto } from './PairVerify';
import { concat, ascii } from './PairingCore';
export interface MfiCrypto extends VerifyCrypto {
  digest(algorithm:string,parts:Uint8Array[]):Promise<Uint8Array>;
  aesCtr(key:Uint8Array,iv:Uint8Array,data:Uint8Array):Promise<Uint8Array>;
}
export interface CertificateSigner {certificate:Uint8Array;sign(challenge:Uint8Array):Promise<Uint8Array>;}
function size(value:number):Uint8Array{return new Uint8Array([value>>>24,(value>>>16)&255,(value>>>8)&255,value&255]);}
export async function mfiSap(body:Uint8Array,crypto:MfiCrypto,auth:CertificateSigner):Promise<Uint8Array>{
  if(body.length!==33||body[0]!==1){throw new Error('Invalid MFiSAP request');}
  if(auth.certificate.length<1||auth.certificate.length>16384){throw new Error('Invalid MFiSAP certificate');}
  const client=body.slice(1),exchange=await crypto.exchange(client);let nonzero=0;for(let i=0;i<exchange.shared.length;i++){nonzero|=exchange.shared[i];}
  if(nonzero===0||exchange.shared.length!==32||exchange.publicKey.length!==32){exchange.shared.fill(0);throw new Error('Invalid MFiSAP shared secret');}
  let key:Uint8Array|undefined,iv:Uint8Array|undefined;
  try{
    key=(await crypto.digest('SHA1',[ascii('AES-KEY'),exchange.shared])).slice(0,16);
    iv=(await crypto.digest('SHA1',[ascii('AES-IV'),exchange.shared])).slice(0,16);
    const signature=await auth.sign(await crypto.digest('SHA256',[exchange.publicKey,client]));
    if(signature.length!==64){throw new Error('Invalid MFiSAP signature');}
    const encrypted=await crypto.aesCtr(key,iv,signature);signature.fill(0);
    return concat([exchange.publicKey,size(auth.certificate.length),auth.certificate,size(encrypted.length),encrypted]);
  }finally{exchange.shared.fill(0);if(key){key.fill(0);}if(iv){iv.fill(0);}}
}
