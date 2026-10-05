import { common } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { LabController, LabState, PairedDevice } from '../lab/LabController';
import { WirelessSettings } from '../lab/WirelessControl';
import { VideoBridge } from '../lab/VideoBridge';
import { DisplayProfile, fitVideo } from '../lab/DisplayProfile';
import { readDeviceDisplay } from '../product/DeviceDisplay';
import { ConnectionProfile, profileIssue } from '../product/ConnectionProfile';
import { ProfileStore } from '../product/ProfileStore';
import { Presentation } from '../product/Presentation';
import { ReconnectPolicy } from '../product/ReconnectPolicy';
import { diagnosticReport } from '../product/Diagnostics';
import { M3 } from '../product/MaterialTheme';
import { ScreenInteraction, ScreenPoint, ScreenAction, VideoViewport } from '../product/ScreenInteraction';

PersistentStorage.persistProp('diplayLocalBluetoothAddress', '');
PersistentStorage.persistProp('diplayHotspotSsid', '');

@Entry
@Component
struct Index {
  @StorageLink('diplayLocalBluetoothAddress') private legacyMac:string='';
  @StorageLink('diplayHotspotSsid') private legacySsid:string='';
  @State private tab:number=0;
  @State private fullscreen:boolean=false;
  @State private fullscreenControls:boolean=false;
  @State private phase:string='idle';
  @State private hotspot:string='尚未检测';
  @State private bluetooth:string='未连接';
  @State private session:string='未启动';
  @State private devices:PairedDevice[]=[];
  @State private profile:ConnectionProfile=new ConnectionProfile();
  @State private password:string='';
  @State private channelText:string='0';
  @State private error:string='';
  @State private notice:string='';
  @State private retryNotice:string='';
  @State private busy:boolean=false;
  @State private loading:boolean=true;
  @State private clock:string='';
  @State private duration:string='';
  @State private videoWidth:number=640;
  @State private videoHeight:number=360;
  @State private reportText:string='';
  @State private displayText:string='自动读取屏幕尺寸';
  private displayProfile:DisplayProfile=new DisplayProfile();
  private areaWidth:number=640;private areaHeight:number=360;
  private logs:string='';
  private lab:LabController=LabController.instance;
  private surface:XComponentController=new XComponentController();
  private store:ProfileStore|undefined;
  private alive:boolean=false;
  private ticker:number=-1;
  private retryTimer:number=-1;
  private reconnect:ReconnectPolicy=new ReconnectPolicy();
  private operation:number=0;
  private interaction:ScreenInteraction=new ScreenInteraction();
  private viewport:VideoViewport=new VideoViewport(0,0,640,360);
  private surfaceLeft:number=0;private surfaceTop:number=0;private touchTimer:number=-1;

