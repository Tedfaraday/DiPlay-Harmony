import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { asset } from '@kit.AssetStoreKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { ConnectionProfile, decodeProfile } from './ConnectionProfile';
export class SavedProfile {
  profile:ConnectionProfile;password:string;secretUnavailable:boolean;
  constructor(profile:ConnectionProfile,password:string,unavailable:boolean=false){this.profile=profile;this.password=password;this.secretUnavailable=unavailable;}
}
class HotspotSecret {ssid:string='';password:string='';constructor(ssid:string,password:string){this.ssid=ssid;this.password=password;}}
export class ProfileStore {
  private store:preferences.Preferences;private saving:Promise<void>=Promise.resolve();
  private constructor(store:preferences.Preferences){this.store=store;}
  static async open(context:common.UIAbilityContext):Promise<ProfileStore>{
    return new ProfileStore(await preferences.getPreferences(context,{name:'diplay_connection_profile'}));
  }
  private alias():asset.AssetMap {
    const query:asset.AssetMap=new Map();query.set(asset.Tag.ALIAS,new util.TextEncoder().encodeInto('diplay-hotspot-v1'));return query;
  }
  async load():Promise<SavedProfile>{
    const profile=decodeProfile(await this.store.get('profile','') as string);let password='',unavailable=false;
    if(profile.rememberPassword){
      try{const query=this.alias();query.set(asset.Tag.RETURN_TYPE,asset.ReturnType.ALL);const found=await asset.query(query);
        if(found.length!==1){unavailable=true;}else{const value=found[0].get(asset.Tag.SECRET);
          if(value instanceof Uint8Array){try{const secret=JSON.parse(util.TextDecoder.create('utf-8').decodeToString(value)) as HotspotSecret;
            if(secret.ssid===profile.ssid&&typeof secret.password==='string'&&secret.password.length<=63){password=secret.password;}else{unavailable=true;}}
            finally{value.fill(0);}}else{unavailable=true;}}
      }catch(_error){unavailable=true;}
    }return new SavedProfile(profile,password,unavailable);
  }
  save(profile:ConnectionProfile,password:string):Promise<void>{
    // Snapshot non-secret fields before waiting: later UI edits must not mutate a pending save.
    const encoded=JSON.stringify(profile),snapshot=decodeProfile(encoded);
    const pending=this.saving.catch(():void=>{}).then(async():Promise<void>=>{
      if(snapshot.rememberPassword){
        const bytes=new util.TextEncoder().encodeInto(JSON.stringify(new HotspotSecret(snapshot.ssid,password)));
        try{const attributes=this.alias();attributes.set(asset.Tag.SECRET,bytes);
          attributes.set(asset.Tag.ACCESSIBILITY,asset.Accessibility.DEVICE_UNLOCKED);
          attributes.set(asset.Tag.SYNC_TYPE,asset.SyncType.NEVER);attributes.set(asset.Tag.CONFLICT_RESOLUTION,asset.ConflictResolution.OVERWRITE);
          await asset.add(attributes);
        }catch(_error){throw new Error('无法保存热点密码，请关闭“记住密码”后重试');}finally{bytes.fill(0);}
      }else{
        try{await asset.remove(this.alias());}catch(error){if((error as BusinessError).code!==24000002){throw new Error('无法清除已保存密码，请稍后重试');}}
      }
      await this.store.put('profile',JSON.stringify(snapshot));await this.store.flush();
    });this.saving=pending;return pending;
  }
  clear():Promise<void>{return this.save(new ConnectionProfile(),'');}
}
