import { display } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { DisplayProfile, displayProfile } from '../lab/DisplayProfile';
export function readDeviceDisplay():DisplayProfile {
  try {
    const panel=display.getDefaultDisplaySync();
    const profile=displayProfile(panel.width,panel.height,panel.xDPI,panel.yDPI);
    hilog.info(0x0,'DiPlayProduct','%{public}s',`显示协商：面板 ${profile.panelWidth}×${profile.panelHeight} px；PPI ${Math.round(panel.xDPI)}×${Math.round(panel.yDPI)}；画面 ${profile.width}×${profile.height}；物理尺寸 ${profile.physicalWidth}×${profile.physicalHeight} mm；${profile.measuredPpi?'物理 PPI 已读取':'物理尺寸为估算'}`);
    return profile;
  } catch(_error) {
    hilog.warn(0x0,'DiPlayProduct','%{public}s','屏幕参数读取失败，使用兼容显示配置');return new DisplayProfile();
  }
}
