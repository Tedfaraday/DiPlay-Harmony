import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';

export class ReceiverIdentity {
  pairingId: string;
  publicKeyHex: string;
  keys: cryptoFramework.KeyPair;
  private constructor(pairingId: string, keys: cryptoFramework.KeyPair) {
    this.pairingId = pairingId; this.keys = keys;
    const encoded = keys.pubKey.getEncoded().data;
    const prefix = [48,42,48,5,6,3,43,101,112,3,33,0];
    if (encoded.length !== 44 || prefix.some((value: number, index: number): boolean => encoded[index] !== value)) {
      throw new Error('Unexpected Ed25519 SPKI format');
    }
    let hex = ''; for (let i = 12; i < encoded.length; i++) { hex += encoded[i].toString(16).padStart(2,'0'); }
    this.publicKeyHex = hex;
  }
  static async load(context: common.UIAbilityContext): Promise<ReceiverIdentity> {
    const store = await preferences.getPreferences(context, {name:'diplay_receiver_identity'});
    const generator = cryptoFramework.createAsyKeyGenerator('Ed25519');
    const base64 = new util.Base64Helper();
    const privateText = await store.get('privateKey', '') as string;
    const publicText = await store.get('publicKey', '') as string;
    const pairingId = await store.get('pairingId', '') as string;
    if (privateText && publicText && pairingId) {
      const encodedPrivate = base64.decodeSync(privateText);
      try {
        return new ReceiverIdentity(pairingId,await generator.convertKey({data:base64.decodeSync(publicText)},{data:encodedPrivate}));
      } finally { encodedPrivate.fill(0); }
    }
    const pair = await generator.generateKeyPair();
    const identity = new ReceiverIdentity(util.generateRandomUUID(),pair);
    const encodedPrivate = pair.priKey.getEncoded().data;
    try { await store.put('privateKey',base64.encodeToStringSync(encodedPrivate)); }
    finally { encodedPrivate.fill(0); }
    await store.put('publicKey',base64.encodeToStringSync(pair.pubKey.getEncoded().data));
    await store.put('pairingId',identity.pairingId); await store.flush(); return identity;
  }
}
