# 未签名开发预览包

最新版本：[0.13.11 Release](https://github.com/Tedfaraday/DiPlay-Harmony/releases/tag/v0.13.11-preview) · [下载 HAP](https://github.com/Tedfaraday/DiPlay-Harmony/releases/download/v0.13.11-preview/DiPlay-Harmony-0.13.11-unsigned.hap)。附件未签名且不含实验认证材料，详见 Release。

## 历史版本

# 0.12.0 未签名开发预览包

[下载 HAP](https://github.com/Tedfaraday/DiPlay-Harmony/raw/refs/heads/main/releases/DiPlay-Harmony-0.12.0-unsigned.hap)

- 文件：`DiPlay-Harmony-0.12.0-unsigned.hap`，2,547,045 字节，arm64-v8a。
- 基于公开源码提交 `b5bc601c4c29706abb1abe78c6d5aed1f2591dde` 构建，使用 DevEco 26 / API 26；工程兼容配置 API 24。
- 未签名；使用自己的开发者账号、设备授权及签名配置后才可安装。
- 不包含实验认证材料。自行签名后可查看界面；完整无线 CarPlay 连接还需本地导入认证材料并重新构建，不能仅对本附件签名。
- 完整本地版本已验证画面、单指触控、沉浸全屏和重连。音频尚不可用，应用需保持前台。
- 包检查确认无个人签名证书/Profile、签名密钥库、热点配置、设备名称、个人用户目录和实验身份资源。编译代码包含加载认证材料的路径字符串，不代表包含认证材料本身。
- 本次只放行下列哈希对应的已检查包；其他 HAP 仍由隐私检查拒绝。

SHA-256：
```text
2a2652168e65661e22d863b3838e18d4f0c07bd26c229e253aae1f190bd4d399
```

构建、签名和认证导入步骤见 [README](../README.md#从源码构建)，协议来源见 [UPSTREAM](../docs/UPSTREAM.md)。对应源码在本仓库中按 GPL-3.0-only 提供；这不是 Apple 官方认证产品。
