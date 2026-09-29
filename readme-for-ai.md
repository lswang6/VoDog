# VoDog: AI-assisted installation

[English README](README.md) · [中文首页](README.zh-CN.md) · [Host installer](infra/README.md)

Use this sequence to help a user install the public repository on a **fresh, dedicated Ubuntu 24.04 amd64 host**, then connect one gateway. Execute host/device changes only within the user's requested scope; agree on test recipients before real calls or SMS. Keep generated secrets and device output private.

## 1. Collect the installation values

Ask for the public repository URL, application domain, TURN domain, host interface/public IPv4, ACME email, desired admin username, and gateway choice. Confirm at least 4 GB RAM, available recording storage, a supported voice/SMS SIM, and an unlockable rooted Pixel or the specific DJI QDC507 / EG25-G. Apple, FCM, and AI credentials can be added later; they are not required to build the basic services.

Read [host requirements](infra/README.md), [hardware](docs/hardware.md), and [license boundaries](docs/licensing.md). First-party code is AGPL-3.0; CellDock-derived macOS code retains its non-commercial terms. The public CellDock DJI kernel/PCM binaries are now bundled unchanged. Exact corresponding kernel source/configuration/patches have not been obtained; do not claim complete or reproducible kernel source or resolved redistribution obligations. Kernel modules retain GPL-2.0 terms. See [runtime provenance](apps/macos/module/RUNTIME.md). Bundling does not establish physical module acceptance.

## 2. Clone the public repository

Use the actual URL supplied by the user or repository page; do not substitute an unrelated organization.

```bash
export VODOG_REPOSITORY_URL='<public-repository-url>'
git clone "$VODOG_REPOSITORY_URL" VoDog
cd VoDog
```

All angle-bracket values and example domains below require replacement. Point application/TURN DNS A records at the new host. Open TCP 80/443, UDP 3478, TCP 5349 and UDP 49160–49200; preserve administration access and keep 5432/16880/16881 private. Do not add AAAA without configuring IPv6. The installer leaves firewall policy to the operator.

## 3. Generate private configuration, inspect, and install

Run on the intended Ubuntu host from the checkout:

```bash
python3 infra/prepare.py \
  --domain vodog.example.com --turn-domain turn.example.com \
  --public-ip 203.0.113.10 --listen-ip 192.0.2.10 \
  --output /srv/vodog-state
```

Use actual addresses, not those documentation ranges. A directly assigned public address is used for both IP flags; NAT needs the correct interface/mapping plus relay-port preservation and hairpin support. Preparation refuses an existing output directory or one inside the checkout. It creates independent secrets and private `admin.env`, `control.env`, `voice.env`, and Compose configuration. Inspect privately, set the desired admin username in `admin.env`, and never print or commit generated passwords/tokens.

Check the candidate, then install:

```bash
python3 -B infra/test_prepare.py
bash -n infra/install-host.sh scripts/build-android.sh
sudo bash infra/install-host.sh /srv/vodog-state admin@example.com
```

Replace the email with the user's ACME contact. Running installation accepts the CA's terms and changes the dedicated host. It rejects example domains, installs dependencies, builds images, initializes PostgreSQL/schema, seeds the configured administrator, obtains certificates, starts services, and schedules renewal/retention. Do not re-run seed casually: it resets a matching account's password/role. The fresh installer refuses an existing database volume. Upgrade instructions are in [infra/README.md](infra/README.md).

## 4. Verify the host before hardware

```bash
sudo docker compose --project-directory /srv/vodog-state \
  -f /srv/vodog-state/compose.json ps
(cd services/media && go build -o /tmp/vodog-quality-relay-probe ./cmd/quality-relay-probe)
sudo python3 infra/check-media.py /srv/vodog-state \
  --probe-binary /tmp/vodog-quality-relay-probe
openssl s_client -connect turn.example.com:5349 \
  -servername turn.example.com -verify_return_error </dev/null
```

Building the probe needs the Go toolchain declared by `services/media/go.mod` on the build host. Substitute the real TURN hostname. The probe checks signed HTTPS signaling, UDP allocation and relay data-channel echo without dialing. Certificate verification is separate from actual TURN/TLS media. Complete a normal Web login, check private-route rejection, and record any blocked prerequisite. Do not bypass TLS, login challenges or authorization.

## 5A. Pixel gateway

On the Android build machine, use [Pixel setup](docs/pixel-setup.md) for root, official matching firmware, privileged permissions, default dialer and recovery details. No stock or patched firmware is distributed.

