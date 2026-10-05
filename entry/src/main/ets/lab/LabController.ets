import { common, abilityAccessCtrl } from '@kit.AbilityKit';
import { wifiManager, connection as bluetoothConnection, socket as bluetoothSocket } from '@kit.ConnectivityKit';
import { socket, mdns } from '@kit.NetworkKit';
import { BusinessError, systemDateTime } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import { Iap2Probe, IAP2_UUID, IAP2_MARKER } from './Iap2Probe';
import { Iap2Link, CsmObserver } from './Iap2Link';
import { controlMessage, parameter, parameterIds, readParameters, identification } from './Iap2Control';
import { ExperimentalAuth } from './ExperimentalAuth';
import { ReceiverIdentity } from './ReceiverIdentity';
import { WirelessSettings, wifiConfiguration, wirelessComponent, startWirelessSession } from './WirelessControl';
import { DisplayProfile } from './DisplayProfile';
import { SessionProbeServer } from './SessionProbeServer';
import { hilog } from '@kit.PerformanceAnalysisKit';

export class PairedDevice {
  address: string;
  name: string;
  constructor(address: string, name: string) { this.address = address; this.name = name; }
}

export class LabState {
  phase:string='idle';connectionError:string='';connectedAt:number=0;foreground:boolean=true;
  hotspot: string = '尚未检测';
  hotspotEvent: string = '尚未收到事件';
  network: string = '未启动';
  mdns: string = '未注册';
  bluetooth: string = '未连接';
  session: string = '未启动';
  token: string = '';
  httpHits: number = 0;
  udpHits: number = 0;
  receivedBytes: number = 0;
  devices: PairedDevice[] = [];
  logs: string[] = [];
}

class HttpPeer {
  connection: socket.TCPSocketConnection;
  header: string = '';
  done: boolean = false;
  timer: number = -1;
  generation: number;
  token: string;
  constructor(connection: socket.TCPSocketConnection, generation: number, token: string) {
    this.connection = connection; this.generation = generation; this.token = token;
  }
}

export class LabController {
  static readonly instance: LabController = new LabController();
  state: LabState = new LabState();
  onChange: (state: LabState) => void = (_state: LabState): void => {};
  private context: common.UIAbilityContext | undefined;
  private subscribed: boolean = false;
  private server: socket.TCPSocketServer | undefined;
  private udp: socket.UDPSocket | undefined;
  private service: mdns.LocalServiceInfo | undefined;
  private peers: HttpPeer[] = [];
  private networkGeneration: number = 0;
  private bluetoothGeneration: number = 0;
  private socketId: number = -1;
  private btTimer: number = -1;
  private markerTimer: number = -1;
  private probe: Iap2Probe = new Iap2Probe();
  private markerSeen: boolean = false;
  private link: Iap2Link | undefined;
  private csm: CsmObserver = new CsmObserver();
  private linkTimer: number = -1;
  private authentication: Promise<ExperimentalAuth | undefined> | undefined;
  private pendingControls: number = 0;
  private labSerial: string = '';
  private localBluetoothAddress: string = '';
  private wirelessSettings: WirelessSettings | undefined;
  private receiverIdentity: ReceiverIdentity | undefined;
  private authenticated: boolean = false;
  private wifiSent: number = 0;
  private startSent: number = 0;
  private sessionProbe: SessionProbeServer = new SessionProbeServer((message: string): void => {
    hilog.info(0x0,'DiPlaySession','%{public}s',message);
    this.state.session=message;this.log(message);
  },():void=>{this.stopBluetooth('Wi-Fi iAP2 运行通道已认证；蓝牙引导连接已释放');},(event:string):void=>{
    if(event==='streaming'&&['preparing','connecting','negotiating','disconnected'].includes(this.state.phase)){
      this.clearConnectionTimer();this.state.phase='connected';this.state.connectionError='';this.state.connectedAt=Date.now();
    }else if(event==='paired'&&['preparing','connecting','negotiating'].includes(this.state.phase)){this.state.phase='negotiating';}
    else if(event==='ended'&&this.state.phase==='connected'){
      this.state.phase='disconnected';this.state.connectedAt=0;this.state.connectionError='与 iPhone 的连接已中断';
    }this.publish();
  });
  private connectionTimer:number=-1;
  private wirelessGeneration: number = 0;
  private preparingWireless: boolean = false;

