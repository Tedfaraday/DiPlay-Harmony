# 原生 HarmonyOS 适配说明

Android 容器里的 APK 无法可靠获取 HarmonyOS 宿主热点状态，是本工程改用原生 HAP 的起点。APK 不能仅换扩展名获得鸿蒙系统能力，平台接口、解码、窗口与应用生命周期必须重新适配。

## 平台实现

- **网络与热点**：ArkTS 接入 Wi-Fi、蓝牙和 socket 系统 API；C++ `mdns_bridge.cpp` 在热点 IPv4 接口上提供原生 mDNS 能力。蓝牙建立无线会话入口，Wi-Fi 传送视频和触控。应用不自动开启热点。
- **密码学**：`NativePairCrypto.ets` / `ExperimentalAuth.ets` 适配 CryptoArchitectureKit；协议状态机处理认证、记录计数、重放与异常数据。接收端身份和对端公钥位于应用私有存储。
- **视频**：`video_bridge.cpp` 使用 OH_AVCodec 和 native window，将 H.264 数据交给鸿蒙原生解码器。`VideoBridge.ets` 与 `NativeScreenServer.ets` 管理 Surface、SPS/PPS、认证解密、首帧与停止。
- **触控**：`HidTouch.ts` 生成 HID 触摸报告，`ScreenInteraction.ts` 排除黑边并映射视频坐标。三指下滑在本地识别，避免向手机发送错误单指拖动。
- **显示**：`DeviceDisplay.ets` 读取原生像素、xDPI/yDPI；`DisplayProfile.ts` 统一屏幕声明、毫米尺寸、view area、safe area、HID 和解码尺寸。2560×1600 的 16:10 面板协商 1280×800，PPI 用于物理尺寸换算，像素比例用于画面匹配。
- **窗口**：`Presentation.ets` 管理系统栏、沉浸、横屏锁定与常亮；同一 XComponent Surface 在页面和全屏间复用，后台释放会话与窗口状态。
- **产品配置**：`ProfileStore.ets` 使用私有 Preferences；热点密码可选写入鸿蒙安全资产库，解锁可读且不同步。`ReconnectPolicy.ts` 做前台有限重试；`Diagnostics.ts` 对主动复制的报告脱敏。
- **界面**：`Index.ets` 四个页面，`MaterialTheme.ts` 用 Material 3 色彩角色；组件由 ArkUI 实现。

## 验证边界

无线画面、单指点击/拖动、全屏、三指退出及断开重连已经真机验证。0.12.0 的显示读取、1280×800 实际视频与首帧已通过协议/解码检查；不同设备的边缘触控和 PPI 质量仍需逐机验收。

音频解码代码存在，但 iPhone 尚未建立可用平板音频输出；不能用模拟器测试通过或音乐卡片可见来声称音频已支持。安全密码跨应用重启恢复也需要更多真机验收。锁屏/后台会主动结束会话，暂无后台连接承诺。

## 仓库结构

```text
entry/src/main/ets/lab/       无线协议、加密与媒体会话
entry/src/main/ets/product/   配置、显示、交互、诊断和窗口管理
entry/src/main/ets/pages/     ArkUI 产品页面
entry/src/main/cpp/           鸿蒙原生视频/音频/mDNS 桥
tests/                       合成数据与独立协议对端测试
tools/                       构建、本地认证导入、检查工具
docs/                        来源、适配、隐私与介绍资料
```
