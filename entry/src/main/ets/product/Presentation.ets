import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
export class Presentation {
  static readonly instance:Presentation=new Presentation();
  private main:window.Window|undefined;private queue:Promise<void>=Promise.resolve();private suspended:boolean=false;
  private fullscreen:boolean=false;private awake:boolean=false;
  attach(main:window.Window):void{this.main=main;this.apply(this.fullscreen,this.awake).catch(():void=>{});}
  resume():void{this.suspended=false;this.apply(this.fullscreen,this.awake).catch(():void=>{});}
  apply(fullscreen:boolean,awake:boolean):Promise<void>{
    this.fullscreen=fullscreen;this.awake=awake;
    const pending=this.queue.catch(():void=>{}).then(async():Promise<void>=>{
      const main=this.main;if(!main){return;}const active=!this.suspended;
      await main.setWindowLayoutFullScreen(active);
      await main.setWindowSystemBarEnable(active?[]:['status','navigation']);
      try{await main.setSpecificSystemBarEnabled('navigationIndicator',!active,false);}
      catch(_error){hilog.warn(0x0,'DiPlayProduct','%{public}s','当前窗口无法单独设置手势导航指示条');}
      try{await main.setGestureBackEnabled(!(active&&this.fullscreen));}catch(_error){}
      await main.setWindowKeepScreenOn(active&&this.awake);
      await main.setPreferredOrientation(this.fullscreen&&active?window.Orientation.AUTO_ROTATION_LANDSCAPE:window.Orientation.AUTO_ROTATION_UNSPECIFIED);
      if(active){hilog.info(0x0,'DiPlayProduct','%{public}s','应用沉浸布局已应用；系统栏隐藏请求已提交');}
    });this.queue=pending;return pending;
  }
  suspend():void{this.suspended=true;this.apply(false,false).catch(():void=>{});}
}