  private hotspotCallback: (value: number) => void = (value: number): void => {
    const labels: string[] = ['已关闭', '已开启', '正在开启', '正在关闭'];
    this.state.hotspot = labels[value] ?? `未知状态 ${value}`;
    this.state.hotspotEvent = `系统事件 ${value} · ${new Date().toLocaleTimeString()}`;
    this.log(`热点事件：${this.state.hotspot}`);
    if (value === 0 || value === 3) { this.stopTests('热点关闭，测试已停止'); }
  };

  private readCallback: (data: ArrayBuffer) => void = (data: ArrayBuffer): void => {
    this.state.receivedBytes += data.byteLength;
    if (this.link) {
      try { this.link.feed(new Uint8Array(data), this.monotonicTime()); this.pumpLink(); }
      catch (error) { this.stopBluetooth(`链路读取失败 ${(error as Error).message}`); }
      this.publish(); return;
    }
    const events = this.probe.feed(new Uint8Array(data));
    for (let i = 0; i < events.length; i++) {
      this.log(events[i].detail);
      if (events[i].kind === 'marker') {
        this.markerSeen = true;
        this.state.bluetooth = '已收到 iAP2 检测回复';
        this.clearMarkerTimer();
      }
      if (events[i].kind === 'sync') { this.state.bluetooth = '已收到 iAP2 SYN 帧（未认证）'; }
      if (events[i].kind === 'reset' || events[i].kind === 'overflow') {
        this.stopBluetooth('iAP2 探测终止');
      }
    }
    this.publish();
  };

  attach(context: common.UIAbilityContext, listener: (state: LabState) => void): void {
    this.context = context;
    this.onChange = listener;
    if (!this.subscribed) {
      try {
        wifiManager.on('hotspotStateChange', this.hotspotCallback);
        this.subscribed = true;
        this.log('已订阅 HarmonyOS 热点事件');
      } catch (error) { this.log(`热点订阅失败 ${this.errorText(error as BusinessError)}`); }
    }
    this.refreshHotspot();
  }

  refreshHotspot(): void {
    try { this.state.hotspot = wifiManager.isHotspotActive() ? '已开启' : '已关闭'; }
    catch (error) { this.state.hotspot = `查询失败 ${this.errorText(error as BusinessError)}`; }
    this.publish();
  }

