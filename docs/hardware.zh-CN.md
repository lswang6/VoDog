# 硬件要求

**未附语音载荷：**兼容 QDC507 内核模块及已编译 PCM 载荷已排除，准备 USB 身份本身不足以获得语音。见 [DJI 设置](dji-setup.zh-CN.md)及运行时要求。

[文档目录](README.zh-CN.md) · [English](hardware.md)

## Pixel 网关

参考集成目标为 Pixel 7 Pro。使用其他机型或系统版本前，必须逐项确认：

1. bootloader 可解锁。运营商锁定、无法开启 OEM 解锁的机型不能默认适用；解锁通常清空用户数据，先做好可恢复备份。
2. 该系统可使用 root 和经过审核的 Magisk 特权应用模块。仅侧载 APK 无法获得受保护的电话与音频能力。
3. SIM 已激活并注册，运营商已开通语音与短信。数据卡或仅显示注册成功，不证明电话可用。
4. Telecom/InCallService、SIM 身份读取、通话音频采集/注入、前台麦克风服务可以协同工作。
5. 可访问 Control 与 TURN，并具备足够存储、稳定供电和适合持续运行的散热条件。

特权集成涉及 `CONTROL_INCALL_EXPERIENCE`、`MODIFY_PHONE_STATE`、`CAPTURE_AUDIO_OUTPUT`、`READ_PRIVILEGED_PHONE_STATE`、`CHANGE_COMPONENT_ENABLED_STATE`。部分功能还需运行时权限或明确的 root 授权；manifest 声明不等于实际获批。

保留正常系统拨号器和现有安全策略。不能为了让就绪指示变绿而关闭 SELinux、修改无关基带配置或扩大权限。Android、Magisk 或 target SDK 更新后需重新验证。Pixel 网关和 Android 用户端是独立应用，即使安装在同一手机上也如此。

在总控关闭时配对，确认 SIM 归属和全部就绪门后再启用真实操作。远程开启需要单独授权的待命能力，不是让已关机手机远程开机。BCR 是独立第三方录音器，不是必需组件，也不能替代 VoDog 归档验收；其与各录音路径的交互需单独验证。

## DJI 模组网关

确切集成为 **DJI QDC507，Quectel EG25-G 基带**。不能外推为支持 DJI Cellular Dongle 2、其他修订版、普通 LTE 网卡或所有 DJI 设备。

| 项目 | 集成条件 |
| --- | --- |
| Mac | Apple 芯片；文档基线为 macOS 14 及以上，仍需核对导出 package 的最低版本 |
| 会话 | 已登录 GUI 会话，应用运行且网关开启；helper 可能需要管理员交互 |
| 模组 | QDC507 / EG25-G、兼容固件、可用 AT/ADB 接口 |
| 出厂 USB 身份 | `0x2CA3:0x4006` |
| 准备后的 USB 身份 | `0x2C7C:0x0125`，产品名 `EG25G_QDC507` |
| 语音接口 | USB Audio Class，集成使用 8 kHz 单声道模组音频 |
| SIM | 每模组一张可用语音/短信 SIM；必须检查运营商语音/VoLTE 兼容性 |

出厂身份模组需要按集成中的已审核流程准备。身份转换会改变配置并重启模组，只能在自有、空闲硬件和明确恢复方案下执行。不能对未知固件盲目套用 AT 写命令。

应用独占 USB 控制接口，运行期间不要用第二个 AT/ADB 工具争抢模组。授予必要的麦克风等权限。没有 USB 音频接口、语音运行时失败或未注册运营商，都应视为阻断，即使设备列表可见。

多个模组可分别运行网关，每个都需配对和验证。凭据可能同时存于 Keychain 和模组，持有模组应等同持有网关凭据。换 Mac 不会转移全部本地待发队列，接入前的命令不能盲目重放。模组丢失或被他人持有后，应撤销旧凭据或重新配对。

Mac 可通过其他网络连接 Control 和 TURN，不必使用模组的数据网络。Mac 休眠、拔模组、退出应用或关闭网关都会影响可用性。未 root Pixel 或普通 USB 网卡不能作为等价替代。