```bash
VODOG_API_BASE_URL=https://vodog.example.com/api/v1 bash scripts/build-android.sh
export VODOG_AAPT="$ANDROID_HOME/build-tools/<installed-version>/aapt"
export VODOG_SELINUX_DOMAIN='<verified-privileged-app-domain>'
python3 infra/pixel/build-module.py \
  apps/android/gateway/build/outputs/apk/debug/gateway-debug.apk \
  --aapt "$VODOG_AAPT" --selinux-domain "$VODOG_SELINUX_DOMAIN" \
  --output /tmp/vodog-pixel-module
```

The script enables the five gateway gates. Replace the placeholders with verified values. Review the module/manifest, install through Magisk **Modules → Install from storage** while idle, reboot, and verify actual privileged/runtime grants. Keep Google Phone as default dialer and SELinux enforcing. Optional BCP absence is handled during acquisition, release, and recovery, with focused regression coverage. Fresh physical-device acceptance without BCP remains unverified.

## 5B. macOS client / DJI gateway

On the Mac, follow [DJI setup](docs/dji-setup.md) and the [component guide](apps/macos/README.md):

```bash
(cd apps/macos && swift build --disable-sandbox --cache-path .build/cache)
(cd apps/macos && scripts/run_tests.sh && scripts/run_gateway_control_tests.sh && scripts/run_gateway_media_tests.sh)
(cd apps/macos && VODOG_SIGNING_MODE=development \
  VODOG_CODESIGN_IDENTITY='Apple Development: <your identity>' scripts/build_app.sh)
defaults write org.vodog.macos VoDogBaseURL -string 'https://vodog.example.com'
```

Install the reviewed signed package, approve its expected helper, and restart the app. Use your domain; the built-in `https://vodog.example.invalid` is deliberately unusable. `VODOG_BASE_URL` is an alternative process-environment setting. Gateway pairing has a separate server URL.

For the supported module only, use the app's guarded identity conversion from USB `2CA3:4006` to `2C7C:0125`; keep other AT/ADB tools closed. Packaging uses the bundled `apps/macos/Resources/ModuleVoice/` runtime by default; `VODOG_MODULE_VOICE_DIR` is an optional override. See [runtime provenance and limits](apps/macos/module/RUNTIME.md). Verify kernel 3.18.44 with compatible ABI, root ADB, UAC, payload integrity and runtime readiness before gateway acceptance; helper-backed control, ECM recovery and module credential transport also depend on the runtime. Initialization alone is insufficient. Preserve fail-closed checks and do not force a ready status. Payload packaging/checksum validation and physical acceptance must be recorded separately; neither is established by these instructions.

## 6. Pair, assign, and add optional services

Create a gateway in Web administration, generate a pairing code, enter it with the correct server in the gateway while disabled, then assign its discovered SIM to the intended account. Enable the gateway, confirm telephony/SMS/media readiness separately, and verify a harmless settings change reaches the applied version. The installer uses `relay-primary` and enables current telephony/archive contracts; it requires a matching five-gate Pixel build.

Optional configuration lives in the generated private files:

- **AI:** configure `voice.env` (`XAI_API_KEY` plus exactly one supported agent/model mode, or configured Doubao adapter). Start voice, verify health, then enable `AI_ENABLED` and `AI_WORKER_READY` in `control.env` and recreate Control.
- **Transcription:** set `TRANSCRIPTION_ENABLED`, `TRANSCRIPTION_ENABLED_AT`, `TRANSCRIPTION_API_KEY`, and appropriate model/endpoint settings. Report classification uses all three `REPORT_AI_BASE_URL`, `REPORT_AI_API_KEY`, `REPORT_AI_MODEL`. Control already runs these jobs; do not create duplicate workers.
- **iOS:** build scheme `VoDog`, set your Apple team and `VODOG_DOMAIN`; configure APNs key/team/topic/environment privately for background calls.
- **Android push:** supply your Firebase app config, `FCM_PROJECT_ID`, private credentials/mount and `FCM_ENABLED`. Configure badges only after delivery works.

```bash
sudo docker compose --project-directory /srv/vodog-state \
  -f /srv/vodog-state/compose.json --profile voice up -d voice
sudo docker compose --project-directory /srv/vodog-state \
  -f /srv/vodog-state/compose.json up -d control
```

Run these only after configuring the provider and appropriate Control flags. See [recording and AI](docs/recording-ai.md) for the full contracts.

## 7. Accept and hand off

Follow [operations](docs/operations.md): each client's inbound/outbound calls, two-way audio, DTMF, SMS, relay transports, background push, original archives, playback/export, AI, disconnection, and recovery. Separate source/build, service, UI, simulator and physical results. A heartbeat, HTTP 200, nonempty file or provider smoke test does not establish a successful cellular conversation.

