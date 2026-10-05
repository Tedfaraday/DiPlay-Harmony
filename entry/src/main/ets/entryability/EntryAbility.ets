import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { LabController } from '../lab/LabController';
import { Presentation } from '../product/Presentation';

export default class EntryAbility extends UIAbility {
  onWindowStageCreate(stage: window.WindowStage): void {
    stage.getMainWindow().then((main:window.Window):void=>{Presentation.instance.attach(main);}).catch(():void=>{});
    try {
      stage.loadContent('pages/Index', (error): void => {
        if (error.code) { console.error(`Page load failed: ${error.code} ${error.message}`); }
      });
    } catch (error) { console.error(`Window initialization failed: ${JSON.stringify(error)}`); }
  }
  onBackground(): void {
    Presentation.instance.suspend();LabController.instance.setForeground(false);
    LabController.instance.stopTests('应用进入后台，连接已断开');
  }
  onForeground():void{Presentation.instance.resume();LabController.instance.setForeground(true);}
  onDestroy(): void {
    Presentation.instance.suspend();
    LabController.instance.dispose();
  }
}
