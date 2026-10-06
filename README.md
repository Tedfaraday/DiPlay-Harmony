# DiPlay Harmony

**基于 [DiPlay](https://github.com/shihabal3amri/DiPlay) 协议实现的原生 HarmonyOS NEXT 无线 CarPlay 显示接收端。**

让鸿蒙平板接收 iPhone 的 CarPlay 画面，并用平板触控操作。当前为 **0.12.0 产品预览版**：无线画面、单指触控、沉浸全屏与重连已完成真机验证；**音频暂不可用，需要保持应用前台**。

## 下载未签名 HAP

[下载 0.12.0 未签名 HAP](https://github.com/Tedfaraday/DiPlay-Harmony/raw/refs/heads/main/releases/DiPlay-Harmony-0.12.0-unsigned.hap) · [发行说明](https://github.com/Tedfaraday/DiPlay-Harmony/releases/tag/v0.12.0-preview) · [包校验与使用边界](releases/README.md)

该包从公开脱敏源码构建，**需要自行签名，且不包含实验认证材料**。签名后可查看应用界面；完整无线连接需在本地导入认证材料并重新构建，不能仅靠给本附件签名实现。公开包没有个人设备授权 Profile、用户热点配置或开发者签名。

## 与 DiPlay 的关联

本工程以 **DiPlay 0.2.12** 的开源实现为协议适配基础，移植并改写其 iAP2、无线引导、配对、加密控制、视频和 HID 触控逻辑。感谢 **shihabal3amri、shilapi 与原项目贡献者**。

项目沿用 “DiPlay” 名称表达技术来源，“Harmony” 表示原生鸿蒙平台适配。本仓库是独立维护的鸿蒙移植工程，未宣称得到原作者、Apple 或华为的官方认可；不是原版项目的官方发行版。工程以干净的源码快照开始，因此 GitHub 不显示 fork 关系；关联通过本页、[来源映射](docs/UPSTREAM.md)、[NOTICE](NOTICE.md) 和 GPL-3.0 许可证说明。

原版面向 Android 车机；本工程使用 **ArkTS / ArkUI + HarmonyOS 原生 C++ API**，运行于 HAP 应用中，不依赖 Android APK、卓易通容器或 Android ADB。没有移植原版 BYD HUD、车辆数据、有线 USB CarPlay 等车机功能。

## 为原生鸿蒙额外完成的工作

| 适配部分 | 鸿蒙实现与新增工作 |
| --- | --- |
| 系统热点 | 使用 HarmonyOS Wi-Fi API 读取热点状态、订阅变化，绕过 Android 容器无法感知宿主热点的问题；热点由用户在系统中开启 |
| 蓝牙引导 | 将 iAP2 帧、CSM/TLV、身份信息和无线入口改写为 ArkTS，并接入鸿蒙蓝牙 RFCOMM |
| 配对与加密 | 用鸿蒙 CryptoArchitectureKit 实现原生密码学适配，完成 Pair-Setup、Pair-Verify、认证和加密控制；接收身份保存在应用私有存储 |
| 热点服务发现 | C++ 热点接口 mDNS 桥、IPv4 发现、端口监听及经过认证的手机过滤 |
| 视频显示 | C++ OH_AVCodec H.264 解码桥连接 ArkUI XComponent Surface；首帧确认、会话结束与 Surface 生命周期管理 |
| 屏幕适配 | 读取像素宽高和物理 PPI，统一显示声明、视频流、HID 坐标与解码配置；16:10 面板可协商 1280×800，保持比例 |
| 交互与沉浸 | 单指 HID 点击/拖动、触点映射、全应用沉浸、横屏全屏；三指下滑在平板本地唤出退出面板 |
| 产品界面 | 连接、设置、诊断、关于四页；参考 Material 3 色彩角色，以 ArkUI 实现扁平分区和线形图标 |
| 配置与恢复 | 私有 Preferences、可选安全资产库密码存储、超时/取消/断开、前台 2/4/8 秒有限重试、常亮恢复 |
| 验证 | 合成数据测试覆盖协议、加密、媒体生命周期、取消、重试、配置及脱敏；真实设备验证画面和触控 |

详细接口、模块和验证边界见 [原生鸿蒙适配说明](docs/HARMONYOS.md)。

## 功能与当前限制

- 无线 CarPlay 画面与单指触控，H.264 / 30 FPS，视频长边上限 1280 像素。
- 横屏纯画面全屏；三指同时向下滑动，选择“返回应用”或“继续全屏”。普通应用页也保持沉浸。
- 保存连接配置；热点密码默认不持久保存，可选择写入鸿蒙安全资产库。
- 可选前台断线重试，手动断开、锁屏或进入后台即停止。
- **音频仍由 iPhone 输出，未完成平板音频路由。** 音频接收/解码基础代码与测试不代表这一功能可用。
- 锁屏或切换应用会断开；未实现后台连接、多指远程输入、麦克风、通话与 Siri 音频。
- 本机蓝牙地址仍需手动填写；当前热点发现只覆盖 IPv4。
- 当前开发验证组合：MatePad mini / HarmonyOS 7、iPhone 16 Pro / iOS 27。其他设备兼容性尚待验证，公开 SDK 最低配置不代表已在全部兼容版本验证。

## 首次使用

1. 在系统设置中配对 iPhone 与平板，开启平板热点。
2. 在应用设置中选择已配对 iPhone，填写与系统一致的热点名称、密码与安全类型。
3. 从 iPhone 当前热点的 Wi-Fi 详情读取“路由器” IPv4 地址；填写平板本机蓝牙地址，不使用示例地址代替实际值。
4. 保存设置，返回首页连接。保持 iPhone 解锁，出现 CarPlay 确认时允许。
5. 画面出现后用单指操作；全屏中三指下滑唤出退出面板。

## 从源码构建

公开仓库提供源码、无签名构建模板、测试和介绍资料，**不提供个人开发签名 HAP，也不包含实验认证私钥**。

1. 安装 DevEco Studio 与 HarmonyOS SDK。开发环境为 DevEco 26 / API 26，工程兼容配置为 API 24。
2. 用 DevEco 打开工程，安装 ohpm 依赖。先将 `build-profile.template.json5` 复制为 `build-profile.json5`；模板没有签名信息。
3. 如需真机安装，使用自己的开发者账号、设备授权与签名配置。本机生成的签名配置不会进入 Git。
4. 可在 DevEco 构建，或设置安装路径后执行：

```powershell
$env:DEVECO_STUDIO_HOME = '<你的 DevEco Studio 安装目录>'
Copy-Item build-profile.template.json5 build-profile.json5
& "$env:DEVECO_STUDIO_HOME/tools/ohpm/bin/ohpm.bat" install
Push-Location entry
& "$env:DEVECO_STUDIO_HOME/tools/ohpm/bin/ohpm.bat" install
Pop-Location
.\tools\build.ps1
```

根目录与 `entry` 模块需要分别安装 ohpm 依赖；否则原生桥类型会丢失并导致 ArkTS 类型错误。无实验认证材料可以构建界面，真机打开仍需自己的签名，完整无线认证还需要本地实验材料。认证导入工具要求你自行提供有权使用的本地 APK：

```powershell
.\tools\import-auth.ps1 -ApkPath '<本地 DiPlay APK 路径>'
```

实验身份不是 Apple 为本项目签发的 MFi 认证；其来源、兼容性和分发边界见 [来源说明](docs/UPSTREAM.md)。本仓库不重新分发该私钥。

## 自动化检查

安装 Node.js 与 Python 3，然后运行：

```shell
npm ci
npm test
npm run audit:public
```

测试使用生成的密钥与合成热点信息，不读取真实设备密码。`python` 需在 PATH 中；也可用 `DIPLAY_PYTHON` 指定解释器。`npm test` 检查独立 Node/OpenSSL 对端、错误数据与重放拒绝，以及平台模拟状态机；不替代真机兼容性测试。

## 介绍资料

[自动播放产品介绍 PPT](docs/presentation/DiPlay-Harmony-public.pptx) · [直接放映版](docs/presentation/DiPlay-Harmony-public.ppsx)

公开版介绍保留自动动画，已移除带有个人设备名称、地图位置、常用地点与拍摄环境的原始实机图片。公开资料不包含原始照片、原版视频、诊断日志或制作中间文件。

## 隐私与开源

数据在本机保存，诊断由用户主动复制；应用不会自动上传诊断记录。公开快照采用文件白名单重新建立，排除了签名、认证材料、原始日志、设备序列号和本机路径。详见 [隐私与发布检查](docs/PRIVACY.md)。

代码遵循 **GPL-3.0-only**，见 [LICENSE](LICENSE)、[NOTICE](NOTICE.md) 与 [来源映射](docs/UPSTREAM.md)。Material Symbols 介绍图标遵循 Apache-2.0。CarPlay 名称与界面属于 Apple；本项目并非 Apple 官方认证产品。