  async startNetwork(): Promise<void> {
    const stopping = this.stopNetwork();
    const generation = this.networkGeneration;
    await stopping;
    if (generation !== this.networkGeneration) { return; }
    const server = socket.constructTCPSocketServerInstance();
    this.server = server;
    this.state.token = util.generateRandomUUID(true).replace(/-/g, '').substring(0, 16);
    this.state.httpHits = 0;
    this.state.udpHits = 0;
    this.state.network = '正在监听';
    this.publish();
    try {
      server.on('connect', (client: socket.TCPSocketConnection): void => {
        if (generation !== this.networkGeneration) { client.close().catch((): void => {}); return; }
        this.acceptHttp(client);
      });
      server.on('error', (error: BusinessError): void => { this.log(`TCP 错误 ${this.errorText(error)}`); });
      await server.listen({ address: '0.0.0.0', port: 8787, family: 1 });
      if (generation !== this.networkGeneration) { await server.close().catch((): void => {}); return; }
      this.state.network = 'TCP 8787 已监听，等待手机访问';
      this.log('TCP 监听成功；外部可达性待验证');
      const udp = socket.constructUDPSocketInstance();
      this.udp = udp;
      udp.on('message', (info: socket.SocketMessageInfo): void => {
        if (generation !== this.networkGeneration || info.remoteInfo.family !== 'IPv4' || info.message.byteLength > 1200) { return; }
        const text = util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(info.message));
        if (!text.startsWith(`${this.state.token}:`)) { return; }
        udp.send({ address: { address: info.remoteInfo.address, port: info.remoteInfo.port, family: 1 }, data: info.message })
          .then((): void => {
            if (generation === this.networkGeneration) { this.state.udpHits++; this.publish(); }
          })
          .catch((error: BusinessError): void => { this.log(`UDP 回传失败 ${this.errorText(error)}`); });
      });
      udp.on('error', (error: BusinessError): void => { this.log(`UDP 错误 ${this.errorText(error)}`); });
      try {
        await udp.bind({ address: '0.0.0.0', port: 8788, family: 1 });
        if (generation !== this.networkGeneration) { await udp.close().catch((): void => {}); return; }
        this.log('UDP 8788 已监听');
      } catch (error) { this.log(`UDP 监听失败 ${this.errorText(error as BusinessError)}`); }
      if (this.context && generation === this.networkGeneration) {
        try {
          const registered = await mdns.addLocalService(this.context, {
            serviceType: '_diplay-lab._tcp', serviceName: 'DiPlay Harmony Lab', port: 8787
          });
          if (generation !== this.networkGeneration) {
            await mdns.removeLocalService(this.context, registered); return;
          }
          this.service = registered;
          this.state.mdns = '已注册 _diplay-lab._tcp；跨设备发现待验证';
        } catch (error) { this.state.mdns = `注册失败 ${this.errorText(error as BusinessError)}`; }
      }
      this.publish();
    } catch (error) {
      if (generation !== this.networkGeneration) { return; }
      this.log(`网络启动失败 ${this.errorText(error as BusinessError)}`);
      await this.stopNetwork();
      this.state.network = '启动失败，请查看日志';
      this.publish();
    }
  }

  private acceptHttp(client: socket.TCPSocketConnection): void {
    if (this.peers.length >= 8) { client.close().catch((): void => {}); return; }
    const peer = new HttpPeer(client, this.networkGeneration, this.state.token);
    this.peers.push(peer);
    peer.timer = setTimeout((): void => { this.closePeer(peer); }, 5000);
    client.on('close', (): void => { this.forgetPeer(peer); });
    client.on('error', (_error: BusinessError): void => { this.closePeer(peer); });
    client.on('message', (info: socket.SocketMessageInfo): void => {
      if (peer.done || peer.generation !== this.networkGeneration) { return; }
      if (info.message.byteLength + peer.header.length > 16384) { this.closePeer(peer); return; }
      peer.header += util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(info.message));
      if (peer.header.indexOf('\r\n\r\n') < 0) { return; }
      peer.done = true;
      const path = `/${peer.token}`;
      const firstLine = peer.header.split('\r\n')[0];
      const accepted = firstLine === `GET ${path} HTTP/1.1` || firstLine === `GET ${path} HTTP/1.0`;
      const body = accepted ? '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>DiPlay 网络测试</title><body style="font:20px system-ui;padding:32px;background:#eef5ff"><h1>网络双向通信成功</h1><p>手机已通过 TCP 连接到鸿蒙平板，平板已返回本页面。</p><p>这证明此网络路径可达，尚未验证 CarPlay 会话。</p></body></html>' : 'Not found';
      const size = new util.TextEncoder().encodeInto(body).byteLength;
      const response = `HTTP/1.1 ${accepted ? '200 OK' : '404 Not Found'}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${size}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${body}`;
      client.send({ data: response, encoding: 'UTF-8' }).then((): void => {
        if (accepted && peer.generation === this.networkGeneration) {
          this.state.httpHits++;
          this.state.network = '已处理外部 TCP 请求并发送响应';
          this.log('收到测试页面请求，HTTP 响应已发送');
        }
        this.closePeer(peer);
      }).catch((error: BusinessError): void => {
        this.log(`HTTP 响应失败 ${this.errorText(error)}`); this.closePeer(peer);
      });
    });
  }

  private forgetPeer(peer: HttpPeer): void {
    if (peer.timer >= 0) { clearTimeout(peer.timer); peer.timer = -1; }
    const index = this.peers.indexOf(peer);
    if (index >= 0) { this.peers.splice(index, 1); }
  }

  private closePeer(peer: HttpPeer): void {
    peer.done = true;
    this.forgetPeer(peer);
    peer.connection.close().catch((): void => {});
  }

  async stopNetwork(): Promise<void> {
    this.networkGeneration++;
    const server = this.server;
    const udp = this.udp;
    const service = this.service;
    this.server = undefined; this.udp = undefined; this.service = undefined;
    const peers = this.peers.slice();
    for (let i = 0; i < peers.length; i++) { this.closePeer(peers[i]); }
    this.state.network = '未启动'; this.state.mdns = '未注册'; this.state.token = '';
    this.publish();
    if (service && this.context) {
      try { await mdns.removeLocalService(this.context, service); }
      catch (error) { this.log(`mDNS 注销失败 ${this.errorText(error as BusinessError)}`); }
    }
    if (udp) { try { await udp.close(); } catch (_error) {} }
    if (server) { try { await server.close(); } catch (_error) {} }
  }

  async loadPairedDevices(): Promise<void> {
    if (!this.context) { return; }
    try {
      const result = await abilityAccessCtrl.createAtManager().requestPermissionsFromUser(this.context,
        ['ohos.permission.ACCESS_BLUETOOTH']);
      if (result.authResults.length === 0 || result.authResults[0] !== 0) {
        this.log('未获蓝牙权限，请在系统中允许后重试'); return;
      }
      const addresses = bluetoothConnection.getPairedDevices();
      this.state.devices = [];
      for (let i = 0; i < addresses.length; i++) {
        let name = `设备 ${i + 1}`;
        try { name = bluetoothConnection.getRemoteDeviceName(addresses[i]) || name; } catch (_error) {}
        this.state.devices.push(new PairedDevice(addresses[i], name));
      }
      this.log(`读取到 ${addresses.length} 个已配对设备`);
    } catch (error) { this.log(`蓝牙读取失败 ${this.errorText(error as BusinessError)}`); }
    this.publish();
  }

  async startWireless(address: string, localAddress: string, settings: WirelessSettings, display?:DisplayProfile): Promise<void> {
    if(!this.context){return;}
    if(!/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(localAddress)){throw new Error('无线入口测试需要填写平板本机蓝牙地址');}
    if(!wifiManager.isHotspotActive()){throw new Error('请先在系统中开启平板热点');}
    const generation=++this.wirelessGeneration;
    this.clearConnectionTimer();this.state.phase='preparing';this.state.connectionError='';this.state.connectedAt=0;
    this.connectionTimer=setTimeout(():void=>{
      if(this.state.phase==='connected'||this.state.phase==='idle'){return;}
      this.stopTests('连接超时');this.state.phase='error';this.state.connectionError='连接超时，请确认热点已开启、iPhone 已解锁且在附近';this.publish();
    },75000);
    this.preparingWireless=true;
    this.state.session='正在准备接收身份和会话入口';this.publish();
    try {
      const identity=await ReceiverIdentity.load(this.context);
      if(generation!==this.wirelessGeneration){return;}
      await this.sessionProbe.start(identity,this.context,localAddress,settings.address,settings,display);
      if(generation!==this.wirelessGeneration){return;}
      this.preparingWireless=false;
      this.state.phase='connecting';
      this.log('Ed25519 接收身份已准备；画面与触控已验证，音频互操作测试中');
      this.connectBluetooth(address,true,localAddress,settings,identity);
    } catch(error) {
      if(generation===this.wirelessGeneration){this.clearConnectionTimer();this.preparingWireless=false;this.state.phase='error';this.state.connectionError='接收端启动失败，请检查连接设置后重试';
        this.state.session=`会话启动失败 ${this.errorText(error as BusinessError)}`;this.log(this.state.session);}
    }
  }

  connectBluetooth(address: string, negotiate: boolean = false, localAddress: string = '',
    wireless: WirelessSettings | undefined = undefined, identity: ReceiverIdentity | undefined = undefined): void {
    if (negotiate && localAddress.length > 0 && !/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(localAddress)) {
      this.log('平板本机蓝牙地址格式无效；应为 AA:BB:CC:DD:EE:FF'); return;
    }
    this.stopBluetooth('准备连接');
    const generation = this.bluetoothGeneration;
    this.labSerial = util.generateRandomUUID(true);
    this.localBluetoothAddress = localAddress;
    this.wirelessSettings=wireless;this.receiverIdentity=identity;this.authenticated=false;this.wifiSent=0;this.startSent=0;
    if (negotiate && !localAddress) { this.log('实验：声明蓝牙传输信息，暂不附本机地址；兼容性待手机确认'); }
    if (negotiate && this.context) {
      this.authentication = ExperimentalAuth.load(this.context)
        .then((auth: ExperimentalAuth): ExperimentalAuth | undefined => {
          if (generation !== this.bluetoothGeneration) { return undefined; }
          this.log('实验认证材料已加载，P-256 摘要签名自检通过'); return auth;
        }).catch((error: BusinessError): undefined => {
          if (generation === this.bluetoothGeneration) { this.log(`实验认证不可用 ${this.errorText(error)}`); }
          return undefined;
        });
    }
    this.state.receivedBytes = 0; this.markerSeen = false; this.probe = new Iap2Probe();
    this.state.bluetooth = '正在连接 iAP2 RFCOMM（最多 20 秒）';
    this.publish();
    this.btTimer = setTimeout((): void => { this.stopBluetooth('连接超时'); }, 20000);
    try {
      bluetoothSocket.sppConnect(address, { uuid: IAP2_UUID, secure: true, type: bluetoothSocket.SppType.SPP_RFCOMM },
        (error: BusinessError, id: number): void => {
          if (generation !== this.bluetoothGeneration) {
            if (!error && id >= 0) { try { bluetoothSocket.sppCloseClientSocket(id); } catch (_error) {} }
            return;
          }
          if (this.btTimer >= 0) { clearTimeout(this.btTimer); this.btTimer = -1; }
          if (error) { this.stopBluetooth(`RFCOMM 失败 ${this.errorText(error)}`); return; }
          this.socketId = id;
          try {
            bluetoothSocket.on('sppRead', id, this.readCallback);
            this.state.bluetooth = 'RFCOMM 已连接，等待 iAP2 检测回复';
            this.log('已连接 DiPlay 使用的 iAP2 服务 UUID');
            if (negotiate) {
              this.link = new Iap2Link(); this.csm = new CsmObserver();
              this.link.start(this.monotonicTime()); this.pumpLink();
              this.linkTimer = setInterval((): void => {
                if (generation !== this.bluetoothGeneration || !this.link) { return; }
                try { this.link.advance(this.monotonicTime()); this.pumpLink(); }
                catch (error) { this.stopBluetooth(`链路定时器失败 ${(error as Error).message}`); }
              }, 50);
              this.btTimer = setTimeout((): void => {
                this.stopBluetooth('蓝牙引导观察结束；已建立的原生媒体会话继续运行');
              }, wireless?120000:45000);
              this.publish(); return;
            }
            bluetoothSocket.sppWrite(id, new Uint8Array(IAP2_MARKER).buffer);
            let attempts = 1;
            this.markerTimer = setInterval((): void => {
              if (generation !== this.bluetoothGeneration || this.markerSeen) { return; }
              if (attempts >= 5) { this.clearMarkerTimer(); return; }
              try { bluetoothSocket.sppWrite(id, new Uint8Array(IAP2_MARKER).buffer); attempts++; }
              catch (error) { this.stopBluetooth(`检测发送失败 ${this.errorText(error as BusinessError)}`); }
            }, 1000);
            this.btTimer = setTimeout((): void => {
              this.stopBluetooth(this.markerSeen ? 'iAP2 探测结束，尚未进入 CarPlay 认证' : 'RFCOMM 已连接，但未收到 iAP2 检测回复');
            }, 12000);
            this.publish();
          } catch (error) { this.stopBluetooth(`iAP2 探测失败 ${this.errorText(error as BusinessError)}`); }
        });
    } catch (error) { this.stopBluetooth(`连接失败 ${this.errorText(error as BusinessError)}`); }
  }

  private clearMarkerTimer(): void {
    if (this.markerTimer >= 0) { clearInterval(this.markerTimer); this.markerTimer = -1; }
  }
  sendTouch(x:number,y:number,down:boolean):void{
    this.sessionProbe.touch(x,y,down).catch(():void=>{this.log('触控发送失败，请重新连接会话');});
  }

  private monotonicTime(): number {
    return systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
  }

  private pumpLink(): void {
    const link = this.link;
    if (!link || this.socketId < 0) { return; }
    const output = link.takeOutput();
    for (let i = 0; i < output.length; i++) {
      bluetoothSocket.sppWrite(this.socketId, output[i].buffer as ArrayBuffer);
    }
    const events = link.takeEvents();
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.kind === 'dead') { this.stopBluetooth(`iAP2 链路终止：${event.detail}`); return; }
      if (event.kind === 'control') {
        const messages = this.csm.feedMessages(event.data);
        for (let j = 0; j < messages.length; j++) {
          const id = messages[j].id;
          let label = `CSM 0x${id.toString(16)}`;
          if (id === 0xaa00) { label = '手机请求 MFi 认证证书'; }
          if (id === 0xaa02) { label = '手机请求认证挑战响应'; }
          if (id === 0xaa04) { label = '手机报告认证失败'; }
          if (id === 0xaa05) { label = '手机报告认证成功'; }
          if (id === 0xaa05) { this.authenticated=true; }
          if (id === 0x5702) { label = '手机请求热点凭据'; }
          if (id === 0x4300) { label = '手机报告 CarPlay 可用性'; }
          if (id === 0x4e0d) { label = '收到无线 CarPlay 可用性更新'; }
          if (id === 0x4e0e) { label = '收到手机传输标识通知'; }
          if (id === 0x1d00) { label = '手机请求配件身份信息'; }
          if (id === 0x1d02) { label = '手机接受配件身份信息'; }
          if (id === 0x1d03) { label = `手机拒绝身份字段：${parameterIds(messages[j].body).join(', ')}`; }
          this.state.bluetooth = label; this.log(label);
          if (this.pendingControls >= 8) { this.stopBluetooth('控制请求队列超限'); return; }
          const generation = this.bluetoothGeneration;
          this.pendingControls++;
          this.answerControl(id, messages[j].body, generation, link)
            .catch((error: BusinessError): void => {
              if (generation === this.bluetoothGeneration) {
                this.stopBluetooth(`控制响应失败 ${this.errorText(error)}`);
              }
            }).finally((): void => {
              if (generation === this.bluetoothGeneration) { this.pendingControls--; }
            });
        }
      } else { this.state.bluetooth = event.detail; this.log(event.detail); }
    }
  }

  private async answerControl(id: number, body: Uint8Array, generation: number, link: Iap2Link): Promise<void> {
    if (generation !== this.bluetoothGeneration || link !== this.link) { return; }
    let response: Uint8Array | undefined;
    let label = '';
    if (id === 0x1d00) {
      const encode=(text:string):Uint8Array=>new util.TextEncoder().encodeInto(text);
      const component=this.wirelessSettings?wirelessComponent(this.wirelessSettings.ssid,encode):undefined;
      response = identification(this.labSerial, encode, this.localBluetoothAddress, component);
      label = '已发送配件身份信息（仅声明当前实现的控制消息）';
    } else if (id === 0xaa00 || id === 0xaa02) {
      const auth = await this.authentication;
      if (generation !== this.bluetoothGeneration || link !== this.link) { return; }
      if (!auth) { throw new Error('实验认证材料不可用'); }
      if (id === 0xaa00) {
        response = controlMessage(0xaa01, [parameter(0, auth.certificate)]); label = '已发送实验 MFi 证书';
      } else {
        const challenge = readParameters(body, 0);
        if (challenge.length !== 1) { throw new Error('认证挑战参数无效'); }
        const signature = await auth.sign(challenge[0]);
        response = controlMessage(0xaa03, [parameter(0, signature)]); label = '已发送 64 字节认证挑战签名';
      }
    } else if (id===0x5702||id===0x4e0e||id===0x4300) {
      if(!this.authenticated||!this.wirelessSettings||!this.receiverIdentity){return;}
      const encode=(text:string):Uint8Array=>new util.TextEncoder().encodeInto(text);
      if(id===0x4300){
        if(this.startSent>=2){return;}
        response=startWirelessSession(this.wirelessSettings,this.localBluetoothAddress,this.receiverIdentity.publicKeyHex,encode);
        this.startSent++;label='已发送无线 CarPlay 会话入口；等待手机连接 TCP 7000';
      } else {
        if(this.wifiSent>=7){return;}
        response=wifiConfiguration(this.wirelessSettings,encode);this.wifiSent++;label='已通过已认证蓝牙链路发送热点凭据（日志不记录密码）';
      }
    }
    if (response && generation === this.bluetoothGeneration && link === this.link) {
      link.sendControl(response, this.monotonicTime());
      const output = link.takeOutput();
      for (let i = 0; i < output.length; i++) { bluetoothSocket.sppWrite(this.socketId, output[i].buffer as ArrayBuffer); }
      this.log(label);
    }
  }

  stopBluetooth(reason: string = '已断开'): void {
    this.wirelessGeneration++;
    if(this.preparingWireless){this.preparingWireless=false;this.sessionProbe.stop().catch(():void=>{});this.state.session='准备已取消';}
    this.bluetoothGeneration++;
    if (this.linkTimer >= 0) { clearInterval(this.linkTimer); this.linkTimer = -1; }
    this.link = undefined; this.csm = new CsmObserver();
    this.authentication = undefined; this.pendingControls = 0;
    this.wirelessSettings=undefined;this.receiverIdentity=undefined;this.authenticated=false;
    if (this.btTimer >= 0) { clearTimeout(this.btTimer); this.btTimer = -1; }
    this.clearMarkerTimer();
    const id = this.socketId; this.socketId = -1;
    if (id >= 0) {
      try { bluetoothSocket.off('sppRead', id, this.readCallback); } catch (_error) {}
      try { bluetoothSocket.sppCloseClientSocket(id); } catch (_error) {}
    }
    this.state.bluetooth = reason;
    if(['preparing','connecting','negotiating'].includes(this.state.phase)&&reason!=='准备连接'&&reason!=='Wi-Fi iAP2 运行通道已认证；蓝牙引导连接已释放'){
      this.clearConnectionTimer();this.state.phase='error';this.state.connectionError='连接中断，请检查蓝牙配对和热点设置后重试';
      this.sessionProbe.stop().catch(():void=>{});
    }
    this.log(reason);
  }

  private clearConnectionTimer():void{if(this.connectionTimer>=0){clearTimeout(this.connectionTimer);this.connectionTimer=-1;}}
  setForeground(active:boolean):void{this.state.foreground=active;this.publish();}

  stopTests(reason: string): void {
    this.clearConnectionTimer();this.state.phase='idle';this.state.connectedAt=0;this.state.connectionError='';
    this.wirelessGeneration++;
    this.sessionProbe.stop().catch(():void=>{});this.state.session='未启动';
    this.stopNetwork().catch((error: BusinessError): void => { this.log(this.errorText(error)); });
    this.stopBluetooth(reason);
  }

  dispose(): void {
    this.stopTests('应用结束');
    if (this.subscribed) {
      try { wifiManager.off('hotspotStateChange', this.hotspotCallback); } catch (_error) {}
      this.subscribed = false;
    }
    this.onChange = (_state: LabState): void => {};
  }

  private errorText(error: BusinessError): string { return `${error.code}: ${error.message}`; }
  private log(message: string): void {
    this.state.logs.push(`${new Date().toLocaleTimeString()}  ${message}`);
    if (this.state.logs.length > 100) { this.state.logs.shift(); }
    this.publish();
  }
  private publish(): void { this.onChange(this.state); }
}
