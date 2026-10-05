// Experimental local identity from the user's DiPlay APK; never developer signing keys.
import { common } from '@kit.AbilityKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { ecdsaDerToRaw } from './Iap2Control';

export class ExperimentalAuth {
  certificate: Uint8Array;
  private privateKey: cryptoFramework.PriKey;
  private constructor(certificate: Uint8Array, key: cryptoFramework.PriKey) {
    this.certificate = certificate; this.privateKey = key;
  }
  static async load(context: common.UIAbilityContext): Promise<ExperimentalAuth> {
    const manager = context.resourceManager;
    const encodedKey = await manager.getRawFileContent('offline-mfi/identity.pk8');
    const publicKey = await manager.getRawFileContent('offline-mfi/public-key.der');
    const certificate = await manager.getRawFileContent('offline-mfi/certificate.p7b');
    if (certificate.length < 1 || certificate.length > 16384 || encodedKey.length > 16384) {
      encodedKey.fill(0); throw new Error('invalid experimental identity size');
    }
    let pair: cryptoFramework.KeyPair;
    try { pair = await cryptoFramework.createAsyKeyGenerator('ECC256').convertKey({ data: publicKey }, { data: encodedKey }); }
    finally { encodedKey.fill(0); }
    // A key consistency check; iPhone trust is established only by AA05.
    const digest = cryptoFramework.createRandom().generateRandomSync(32);
    const signer = cryptoFramework.createSign('ECC256|SHA256|OnlySign');
    await signer.init(pair.priKey); const signature = await signer.sign(digest);
    const verifier = cryptoFramework.createVerify('ECC256|SHA256|OnlyVerify');
    await verifier.init(pair.pubKey);
    if (!await verifier.verify(digest, signature)) { throw new Error('experimental key/certificate mismatch'); }
    return new ExperimentalAuth(certificate, pair.priKey);
  }
  async sign(challenge: Uint8Array): Promise<Uint8Array> {
    if (challenge.length !== 32) { throw new Error('MFi v3 requires a 32-byte digest'); }
    const signer = cryptoFramework.createSign('ECC256|SHA256|OnlySign');
    await signer.init(this.privateKey);
    const signature = await signer.sign({ data: challenge });
    return ecdsaDerToRaw(signature.data);
  }
}
