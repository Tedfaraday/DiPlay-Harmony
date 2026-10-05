import nativeVideo from 'libdiplayvideo.so';
import { DisplayProfile } from './DisplayProfile';

export class VideoBridge {
  static readonly instance:VideoBridge=new VideoBridge();
  private surface:string='';private owner:number=0;private nextOwner:number=0;
  setSurface(surface:string):void{this.surface=surface;}
  clearSurface():void{if(this.owner!==0){nativeVideo.stop();this.owner=0;}this.surface='';}
  claim(profile:DisplayProfile=new DisplayProfile()):number{
    if(!this.surface){throw new Error('视频显示区域尚未准备');}if(this.owner!==0){throw new Error('已有活动视频流');}
    const status=nativeVideo.start(this.surface,profile.width,profile.height);if(status!==0){throw new Error(`鸿蒙解码器启动失败 ${status}`);}
    this.owner=++this.nextOwner;return this.owner;
  }
  feed(owner:number,bytes:Uint8Array,config:boolean,pts:number):void{
    if(owner!==this.owner||owner===0){throw new Error('视频显示区域已关闭');}
    const copy=new Uint8Array(bytes);if(!nativeVideo.feed(copy.buffer as ArrayBuffer,config?8:0,pts)){throw new Error(`鸿蒙解码器拒绝帧 ${nativeVideo.stats()[2]}`);}
  }
  stats(owner:number):number[]{return owner===this.owner?nativeVideo.stats():[0,0,0,0];}
  release(owner:number):void{if(owner!==0&&owner===this.owner){nativeVideo.stop();this.owner=0;}}
}