  aboutToAppear():void {
    this.alive=true;this.prepareDisplay();
    const context=this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.lab.attach(context,(state:LabState):void=>{
      const previous=this.phase;this.phase=state.phase;this.hotspot=state.hotspot;
      this.bluetooth=state.bluetooth;this.session=state.session;this.devices=state.devices.slice();
      this.logs=state.logs.slice().join('\n');
      if(state.connectionError){this.error=state.connectionError;}
      if(!state.foreground){this.operation++;this.cancelRetry();this.retryNotice='';this.setFullscreen(false);this.busy=false;}
      if(previous!==this.phase){
        if(this.phase==='connected'){
          this.error='';this.retryNotice='';this.reconnect.connected();this.cancelRetry();
          if(this.profile.autoFullscreen&&this.tab===0){this.setFullscreen(true);}
        }else if(this.phase==='disconnected'||this.phase==='error'){
          this.setFullscreen(false);this.scheduleRetry();
        }else if(this.phase==='idle'){
          this.operation++;this.busy=false;this.cancelRetry();this.retryNotice='';this.error='';this.setFullscreen(false);
        }
        this.applyPresentation();
      }
      if(this.tab===2){this.refreshReport();}
      this.updateClock();
    });
    this.loadProfile(context);
    this.updateClock();this.ticker=setInterval(():void=>{this.updateClock();},1000);
  }
  aboutToDisappear():void {
    this.alive=false;this.operation++;this.cancelRetry();this.reconnect.cancel();
    this.resetTouch();
    if(this.ticker>=0){clearInterval(this.ticker);this.ticker=-1;}
    Presentation.instance.apply(false,false).catch(():void=>{});this.password='';this.lab.dispose();
  }
  onBackPress():boolean {
    if(this.fullscreen){if(this.fullscreenControls){this.fullscreenControls=false;this.resetTouch();}return true;}
    if(this.tab!==0){this.chooseTab(0);return true;}return false;
  }
  private async loadProfile(context:common.UIAbilityContext):Promise<void>{
    try{
      const store=await ProfileStore.open(context);const saved=await store.load();if(!this.alive){return;}
      this.store=store;this.profile=saved.profile;this.password=saved.password;
      if(!this.profile.localMac){this.profile.localMac=this.legacyMac;}
      if(!this.profile.ssid){this.profile.ssid=this.legacySsid;}
      this.channelText=this.profile.channel.toString();
      if(saved.secretUnavailable){this.notice='已保存的密码暂不可读取，请在设置中重新填写';}
      hilog.info(0x0,'DiPlayProduct','%{public}s','产品配置已加载；秘密内容不输出到诊断日志');
    }catch(_error){this.error='无法读取本机配置，请重新打开应用';}
    finally{if(this.alive){this.loading=false;}}
  }
  private prepareDisplay():void {
    this.displayProfile=readDeviceDisplay();const p=this.displayProfile;
    this.displayText=`屏幕 ${p.panelWidth}×${p.panelHeight} → CarPlay ${p.width}×${p.height} · 30 FPS`;
    this.fitDisplay();
  }
  private fitDisplay():void {
    this.resetTouch();const size=fitVideo(this.areaWidth,this.areaHeight,this.displayProfile);
    this.videoWidth=size[0];this.videoHeight=size[1];
    this.viewport=new VideoViewport((this.areaWidth-size[0])/2,(this.areaHeight-size[1])/2,size[0],size[1]);
  }
  private snapshot():ConnectionProfile {
    const p=new ConnectionProfile();p.ssid=this.profile.ssid;p.gateway=this.profile.gateway.trim();
    p.localMac=this.profile.localMac.trim().toUpperCase();p.phoneAddress=this.profile.phoneAddress;p.phoneName=this.profile.phoneName;
    p.security=this.profile.security;p.channel=this.channelText.trim()===''?0:Number(this.channelText);
    p.rememberPassword=this.profile.rememberPassword;p.keepAwake=this.profile.keepAwake;
    p.autoFullscreen=this.profile.autoFullscreen;p.autoReconnect=this.profile.autoReconnect;return p;
  }
  private async saveProfile():Promise<boolean>{
    const p=this.snapshot(),issue=profileIssue(p,this.password);
    if(issue){this.error=issue;return false;}
    if(!this.store){this.error='配置尚未就绪，请重新打开应用';return false;}
    try{await this.store.save(p,this.password);if(!this.alive){return false;}
      this.profile=p;this.legacyMac=p.localMac;this.legacySsid=p.ssid;
      this.error='';this.notice='连接配置已保存';return true;
    }catch(error){this.error=(error as Error).message;return false;}
  }
  private isPreparing():boolean{return ['preparing','connecting','negotiating'].includes(this.phase);}
  private canEdit():boolean{return !this.busy&&!this.loading&&!this.isPreparing()&&this.phase!=='connected';}
  private async connect(manual:boolean=true):Promise<void>{
    if(this.busy||this.isPreparing()||this.loading){return;}
    const operation=++this.operation;this.busy=true;this.error='';this.notice='';this.retryNotice='';
    if(manual){this.cancelRetry();this.reconnect.reset();}
    try{
      if(!(await this.saveProfile())){this.tab=1;return;}
      if(operation!==this.operation||!this.alive||!this.lab.state.foreground){return;}
      this.lab.refreshHotspot();if(this.hotspot!=='已开启'){this.error='请先在系统设置开启平板热点，再返回连接';return;}
      this.notice='';this.tab=0;
      const p=this.profile,settings=new WirelessSettings(p.ssid,this.password,p.gateway,p.channel,p.security);
      this.prepareDisplay();await this.lab.startWireless(p.phoneAddress,p.localMac,settings,this.displayProfile);
      if(operation===this.operation){this.applyPresentation();}
    }catch(_error){if(operation===this.operation){this.error='连接启动失败，请检查配置后重试';}}
    finally{if(operation===this.operation){this.busy=false;}}
  }
  private disconnect():void {
    this.operation++;this.busy=false;this.cancelRetry();this.reconnect.cancel();this.retryNotice='';this.error='';this.notice='';
    this.setFullscreen(false);this.lab.stopTests('用户断开连接');
  }
  private cancelRetry():void{if(this.retryTimer>=0){clearTimeout(this.retryTimer);this.retryTimer=-1;}}
  private scheduleRetry():void {
    this.cancelRetry();const delay=this.reconnect.next(this.profile.autoReconnect,this.lab.state.foreground,profileIssue(this.snapshot(),this.password)==='');
    if(delay<0){return;}this.retryNotice=`连接中断，${delay/1000} 秒后重试`;
    this.retryTimer=setTimeout(():void=>{this.retryTimer=-1;if(this.alive&&this.lab.state.foreground){this.connect(false);}},delay);
  }
  private updateClock():void {
    const now=new Date();this.clock=now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
    const seconds=this.lab.state.connectedAt?Math.max(0,Math.floor((Date.now()-this.lab.state.connectedAt)/1000)):0;
    this.duration=Math.floor(seconds/60).toString().padStart(2,'0')+':'+(seconds%60).toString().padStart(2,'0');
  }
  private applyPresentation():void {
    Presentation.instance.apply(this.fullscreen,this.profile.keepAwake&&(this.phase==='connected'||this.isPreparing())).catch(():void=>{});
  }
  private setFullscreen(value:boolean):void{this.resetTouch();this.fullscreenControls=false;this.fullscreen=value;if(value){this.tab=0;}this.applyPresentation();}
  private chooseTab(value:number):void{this.resetTouch();this.tab=value;this.notice='';if(value===2){this.refreshReport();}}
  private dispatchTouch(action:ScreenAction):void {
    for(const report of action.reports){this.lab.sendTouch(report.x,report.y,report.down);}
    if(action.showControls){this.fullscreenControls=true;hilog.info(0x0,'DiPlayProduct','%{public}s','三指下滑已打开全屏控制面板');this.resetTouch();}
  }
  private resetTouch():void {
    if(this.touchTimer>=0){clearTimeout(this.touchTimer);this.touchTimer=-1;}
    const action=this.interaction.cancel();for(const report of action.reports){this.lab.sendTouch(report.x,report.y,report.down);}
  }
  private screenTouch(event:TouchEvent):void {
    if(this.phase!=='connected'||this.tab!==0||this.fullscreenControls){return;}
    event.stopPropagation();
    const points=event.touches.map((point:TouchObject):ScreenPoint=>new ScreenPoint(point.id,point.windowX-this.surfaceLeft,point.windowY-this.surfaceTop));
    const changed=event.changedTouches.map((point:TouchObject):ScreenPoint=>new ScreenPoint(point.id,point.windowX-this.surfaceLeft,point.windowY-this.surfaceTop));
    const kind=event.type===TouchType.Down?'down':event.type===TouchType.Up?'up':event.type===TouchType.Cancel?'cancel':'move';
    this.dispatchTouch(this.interaction.feed(kind,points,changed,Date.now(),this.fullscreen,this.viewport));
    if(kind==='down'&&this.fullscreen&&!this.fullscreenControls){
      if(this.touchTimer>=0){clearTimeout(this.touchTimer);}
      this.touchTimer=setTimeout(():void=>{this.touchTimer=-1;
        if(this.alive&&this.phase==='connected'&&!this.fullscreenControls){this.dispatchTouch(this.interaction.flush(Date.now()));}
      },125);
    }
  }
  private phaseTitle():string {
    if(this.phase==='connected'){return 'CarPlay 已连接';}
    if(this.phase==='preparing'){return '正在准备接收端';}
    if(this.phase==='connecting'){return '正在连接 iPhone';}
    if(this.phase==='negotiating'){return '正在建立画面连接';}
    if(this.phase==='disconnected'){return '连接已中断';}
    if(this.phase==='error'){return '连接未成功';}return '准备连接';
  }
  private refreshReport():void {
    this.reportText=diagnosticReport(this.phaseTitle(),this.hotspot,this.logs,
      [this.password,this.profile.ssid,this.profile.phoneName,this.profile.localMac,this.profile.gateway,this.profile.phoneAddress]);
  }
  private async copyReport():Promise<void>{
    this.refreshReport();try{await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN,this.reportText));
      this.notice='已复制脱敏诊断报告';}catch(_error){this.error='复制失败，请长按报告文字复制';}
  }
  private resetProfile():void {
    this.getUIContext().showAlertDialog({title:'清除本机配置？',message:'将清除连接配置和应用保存的热点密码。系统蓝牙配对不受影响。',
      primaryButton:{value:'取消',action:():void=>{}},secondaryButton:{value:'清除',action:():void=>{this.clearProfile();}}});
  }
  private async clearProfile():Promise<void>{
    this.disconnect();try{if(!this.store){return;}await this.store.clear();this.profile=new ConnectionProfile();this.password='';
      this.channelText='0';this.legacyMac='';this.legacySsid='';this.notice='本机连接配置已清除';
    }catch(_error){this.error='清除失败，请稍后重试';}
  }

  @Builder
  navButton(icon:Resource,label:string,index:number){
    Column({space:6}){
      Column(){Image(icon).width(24).height(24).objectFit(ImageFit.Contain)}
        .width(56).height(32).justifyContent(FlexAlign.Center).borderRadius(16).backgroundColor(this.tab===index?M3.primaryContainer:Color.Transparent)
      Text(label).fontSize(12).fontWeight(FontWeight.Medium).fontColor(this.tab===index?M3.onPrimaryContainer:M3.onSurfaceVariant)
    }.width(70).height(66).justifyContent(FlexAlign.Center).borderRadius(16)
      .backgroundColor(Color.Transparent).onClick(():void=>{this.chooseTab(index);})
  }
  @Builder
  sectionTitle(title:string,subtitle:string){
    Text(title).fontSize(22).fontWeight(FontWeight.Bold).fontColor(M3.onSurface)
    Text(subtitle).fontSize(13).fontColor(M3.onSurfaceVariant).lineHeight(21)
  }
  @Builder
  field(label:string,hint:string,text:string,changed:(value:string)=>void){
    Text(label).fontSize(14).fontColor(M3.onSurface)
    TextInput({placeholder:hint,text:text}).height(48).fontSize(16).fontColor(M3.onSurface)
      .placeholderColor(M3.onSurfaceVariant).backgroundColor(M3.surfaceContainerHighest).borderRadius(4)
      .borderWidth({bottom:1}).borderColor(M3.outline).enabled(this.canEdit()).onChange(changed)
  }
  @Builder
  switchRow(label:string,subtitle:string,checked:boolean,changed:(value:boolean)=>void){
    Row({space:16}){
      Column({space:4}){Text(label).fontSize(15).fontColor(M3.onSurface);Text(subtitle).fontSize(12).fontColor(M3.onSurfaceVariant).lineHeight(19)}
        .layoutWeight(1).alignItems(HorizontalAlign.Start)
      Toggle({type:ToggleType.Switch,isOn:checked}).selectedColor(M3.primary).enabled(this.canEdit()).onChange(changed)
    }.width('100%').padding({top:8,bottom:8})
  }
  @Builder
  settingsPage(){
    Scroll(){Column({space:22}){
      this.sectionTitle('连接设置','首次配置后即可从首页连接。请先在系统设置完成蓝牙配对并开启平板热点。')
      if(this.phase==='connected'||this.isPreparing()){Text('请先返回连接页断开或取消连接，再修改配置。').fontColor(M3.primary).fontSize(14)}
      Column({space:14}){
        this.sectionTitle('01  选择 iPhone','在平板系统蓝牙中与 iPhone 配对，然后刷新列表。')
        Button('读取已配对设备').backgroundColor(M3.secondaryContainer).fontColor(M3.onSurface)
          .enabled(this.canEdit())
          .onClick(async():Promise<void>=>{await this.lab.loadPairedDevices();})
        if(this.devices.length===0){Text(this.profile.phoneName?'已选：'+this.profile.phoneName:'尚未选择 iPhone').fontColor(M3.onSurfaceVariant).fontSize(14)}
        ForEach(this.devices,(device:PairedDevice):void=>{
          Row({space:12}){Text('▯').fontSize(26).fontColor(M3.primary);Text(device.name).fontSize(16).fontColor(M3.onSurface).layoutWeight(1)
            Text(device.address===this.profile.phoneAddress?'已选择':'选择').fontSize(13).fontColor(M3.primary)
          }.width('100%').padding(16).backgroundColor(device.address===this.profile.phoneAddress?M3.primaryContainer:M3.surfaceContainerHighest).borderRadius(12).enabled(this.canEdit())
            .onClick(():void=>{this.profile.phoneAddress=device.address;this.profile.phoneName=device.name;})
        },(device:PairedDevice):string=>device.address)
      }.width('100%').padding({top:16,bottom:24}).backgroundColor(Color.Transparent).borderRadius(0).borderWidth({bottom:1}).borderColor(M3.outlineVariant).alignItems(HorizontalAlign.Start)
      Column({space:14}){
        this.sectionTitle('02  平板热点','这里填写的名称、密码和安全类型须与系统热点保持一致。')
        Row({space:12}){Text('热点 '+this.hotspot).fontSize(14).fontColor(M3.primary).layoutWeight(1)
          Button('刷新').fontSize(13).backgroundColor(M3.secondaryContainer).onClick(():void=>{this.lab.refreshHotspot();})}.width('100%')
        this.field('热点名称','系统热点的名称',this.profile.ssid,(value:string):void=>{this.profile.ssid=value;})
        Text('热点密码').fontSize(14).fontColor(M3.onSurface)
        TextInput({placeholder:'填写系统热点密码',text:this.password}).type(InputType.Password).height(48).fontSize(16)
          .fontColor(M3.onSurface).placeholderColor(M3.onSurfaceVariant).backgroundColor(M3.surfaceContainerHighest).borderRadius(4)
          .borderWidth({bottom:1}).borderColor(M3.outline).enabled(this.canEdit())
          .onChange((value:string):void=>{this.password=value;})
        this.switchRow('记住热点密码','使用鸿蒙安全资产库存储；默认只在本次运行中保留。',this.profile.rememberPassword,
          (value:boolean):void=>{this.profile.rememberPassword=value;})
        Text('热点安全类型').fontSize(14).fontColor(M3.onSurface)
        Select([{value:'WPA / WPA2'},{value:'WPA3 过渡模式'},{value:'仅 WPA3'},{value:'开放热点'}])
          .selected([2,3,4,0].indexOf(this.profile.security)).value(['WPA / WPA2','WPA3 过渡模式','仅 WPA3','开放热点'][[2,3,4,0].indexOf(this.profile.security)])
          .fontColor(M3.onSurface).backgroundColor(M3.secondaryContainer).enabled(this.canEdit()).onSelect((index:number):void=>{this.profile.security=[2,3,4,0][index];})
        this.field('热点路由器 IPv4 地址','例如 192.168.43.1',this.profile.gateway,(value:string):void=>{this.profile.gateway=value;})
        Text('让 iPhone 加入平板热点，在 iPhone 的 Wi-Fi 详情中查看“路由器”。地址变化时需要更新此项。')
          .fontSize(12).fontColor(M3.onSurfaceVariant).lineHeight(20)
      }.width('100%').padding({top:16,bottom:24}).backgroundColor(Color.Transparent).borderRadius(0).borderWidth({bottom:1}).borderColor(M3.outlineVariant).alignItems(HorizontalAlign.Start)
      Column({space:14}){
        this.sectionTitle('03  设备与显示','屏幕比例与物理尺寸自动读取，在下次连接时生效。')
        Text(this.displayText).fontSize(13).fontColor(M3.primary)
        this.field('平板本机蓝牙地址','AA:BB:CC:DD:EE:FF',this.profile.localMac,(value:string):void=>{this.profile.localMac=value;})
        Text('填写平板的地址，可在系统设备信息中查看。当前公开接口无法自动读取。').fontSize(12).fontColor(M3.onSurfaceVariant).lineHeight(20)
        this.field('热点信道','不确定时填写 0',this.channelText,(value:string):void=>{this.channelText=value;})
        this.switchRow('连接成功后进入全屏','纯画面横屏显示；三指下滑唤出退出面板。',this.profile.autoFullscreen,(value:boolean):void=>{this.profile.autoFullscreen=value;})
        this.switchRow('连接时保持屏幕常亮','断开或离开应用后恢复系统设置。',this.profile.keepAwake,(value:boolean):void=>{this.profile.keepAwake=value;})
        this.switchRow('前台断线后自动重试','最多重试 3 次；手动断开或进入后台会停止。',this.profile.autoReconnect,(value:boolean):void=>{this.profile.autoReconnect=value;})
      }.width('100%').padding({top:16,bottom:24}).backgroundColor(Color.Transparent).borderRadius(0).borderWidth({bottom:1}).borderColor(M3.outlineVariant).alignItems(HorizontalAlign.Start)
      Button('保存连接配置').width('100%').height(50).backgroundColor(M3.primary).fontColor(M3.onPrimary)
        .enabled(this.canEdit()).onClick(async():Promise<void>=>{
          this.busy=true;try{await this.saveProfile();this.applyPresentation();}finally{this.busy=false;}})
      Button('清除本机连接配置').backgroundColor(M3.secondaryContainer).fontColor(M3.onSurfaceVariant).enabled(!this.busy).onClick(():void=>{this.resetProfile();})
    }.width('100%').constraintSize({maxWidth:760}).padding(24).alignItems(HorizontalAlign.Start)}.width('100%').height('100%').backgroundColor(M3.surface)
  }
  @Builder
  diagnosticsPage(){
    Scroll(){Column({space:18}){
      this.sectionTitle('连接诊断','报告会隐藏热点名称、密码和设备地址。仅在你点击复制时写入剪贴板。')
      Column({space:10}){Text('热点：'+this.hotspot).fontColor(M3.onPrimaryContainer).fontSize(16)
        Text('蓝牙：'+this.bluetooth).fontColor(M3.onSurfaceVariant).fontSize(14)
        Text('会话：'+this.session).fontColor(M3.onSurfaceVariant).fontSize(14)
      }.width('100%').alignItems(HorizontalAlign.Start).padding(20).backgroundColor(M3.surfaceContainerLow).borderRadius(18)
      Row({space:12}){Button('刷新报告').backgroundColor(M3.secondaryContainer).onClick(():void=>{this.refreshReport();})
        Button('复制诊断报告').backgroundColor(M3.primary).fontColor(M3.onPrimary).onClick(async():Promise<void>=>{await this.copyReport();})}
      Text(this.reportText||'尚无记录').fontSize(12).fontFamily('monospace').fontColor(M3.onSurfaceVariant).lineHeight(20)
        .copyOption(CopyOptions.LocalDevice).width('100%').padding(20).backgroundColor(M3.surfaceContainerLow).borderRadius(18)
    }.width('100%').constraintSize({maxWidth:900}).padding(24).alignItems(HorizontalAlign.Start)}.width('100%').height('100%').backgroundColor(M3.surface)
  }
  @Builder
  aboutPage(){
    Scroll(){Column({space:20}){
      Text('DiPlay Harmony').fontSize(32).fontWeight(FontWeight.Bold).fontColor(M3.onSurface)
      Text('0.12.0 · 产品预览版').fontSize(14).fontColor(M3.primary)
      this.sectionTitle('让平板成为 CarPlay 显示屏','通过平板热点接收 iPhone 的画面，使用平板触控操作 CarPlay。')
      Column({space:14}){
        Text('首次使用').fontSize(20).fontWeight(FontWeight.Bold).fontColor(M3.onSurface)
        Text('1. 在系统中配对蓝牙，开启平板热点。\n2. 在连接设置选择 iPhone，填写热点信息和本机蓝牙地址。\n3. 返回首页连接；如 iPhone 弹出 CarPlay 确认，请允许。')
          .fontSize(15).fontColor(M3.onSurfaceVariant).lineHeight(27)
      }.width('100%').padding({top:16,bottom:24}).backgroundColor(Color.Transparent).borderRadius(0).borderWidth({bottom:1}).borderColor(M3.outlineVariant).alignItems(HorizontalAlign.Start)
      Column({space:12}){
        Text('当前支持与限制').fontSize(20).fontWeight(FontWeight.Bold).fontColor(M3.onSurface)
        Text('无线画面、单指触控、保持比例的横屏全屏、配置保存和前台重连。\n音频暂不可用，音乐仍可能由 iPhone 播放。\n应用需保持前台；锁屏或切换到其他应用会断开。\n画面接收已在 MatePad mini / HarmonyOS 7 上验证；其他设备的兼容性尚待验证。')
          .fontSize(14).fontColor(M3.onSurfaceVariant).lineHeight(25)
      }.width('100%').padding({top:16,bottom:24}).backgroundColor(Color.Transparent).borderRadius(0).borderWidth({bottom:1}).borderColor(M3.outlineVariant).alignItems(HorizontalAlign.Start)
      Text('数据保存在本机。热点密码默认不持久保存，启用“记住密码”后存入鸿蒙安全资产库；不会自动上传诊断记录。')
        .fontSize(13).fontColor(M3.onSurfaceVariant).lineHeight(22)
      Text('依据 DiPlay 协议研究独立编写的鸿蒙移植工程，遵循 GPL-3.0，保留原项目与依赖声明。本项目并非 Apple 官方认证产品。')
        .fontSize(13).fontColor(M3.onSurfaceVariant).lineHeight(22)
      Hyperlink('https://github.com/shihabal3amri/DiPlay','查看原版 DiPlay 项目').color(M3.primary)
    }.width('100%').constraintSize({maxWidth:760}).padding(28).alignItems(HorizontalAlign.Start)}.width('100%').height('100%').backgroundColor(M3.surface)
  }

  @Builder
  fullscreenPanel(){
    Column(){
      Blank()
      Column({space:20}){
        this.sectionTitle('全屏控制','选择返回应用，或继续观看 CarPlay。')
        Row({space:12}){
          Button('继续全屏').layoutWeight(1).height(48).backgroundColor(M3.secondaryContainer).fontColor(M3.onSecondaryContainer)
            .borderRadius(24).onClick(():void=>{this.fullscreenControls=false;this.resetTouch();})
          Button('返回应用').layoutWeight(1).height(48).backgroundColor(M3.primary).fontColor(M3.onPrimary)
            .borderRadius(24).onClick(():void=>{this.setFullscreen(false);})
        }.width('100%')
      }.width('100%').constraintSize({maxWidth:460}).padding(24).backgroundColor(M3.surfaceContainerHigh).borderRadius(12)
    }.width('100%').height('100%').padding(24).backgroundColor('#00000066')
  }

  build(){
    Column(){
      Row({space:12}){
        Text('▣').fontSize(29).fontColor(M3.primary)
        Column({space:3}){Text('DiPlay').fontSize(24).fontWeight(FontWeight.Medium).fontColor(M3.onSurface);Text('无线 CarPlay').fontSize(12).fontColor(M3.onSurfaceVariant)}
          .alignItems(HorizontalAlign.Start)
        Blank();Text(this.clock).fontSize(17).fontColor(M3.onSurfaceVariant)
      }.width('100%').height(76).padding({left:26,right:26}).backgroundColor(M3.surface).visibility(this.fullscreen?Visibility.None:Visibility.Visible)
      Row(){
        Column({space:14}){
          this.navButton($r('app.media.nav_screen'),'连接',0);this.navButton($r('app.media.nav_settings'),'设置',1)
          this.navButton($r('app.media.nav_diagnostics'),'诊断',2);this.navButton($r('app.media.nav_info'),'关于',3)
          Blank();Text('0.12.0').fontSize(10).fontColor(M3.outline)
        }.width(94).height('100%').padding({top:18,bottom:24}).backgroundColor(M3.surface).visibility(this.fullscreen?Visibility.None:Visibility.Visible)
        Column(){
          Row({space:12}){
            Text('●').fontSize(12).fontColor(this.phase==='connected'?M3.success:M3.primary)
            Text(this.phaseTitle()).fontSize(20).fontWeight(FontWeight.Medium).fontColor(M3.onSurface)
            Blank();if(this.phase==='connected'){Text(this.duration).fontSize(13).fontColor(M3.onSurfaceVariant)}
          }.width('100%').height(64).padding({left:22,right:18}).visibility(this.tab===0&&!this.fullscreen?Visibility.Visible:Visibility.None)
          Stack({alignContent:Alignment.Center}){
            // A single Surface lives across tabs and full-screen transitions.
            XComponent({id:'carplayVideo',type:XComponentType.SURFACE,controller:this.surface})
              .width(this.videoWidth).height(this.videoHeight).backgroundColor(Color.Black)
              .visibility(this.tab===0?Visibility.Visible:Visibility.Hidden)
              .onLoad(():void=>{VideoBridge.instance.setSurface(this.surface.getXComponentSurfaceId());})
              .onDestroy(():void=>{VideoBridge.instance.clearSurface();})
            if(this.tab===0&&this.phase!=='connected'){
              Column({space:18}){
                if(this.isPreparing()||this.busy){LoadingProgress().width(44).height(44).color(M3.primary)}
                else{Text('▯  ↔  ▣').fontSize(46).fontColor(M3.onSurfaceVariant)}
                Text(this.isPreparing()?'请保持 iPhone 解锁并在附近':'你的 CarPlay，在平板上').fontSize(21).fontWeight(FontWeight.Medium).fontColor(M3.onSurface)
                Text(this.profile.phoneAddress?'开启平板热点后，点击下方连接':'首次使用请完成连接设置').fontSize(14).fontColor(M3.onSurfaceVariant)
              }.width('100%').height('100%').justifyContent(FlexAlign.Center).backgroundColor(M3.surface).hitTestBehavior(HitTestMode.None)
            }
            if(this.tab===1){this.settingsPage()}
            if(this.tab===2){this.diagnosticsPage()}
            if(this.tab===3){this.aboutPage()}
            if(this.fullscreen&&this.fullscreenControls){this.fullscreenPanel()}
          }.width('100%').layoutWeight(1).backgroundColor(Color.Black)
            .onAreaChange((_old:Area,current:Area):void=>{
              this.resetTouch();
              const width=Math.max(1,parseFloat(current.width.toString())),height=Math.max(1,parseFloat(current.height.toString()));
              this.areaWidth=width;this.areaHeight=height;this.fitDisplay();
              this.surfaceLeft=parseFloat((current.globalPosition.x??0).toString());this.surfaceTop=parseFloat((current.globalPosition.y??0).toString());
              if(this.fullscreen){hilog.info(0x0,'DiPlayProduct','%{public}s',`全屏显示区域 ${Math.round(width)}×${Math.round(height)}；不含应用工具栏`);}
            })
            .onTouch((event:TouchEvent):void=>{this.screenTouch(event);})
          Column({space:10}){
            if(this.error){Text(this.error).fontSize(13).fontColor(M3.error).width('100%')}
            if(this.notice){Text(this.notice).fontSize(13).fontColor(M3.success).width('100%')}
            if(this.tab===0){
              Row({space:12}){
                Column({space:5}){
                  Text(this.profile.phoneName||'尚未选择 iPhone').fontSize(16).fontWeight(FontWeight.Medium).fontColor(M3.onSurface)
                  Text(this.retryNotice||'平板热点 '+this.hotspot).fontSize(12).fontColor(M3.onSurfaceVariant)
                }.layoutWeight(1).alignItems(HorizontalAlign.Start)
                if(this.phase==='connected'){
                  Button('全屏').backgroundColor(M3.primary).fontColor(M3.onPrimary).onClick(():void=>{this.setFullscreen(true);})
                  Button('断开').backgroundColor(M3.secondaryContainer).onClick(():void=>{this.disconnect();})
                }else if(this.isPreparing()||this.busy||this.retryTimer>=0){
                  Button('取消连接').backgroundColor(M3.secondaryContainer).onClick(():void=>{this.disconnect();})
                }else{
                  Button(this.profile.phoneAddress?'连接 iPhone':'开始设置').height(46).backgroundColor(M3.primary).fontColor(M3.onPrimary).enabled(!this.loading)
                    .onClick(async():Promise<void>=>{if(this.profile.phoneAddress){await this.connect();}else{this.chooseTab(1);}})
                }
              }.width('100%')
              Text('画面与触控可用 · 音频暂不可用 · 请保持应用前台').fontSize(11).fontColor(M3.onSurfaceVariant)
            }
          }.width('100%').padding({left:22,right:22,top:14,bottom:14}).backgroundColor(M3.surfaceContainerLow)
            .visibility(this.fullscreen||(this.tab!==0&&!this.error&&!this.notice)?Visibility.None:Visibility.Visible)
        }.layoutWeight(1).height('100%').backgroundColor(M3.surface)
      }.width('100%').layoutWeight(1)
    }.width('100%').height('100%').backgroundColor(M3.surface)
      .expandSafeArea([SafeAreaType.SYSTEM],[SafeAreaEdge.TOP,SafeAreaEdge.BOTTOM,SafeAreaEdge.START,SafeAreaEdge.END])
  }
}


