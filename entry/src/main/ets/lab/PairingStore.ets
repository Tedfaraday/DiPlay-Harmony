import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { util } from '@kit.ArkTS';

// Controller identifiers are encoded as preference keys; never log their values.
export class PairingStore {
  private store:preferences.Preferences;
  private base64:util.Base64Helper=new util.Base64Helper();
  private constructor(store:preferences.Preferences){this.store=store;}
  static async load(context:common.UIAbilityContext):Promise<PairingStore>{
    return new PairingStore(await preferences.getPreferences(context,{name:'diplay_controller_pairings'}));
  }
  async save(id:Uint8Array,key:Uint8Array):Promise<void>{
    if(id.length<1||id.length>256||key.length!==32){throw new Error('Invalid pairing record');}
    const name='controller_'+this.base64.encodeToStringSync(id);
    const existing=await this.store.has(name);
    if(!existing&&Object.keys(await this.store.getAll()).length>=16){throw new Error('Pairing store is full');}
    await this.store.put(name,this.base64.encodeToStringSync(key));await this.store.flush();
  }
  async get(id:Uint8Array):Promise<Uint8Array|undefined>{
    if(id.length<1||id.length>256){return undefined;}
    const encoded=await this.store.get('controller_'+this.base64.encodeToStringSync(id),'') as string;
    if(!encoded){return undefined;}const key=this.base64.decodeSync(encoded);return key.length===32?key:undefined;
  }
}
