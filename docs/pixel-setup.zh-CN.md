# Pixel 网关设置教程

[文档目录](README.zh-CN.md) · [English](pixel-setup.md) · [硬件要求](hardware.zh-CN.md)

本教程面向自有、可解锁、具有兼容 Android/电话音频能力的 Pixel 7 Pro。先完成[服务器配置](installation.zh-CN.md)。以下命令用于你授权的安装，文档发布本身不会执行操作。

## 1. Root 与恢复准备

备份手机，确认准确机型/系统 build 及 OEM 解锁可用。从 [Google 官方 Pixel 镜像](https://developers.google.com/android/images)获取匹配固件，遵守其条款与机型说明。VoDog 不分发原厂、修改后的 boot/init_boot、OTA 或基带镜像。

按[官方 Magisk 安装指南](https://topjohnwu.github.io/Magisk/install.html)在目标设备操作。Pixel 7 Pro 路径需要匹配的 `init_boot`，在将被 root 的手机上打补丁，不使用他人修改镜像。解锁可能清空数据。重启后确认 root，保留匹配原厂版本的恢复方案。保持 SELinux enforcing，不在不兼容修改分区上重新锁定。

[外部组件清单](../infra/pixel/external/README.md)提供 root/音频依赖源码、许可和来源。BCR 属于独立录音功能；可选 IMS 工具不是通用运营商修复，也不是必装网关依赖。

## 2. 构建网关和特权模块

安装导出项目要求的 Android 工具链，在仓库根执行：

```bash
VODOG_API_BASE_URL=https://vodog.example.com/api/v1 bash scripts/build-android.sh
```

换成自己的 HTTPS API 地址，结尾必须为 `/api/v1`。脚本构建/测试用户端与网关，并启用五个网关验收门。保留 APK、构建输出和签名证书指纹。分发构建使用自己的持久签名密钥，特权底包和用户更新不能随意更换签名。

用本机 SDK `aapt` 与**针对目标系统/target SDK 已核实的 SELinux 域**构建：

```bash
export VODOG_AAPT="$ANDROID_HOME/build-tools/<installed-version>/aapt"
export VODOG_SELINUX_DOMAIN='<verified-privileged-app-domain>'
python3 infra/pixel/build-module.py   apps/android/gateway/build/outputs/apk/debug/gateway-debug.apk   --aapt "$VODOG_AAPT"   --selinux-domain "$VODOG_SELINUX_DOMAIN"   --output /tmp/vodog-pixel-module
```

尖括号值必须替换。不能从其他 Android 版本猜特权应用域，应依据匹配平台策略/已验证集成确认；无法确认时停在安装之前。构建器核对 `org.vodog.gateway` 与特权声明，输出 `vodog-gateway-magisk.zip`、`module-manifest.json`，不 root、不装机，清单中 `installed: false`。

检查内容：

```bash
unzip -l /tmp/vodog-pixel-module/vodog-gateway-magisk.zip
cat /tmp/vodog-pixel-module/module-manifest.json
```

## 3. 在空闲维护窗口安装

手机 Magisk 中进入 **模块 → 从本地安装**，选择审核后的 ZIP 并重启。模块提供系统特权 APK、权限白名单和窄范围策略；首次准备不能仅靠 `adb install`。检查通过前保持总控关闭。

启用 USB 调试，明确选择当前设备，不复用其他机器保存的序列号。下面是只读检查，输出可能包含私人设备状态，应私密保存：

```bash
export VODOG_ADB_SERIAL='<your-device-serial>'
adb -s "$VODOG_ADB_SERIAL" shell pm path org.vodog.gateway
adb -s "$VODOG_ADB_SERIAL" shell dumpsys package org.vodog.gateway
adb -s "$VODOG_ADB_SERIAL" shell cmd role get-role-holders android.app.role.DIALER
```

确认应用被识别为 privileged，且实际授予 `CONTROL_INCALL_EXPERIENCE`、`MODIFY_PHONE_STATE`、`CAPTURE_AUDIO_OUTPUT`、`BYPASS_CONCURRENT_RECORD_AUDIO_RESTRICTION`、`READ_PRIVILEGED_PHONE_STATE`、`CHANGE_COMPONENT_ENABLED_STATE`。保留 Google 电话为默认拨号器；网关通过 InCallService 工作，不取代拨号器。

打开 VoDog 网关，通过 Android 设置授予请求的电话、短信、麦克风、通话记录、通知权限；检查前后台运行与电池限制。仅对已审核且需要 root 的功能（如系统黑名单集成）授权 su。manifest 声明或普通麦克风权限不证明受保护电话音频可用。

## 4. 配对与 SIM 分配

1. 用自己的 Web 管理员登录，在网关管理创建网关并生成配对码。
2. Pixel 填服务器和配对码，成功前保持总控关闭。
3. 应用发现真实 SIM 后，在管理端分配给目标用户，可填写名称/号码标签，但不能把标签当真实身份。
4. 以该用户登录确认 SIM，开启总控，分别检查电话、短信、媒体与对账就绪。
5. 修改一项无害 SIM 设置，确认 desired 已保存，并等待精确 applied ACK；超时或版本不一致先排查，再真实通话。

## 5. 功能门与首次验收

新主机配置会启用归档、防重迁移/horizon、DTMF、早期媒体、忙线与本机去电。使用当前网关并开启匹配的五门：`vodogCellularAcceptance`、`vodogRecordingArchive`、`vodogLibopusFec`、`vodogReceiveRecovery`、`vodogCommandReplayHorizon`。构建日志只证明请求了参数，还需检查实际 APK/构建字段与运行就绪。

空闲时测试 OFF/ON、关闭后正常电话行为，再按[验收](operations.zh-CN.md)测试获批电话/短信和双方录音。BCP 是可选组件：发行代码已处理其缺失时的音频所有权获取、释放和恢复，并有专项回归测试覆盖。全新无 BCP 真机安装仍未验收，代码修复不能替代该项验证。

恢复时可在空闲窗口通过 Magisk 禁用 VoDog 模块并重启，保留原设备配置和匹配恢复镜像。不能清防重账本或改 SIM 身份消除就绪故障。模块安装成功不等于蜂窝验收。
