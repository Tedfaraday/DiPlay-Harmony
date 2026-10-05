import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { concat } from './PairingCore';
import { KeyExchange } from './PairVerify';
import { MfiCrypto } from './MfiSap';
import { ReceiverIdentity } from './ReceiverIdentity';

export class NativePairCrypto implements MfiCrypto {
  private identity:ReceiverIdentity;
  constructor(identity:ReceiverIdentity){this.identity=identity;}
  random(length:number):Uint8Array{return cryptoFramework.createRandom().generateRandomSync(length).data;}
  async sha512(parts:Uint8Array[]):Promise<Uint8Array>{
    const md=cryptoFramework.createMd('SHA512');for(let i=0;i<parts.length;i++){await md.update({data:parts[i]});}return (await md.digest()).data;
  }
  async digest(algorithm:string,parts:Uint8Array[]):Promise<Uint8Array>{
    if(!['SHA1','SHA256'].includes(algorithm)){throw new Error('Unsupported MFiSAP digest');}
    const md=cryptoFramework.createMd(algorithm);for(let i=0;i<parts.length;i++){await md.update({data:parts[i]});}return (await md.digest()).data;
  }
  async aesCtr(key:Uint8Array,iv:Uint8Array,data:Uint8Array):Promise<Uint8Array>{
    if(key.length!==16||iv.length!==16){throw new Error('Invalid AES-CTR key/IV');}
    const sym=await cryptoFramework.createSymKeyGenerator('AES128').convertKey({data:key});
    const cipher=cryptoFramework.createCipher('AES128|CTR|NoPadding');
    const params:cryptoFramework.IvParamsSpec={algName:'IvParamsSpec',iv:{data:iv}};
    await cipher.init(cryptoFramework.CryptoMode.ENCRYPT_MODE,sym,params);return (await cipher.doFinal({data:data})).data;
  }
  async hkdf(key:Uint8Array,salt:Uint8Array,info:Uint8Array):Promise<Uint8Array>{
    const spec:cryptoFramework.HKDFSpec={algName:'HKDF',key:key,salt:salt,info:info,keySize:32};
    return (await cryptoFramework.createKdf('HKDF|SHA512').generateSecret(spec)).data;
  }
  async sign(data:Uint8Array):Promise<Uint8Array>{
    const signer=cryptoFramework.createSign('Ed25519');await signer.init(this.identity.keys.priKey);return (await signer.sign({data:data})).data;
  }
  async verify(publicKey:Uint8Array,data:Uint8Array,signature:Uint8Array):Promise<boolean>{
    if(publicKey.length!==32||signature.length!==64){return false;}
    const spki=concat([new Uint8Array([48,42,48,5,6,3,43,101,112,3,33,0]),publicKey]);
    const pair=await cryptoFramework.createAsyKeyGenerator('Ed25519').convertKey({data:spki},null);
    const verifier=cryptoFramework.createVerify('Ed25519');await verifier.init(pair.pubKey);return verifier.verify({data:data},{data:signature});
  }
  async exchange(clientPublic:Uint8Array):Promise<KeyExchange>{
    if(clientPublic.length!==32){throw new Error('Invalid X25519 public key');}
    const generator=cryptoFramework.createAsyKeyGenerator('X25519'),own=await generator.generateKeyPair();
    const peer=await generator.convertKey({data:concat([new Uint8Array([48,42,48,5,6,3,43,101,110,3,33,0]),clientPublic])},null);
    const shared=await cryptoFramework.createKeyAgreement('X25519').generateSecret(own.priKey,peer.pubKey);
    return new KeyExchange(own.pubKey.getEncoded().data.slice(12),shared.data);
  }
  async seal(key:Uint8Array,nonce:Uint8Array,data:Uint8Array,aad?:Uint8Array):Promise<Uint8Array>{
    if(key.length!==32||nonce.length!==12){throw new Error('Invalid ChaCha key/nonce');}
    const sym=await cryptoFramework.createSymKeyGenerator('ChaCha20').convertKey({data:key});
    const params:cryptoFramework.Poly1305ParamsSpec={algName:'Poly1305ParamsSpec',iv:{data:nonce},aad:{data:aad??new Uint8Array(0)},authTag:{data:new Uint8Array(16)}};
    const cipher=cryptoFramework.createCipher('ChaCha20|Poly1305');await cipher.init(cryptoFramework.CryptoMode.ENCRYPT_MODE,sym,params);
    const ciphertext=await cipher.update({data:data}),tag=await cipher.doFinal(null);return concat([ciphertext.data,tag.data]);
  }
  async open(key:Uint8Array,nonce:Uint8Array,data:Uint8Array,aad?:Uint8Array):Promise<Uint8Array>{
    if(key.length!==32||nonce.length!==12||data.length<16){throw new Error('Invalid ChaCha frame');}
    const sym=await cryptoFramework.createSymKeyGenerator('ChaCha20').convertKey({data:key});
    const params:cryptoFramework.Poly1305ParamsSpec={algName:'Poly1305ParamsSpec',iv:{data:nonce},aad:{data:aad??new Uint8Array(0)},authTag:{data:data.slice(data.length-16)}};
    const cipher=cryptoFramework.createCipher('ChaCha20|Poly1305');await cipher.init(cryptoFramework.CryptoMode.DECRYPT_MODE,sym,params);
    const plain=await cipher.update({data:data.slice(0,data.length-16)});
    try{await cipher.doFinal(null);return plain.data;}catch(error){plain.data.fill(0);throw new Error('ChaCha authentication failed');}
  }
}
