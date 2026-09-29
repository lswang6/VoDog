# macOS DJI 模组设置教程

[文档目录](README.zh-CN.md) · [English](dji-setup.md) · [macOS 组件指南](../apps/macos/README.md)

## 当前可用范围

集成目标为 Apple 芯片 Mac 上的 **DJI QDC507 / Quectel EG25-G**。远程 VoDog 客户端可独立于模组音频构建。本源码发行**不包含初始化本机/网关语音所需的 QDC507 内核模块与已编译模组 PCM 载荷**：因为缺少与内核二进制准确对应的源码/构建输入而排除，并非假定获得私有许可例外。详见[运行时获取与构建要求](../apps/macos/module/RUNTIME.md)。

没有合规、自行构建验证的兼容运行时，不能声称 DJI 本机通话、网关音频、录音采集或经此模组的 AI 音频可用。数据/短信依赖固件，也需硬件验证。合成载荷测试不加载或验证真实驱动。

## 1. 构建与配置 Mac 应用

先读[许可](licensing.zh-CN.md)中的 CellDock 非商业条件，再按组件指南准备工具链。从根目录执行：

```bash
(cd apps/macos && swift build --disable-sandbox --cache-path .build/cache)
(cd apps/macos && scripts/run_tests.sh && scripts/run_gateway_control_tests.sh && scripts/run_gateway_media_tests.sh)
(cd apps/macos &&   VODOG_SIGNING_MODE=development   VODOG_CODESIGN_IDENTITY='Apple Development: <your identity>'   scripts/build_app.sh)
```

使用真实证书身份，不能用 ad-hoc 代替打包签名。开发签名不等于公证。ZIP 输出在 `apps/macos/outputs/`，目标 Mac 不需要构建工具链。按组件安装说明安装审核过的 App，按需批准其签名网络 helper，在已登录 GUI 会话启动。

客户端默认 `https://vodog.example.invalid`，刻意不可用。首次登录前配置自己的 HTTPS origin：

```bash
defaults write org.vodog.macos VoDogBaseURL -string 'https://vodog.example.com'
```

替换域名并重启。也可在启动可执行文件的进程环境传 `VODOG_BASE_URL`；shell export 不一定传给 Finder 启动的应用。origin 不含凭据、路径、query 或 fragment。网关配对服务器在设置中独立配置，也要填写。切换服务器后重新登录/配对，不导入旧凭据。

## 2. 准备受支持模组

用 USB 数据连接接入一块空闲 QDC507，关闭其他 AT/ADB 工具。在 App 模组视图检查识别结果与固件，再使用带保护检查的**转换模组身份**流程。

- 出厂 USB：`2CA3:4006`。
- 准备后 USB：`2C7C:0125`，具备 AT/ADB、USB 音频、ECM（`usbnet=1`）。
- 语音使用 8 kHz UAC，且要求组件指南与 `module/RUNTIME.md` 描述的匹配内核/音频接口。

转换会改配置并重启，过程中不要拔线或通话。不刷普通 EG25 或其他 DJI 产品固件；本项目不供应原厂固件。识别或准备失败就停止并诊断，不强套其他型号配置。

语音运行时需向供应方/上游维护者取得准确对应源码、补丁、内核配置、符号版本和工具链，独立构建验证。打包时将 `VODOG_MODULE_VOICE_DIR` 指向包含组件及正确大小/SHA-256 manifest 的私密目录；不设置则不带可选语音载荷。仓库不自动下载未验证载荷。

## 3. 配对、分配与就绪

1. Web 管理端创建网关，生成配对码。
2. Mac 网关设置选择当前模组，填服务器与配对码，在关闭状态配对。
3. 启用后，在 Web 将发现的 SIM 分给目标用户。界面提供时，管理员“加入账号”可合并这些步骤；普通用户仍需管理员分配。
4. 每块模组分别检查 SIM/运营商注册、电话/短信、语音运行时、媒体和设置 ACK，不覆盖失败的语音门。
5. 本机通话授予麦克风权限，只批准预期 helper。保持 App 运行；每块接入且已配对模组都有独立网关实例。

凭据存在 Keychain，并可能复制到模组 `/data/vodog/vodog-gateway.json`。这是产品运行路径，不是私人目录。模组丢失按凭据丢失撤销/重新配对，不复制他人的 Keychain 或模组 token。

## 4. 验证正确路径

远端 SIM 走 Control 和中继；符合条件的本机 SIM 可直连 Mac/模组音频，共享录音仍需绑定与 finalize。确认 UI 实际选择的路径。补齐缺失运行时后，再按[验收](operations.zh-CN.md)进行获批电话/短信，分别记录音频、录音、AI、重连结果。

缺少载荷还会阻断经 helper 的 VoWiFi 控制/状态、ECM 恢复和模组凭据导入/导出。不带载荷的构建不能视为可用 DJI 网关。PCM helper 源码/构建配方已附，但单独编译它不能补齐缺失内核模块。