Return the commands/results, actual installed components, skipped checks, remaining prerequisites and rollback location privately. Public validation scope is summarized in [release checks](docs/release-checks.md); the existence of a CI workflow is not a completed CI run. Never publish passwords, tokens, real recordings or unredacted device logs.

---

## 中文快速执行顺序

先确认公开仓库地址、应用/TURN 域名、主机接口/公网 IPv4、ACME 邮箱、管理员名及网关选择。目标为专用 Ubuntu 24.04 amd64，至少 4 GB 内存。真实电话/短信对象须先同意；生成密钥与设备输出私密保存。

1. **克隆：**把 `VODOG_REPOSITORY_URL` 换为用户给出的真实公开地址，执行上方 `git clone`，进入 `VoDog`。不要猜组织或使用无关仓库。
2. **网络：**A 记录指向目标，开放 TCP 80/443、UDP 3478、TCP 5349、UDP 49160–49200，保护管理入口及 5432/16880/16881。未配置 IPv6 不加 AAAA。
3. **配置：**运行上方 `infra/prepare.py`，域名/IP 全部替换；公网直绑时两项 IP 相同，NAT 需验证端口与 hairpin。它仅在仓库外新建 `/srv/vodog-state`，私下审核 `admin.env`、`control.env`、`voice.env` 和 Compose，不输出密钥。
4. **安装：**完成本地检查后执行 `sudo bash infra/install-host.sh /srv/vodog-state <自己的ACME邮箱>`。安装会接受 CA 条款、构建容器、迁移数据库、创建管理员并启动服务。示例域名会被拒绝；不要随意重复 seed，它会重置同名账号。详见[主机工具](infra/README.md)。
5. **服务检查：**执行上方 Compose `ps`、构建 Go probe、`infra/check-media.py` 和真实 TURN 域名的证书验证；完成 Web 新登录与内部路由隔离检查。probe 不拨电话，UDP echo 与真实 TLS 媒体仍需分别验证。
6. **Pixel：**按 [Pixel 设置](docs/pixel-setup.zh-CN.md)，运行 `scripts/build-android.sh`，用准确 `aapt` 与已验证 SELinux 域构建模块，审核 ZIP/manifest；空闲时在 Magisk 从本地安装并重启，检查特权与运行时权限、Google 默认拨号器、SELinux。固件从官方获得，不分发修改镜像；代码已修复可选 BCP 缺失时的获取/释放/恢复并有专项回归覆盖，全新无 BCP 真机安装仍未验收。
7. **Mac/DJI：**按上方 Swift 构建/测试/签名命令，用 `VODOG_CODESIGN_IDENTITY` 指定真实证书。通过 `VoDogBaseURL` 或进程环境 `VODOG_BASE_URL` 设服务器并重启，另设网关配对服务器。默认 `.invalid` 不可用。仅 QDC507/EG25-G 使用受保护 USB 身份转换；默认打包已随附的 `apps/macos/Resources/ModuleVoice/` 公开二进制，`VODOG_MODULE_VOICE_DIR` 仅为可选覆盖。按[运行时来源与限制](apps/macos/module/RUNTIME.md)核对内核 3.18.44、兼容 ABI、root ADB、UAC、载荷完整性和运行时就绪；初始化不足以验收，检查失败时保持阻断。精确对应内核源码、配置及补丁仍未取得，不能声称源码完整、可重复构建或再分发义务已解决；GPL-2.0 与 CellDock 非商业条款仍适用。打包/校验和验证与真机验收须单独记录，本说明不表示通过。见 [DJI 教程](docs/dji-setup.zh-CN.md)。
8. **配对：**Web 建网关和配对码，关闭状态输入服务器与配对码，分配发现的 SIM，启用后逐项查电话/短信/媒体和设置 applied ACK。
9. **可选能力：**`voice.env` 配供应商，启动 voice 并验健康，再在 `control.env` 开 AI 两门并重建 Control；转录和报告由 Control 运行，不另起重复 worker。iOS 用 `VoDog` scheme、自己的团队与 `VODOG_DOMAIN`，后台需 APNs；Android 后台需自备 Firebase/FCM。
10. **验收交付：**按[运维清单](docs/operations.zh-CN.md)分别记录各端、真实电话/短信、双向音频、录音、AI、后台、重连、恢复，明确跳过/受阻项和回滚位置。公开[检查摘要](docs/release-checks.md)不等于新部署完成，CI 文件存在不等于 CI 已运行。

第一方许可 AGPL-3.0 与 CellDock 自定义非商业条件并列适用，见[许可](docs/licensing.zh-CN.md)。Apple/FCM/AI 凭据可后配；没有它们时不声称相应后台或 AI 能力通过。
