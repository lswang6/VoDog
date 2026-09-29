# macOS DJI 模组设置教程

[文档目录](README.zh-CN.md) · [English](dji-setup.md) · [macOS 组件指南](../apps/macos/README.md)

## 当前可用范围

集成目标为 Apple 芯片 Mac 上的 **DJI QDC507 / Quectel EG25-G**。远程 VoDog 客户端可独立于模组音频构建。本发行**已包含所需 QDC507 内核模块、已编译 PCM helper 和 manifest**，取自固定公开 CellDock 提交，默认 macOS 构建会打包。内核模块完整对应源码/构建材料仍未取得，归档二进制并未补齐这一缺口。详见[运行时获取与构建要求](../apps/macos/module/RUNTIME.md)。

CellDock 上游提供了运行时二进制；缺少的是这些内核模块准确对应的源码与构建补丁，并不是找不到二进制。可以先用上游应用初始化、验证受支持模组，再使用仓库内已核验的运行时构建 VoDog。合成载荷测试不加载或验证真实驱动。

## 0. 买到模组后，先接入上游 CellDock

1. **确认型号与配件**：此路径针对 **DJI QDC507 / Quectel EG25-G**，不是所有“大疆 4G/增强图传模块”。使用能传数据且供电稳定的 USB 线/转接配件，插入支持语音与短信的 SIM，检查 SIM PIN、运营商 VoLTE 支持。本教程不要求焊接，也不提供通用刷机方案。
2. **安装上游应用**：从 [CellDock 官方 Releases](https://github.com/celldock/celldock-for-mac/releases) 获取应用。2026-09-29 核查时有 [0.3.1](https://github.com/celldock/celldock-for-mac/releases/tag/0.3.1)。仅连接本次准备的模组，退出 VoDog 和其他 AT/ADB/调制解调器工具。
3. **转换出厂配置**：CellDock 检测到“DJI 原始配置”后，点击 **“转换并重启”**。程序会检查目标设备、无在途通话、设备解锁挑战及准确 USB 配置，再启用支持的接口、逐项回读并重启。不要套用其他设备的解锁响应；遇到“不兼容/未通过校验”不要强行写入。
4. **完成 ECM 初始化**：若提示尚未初始化，点击 **“确认初始化”**，等待 USB 重新枚举。此 DJI 路径的目标是 `2C7C:0125`、AT/ADB/音频接口已开启，以及 CDC-ECM `usbnet=1`。“模块已准备好”只代表 USB/网络前提通过，不代表双向通话已经验收。
5. **先在 CellDock 验证**：逐项检查 SIM 注册、短信收发、呼入/呼出、双方声音及录音，通话测试使用同意参与的人员。所引用 QDC507 运行时要求 root ADB、`3.18.44` 内核、匹配声卡/设备节点和 UAC 音频路径；仅内核版本字符串相同不能证明 ABI 兼容，失败时先看应用诊断。
6. **再交给 VoDog**：完全退出 CellDock，再启动 VoDog，避免同时占用 AT/音频。按下文构建包含运行时的 VoDog，之后配对、分配 SIM 并独立验收。**在 CellDock 初始化过，不等于不带 payload 的 VoDog 就能工作**：驱动/helper 属于运行时准备，VoDog 即使发现驱动已加载，仍会检查自身随包组件。

CellDock 0.3.1 对某些 **Quectel 原生设备**另有不依赖 ADB/KO 注入的后端；这不是本发行 DJI QDC507 路径的替代方案，不能据此绕过运行时前提。见[上游发布说明](https://github.com/celldock/celldock-for-mac/releases/tag/0.3.1)。

核查依据：上游[初始化界面](https://github.com/celldock/celldock-for-mac/blob/6d0461de3a94292e7549a1d8e6e9180bd0b5ed0c/Sources/CellDock/CellDockInitialSetupView.swift)、[带保护的转换逻辑](https://github.com/celldock/celldock-for-mac/blob/6d0461de3a94292e7549a1d8e6e9180bd0b5ed0c/Sources/CellDock/ModemService.swift)及[运行时清单](https://github.com/celldock/celldock-for-mac/blob/6d0461de3a94292e7549a1d8e6e9180bd0b5ed0c/Resources/ModuleVoice/manifest.json)。链接均为公开上游材料，不含私人安装记录。

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

[运行时指南](../apps/macos/module/RUNTIME.md)说明了已归档组件及校验方法。默认打包使用仓库内的 `Resources/ModuleVoice`，只有换用审核过的其他版本时才设置 `VODOG_MODULE_VOICE_DIR`。上游 manifest 和三个二进制哈希均与本发行参考清单一致；这只证明来源一致，不代表真机验收或完整对应源码已经齐备。公开再分发仍需补全准确源码/构建材料和相应声明，可向供应方/维护者获取或从完整源码构建。不设置此变量即使用仓库内载荷。

## 3. 配对、分配与就绪

1. Web 管理端创建网关，生成配对码。
2. Mac 网关设置选择当前模组，填服务器与配对码，在关闭状态配对。
3. 启用后，在 Web 将发现的 SIM 分给目标用户。界面提供时，管理员“加入账号”可合并这些步骤；普通用户仍需管理员分配。
4. 每块模组分别检查 SIM/运营商注册、电话/短信、语音运行时、媒体和设置 ACK，不覆盖失败的语音门。
5. 本机通话授予麦克风权限，只批准预期 helper。保持 App 运行；每块接入且已配对模组都有独立网关实例。

凭据存在 Keychain，并可能复制到模组 `/data/vodog/vodog-gateway.json`。这是产品运行路径，不是私人目录。模组丢失按凭据丢失撤销/重新配对，不复制他人的 Keychain 或模组 token。

## 4. 验证正确路径

远端 SIM 走 Control 和中继；符合条件的本机 SIM 可直连 Mac/模组音频，共享录音仍需绑定与 finalize。确认 UI 实际选择的路径。核对随附运行时与硬件兼容后，再按[验收](operations.zh-CN.md)进行获批电话/短信，分别记录音频、录音、AI、重连结果。

随附载荷还用于经 helper 的 VoWiFi 控制/状态、ECM 恢复和模组凭据导入/导出，缺失或校验失败仍会阻断这些路径。PCM helper 源码/构建配方已附；两个内核模块提供的是上游二进制，完整对应源码缺口另行说明。
