# DiPlay 来源与鸿蒙移植关系

## 来源基线

- DiPlay：shihabal3amri 与贡献者，https://github.com/shihabal3amri/DiPlay
- 研究与移植基线：v0.2.12；参考提交 `22d2aacedcadc4ec1aef0d74b161b05321f708a7`。
- DiPlay 继承 xcertplay：shilapi 与贡献者，https://github.com/shilapi/xcertplay
- 保留 GPL-3.0-only 许可证全文与归属，鸿蒙改写未消除原实现的许可义务。

## 模块映射

以下列的是协议/实现来源，不表示把 Kotlin 文件原样作为 ArkTS 运行，也不表示 Android 平台功能全部可用。原路径位于 DiPlay 的 `shared/src/main/java/com/shilapi/xcertplay/`。

| DiPlay 参考文件 | 本工程对应实现 |
| --- | --- |
| Iap2LinkEngine.kt、Iap2CsmFramer.kt、Iap2IdentificationClient.kt | Iap2Probe.ts、Iap2Link.ts、Iap2Control.ts、IapPackages.ts |
| Iap2WifiCarPlayClient.kt | WirelessControl.ts 与 LabController.ets 的无线引导 |
| LocalMfiAuthenticationClient.kt、Iap2MfiAuthenticationClient.kt | ExperimentalAuth.ets 与认证挑战消息 |
| PairSetup.kt、Srp6a.kt、Tlv8Codec.kt | PairingCore.ts、NativePairCrypto.ets |
| PairVerify.kt、ControlCipher.kt、AirPlayCrypto.kt、MfiSapAuthSetup.kt | PairVerify.ts、ControlCipher.ts、MfiSap.ts |
| BplistCodec.kt、AirPlayInfoPlist.kt | Bplist.ts、ReceiverInfo.ts、DisplayProfile.ts |
| AirPlayHid.kt | HidTouch.ts、ScreenInteraction.ts |
| NtpClock.kt、ScreenStream.kt | TimingClock.ts、ScreenCodec.ts、NativeScreenServer.ets |
| AudioStream.kt、CarPlayMediaEngine.kt、MediaCodecSupport.kt | AudioCodec.ts、NativeAudioServer.ets、audio_bridge.cpp（路由仍未完成） |
| CarPlayBonjour.kt | AirPlayDiscovery.ets、HotspotMdns.ets、mdns_bridge.cpp |

工程的窗口、媒体、网络、存储、页面和生命周期适配使用 HarmonyOS API；Android MediaCodec、Activity、Keystore、热点容器与 ADB 不作为运行依赖。ArkUI 界面独立实现，未复制 DiPlay 所引用的 DiAuto Android UI/网站资产；原版对 DiAuto 的归属可在原版仓库查看。

## 实验认证材料

原版 DiPlay 的公开说明将其本地实验配件身份描述为来自公开 Carlinkit 固件，非 Apple 为 DiPlay 新签发的 MFi 身份。鸿蒙开发验证使用本地导入材料完成认证研究。这与 HAP 的开发者签名完全独立。

本仓库只保留加载接口与本地导入脚本，**不包含私钥、证书或带有材料的二进制应用**。没有材料的源码构建可展示 UI，但不能完成完整无线握手。未来 iOS 的接受情况和身份的通用分发适用性没有保证。

## 项目名称与维护

“DiPlay Harmony” 表示基于 DiPlay 的鸿蒙原生适配；本仓库独立维护，不宣称官方分支、上游背书或 Apple 认证。公开 Git 历史从清理后的本工程快照开始，未伪造上游提交历史或 GitHub fork 标记。
