# 安装与配置

[文档目录](README.zh-CN.md) · [English](installation.md) · [AI 执行手册](../readme-for-ai.md)

推荐在专用 **Ubuntu 24.04 amd64** 主机使用[安装工具](../infra/README.md)，生成私密配置并构建部署服务。发行准备已运行本地配置/schema/语法检查；容器构建、全新主机安装、证书签发、TURN 和真机仍未验证。部署后完成[验收](operations.zh-CN.md)。

## 1. 准备并执行主机安装

准备至少 4 GB 内存、足够录音存储、TCP 80/443 空闲且可下载依赖的专用主机。将应用和 TURN 域名 A 记录指向主机，在主机/云防火墙开放 TCP 80/443、UDP 3478、TCP 5349、UDP 49160–49200；不公开 5432、16880、16881。安装器不改防火墙，未配置 IPv6 时不要加 AAAA。

在目标主机的公开仓库中执行，先替换所有示例：

```bash
python3 infra/prepare.py \
  --domain vodog.example.com --turn-domain turn.example.com \
  --public-ip 203.0.113.10 --listen-ip 192.0.2.10 \
  --output /srv/vodog-state
sudo bash infra/install-host.sh /srv/vodog-state admin@example.com
```

公网 IP 直接绑定时，两项 IP 均填实际地址；NAT 下 listen 填接口地址，public 填映射地址，并验证中继端口及 hairpin。以上 IP 是文档保留地址。安装器拒绝示例域名，必须替换为自有域名；末尾邮箱是 ACME 联系地址，执行安装表示接受 CA 条款。

`prepare.py` 仅在仓库之外新建私密状态目录，生成独立密钥与管理员密码。私下审核生成配置，不能提交。`install-host.sh` 安装主机依赖、构建容器、初始化库、签发证书、启动服务，按私有 `admin.env` 建账号，并配置续期/保留任务。私下读取密码；首次安装拒绝既有数据库卷，升级按组件指南进行。

生成布局通过应用域提供 Web/API 与签名媒体探针；独立媒体域仅用于自定义多节点。默认节点 `relay-primary`。AI、转录和推送默认关闭；Control 已启动相应任务，不要另起重复转录/报告 worker。安装配置针对匹配五门网关启用电话能力。

## 2. 理解生成布局

需要 Linux VPS 或等价主机、PostgreSQL、支持原生依赖的 Node.js、用于构建媒体与归档工具的 Go、HTTPS 反向代理、coturn、持久录音存储和受支持网关。具体工具版本以仓库 manifest 为准。Apple 构建需要 Mac/Xcode，Android 构建需要 SDK 与仓库 Gradle wrapper；MP3 导出还需要具有相应编码器的 ffmpeg。

从自己的域名和单机布局开始：

| 服务 | 示例 | 暴露范围 |
| --- | --- | --- |
| Web 与公开 API | `https://vodog.example.com` | 公网 HTTPS；`/api/v1` 代理到 Control |
| 媒体端点 | `https://media.example.com` | 仅预期的鉴权信令/探测路由 |
| TURN | `turn.example.com` | 配置的 UDP/TCP/TLS 监听端口与中继分配端口段 |
| 媒体节点 ID | `relay-primary` | Control 与媒体配置必须一致 |
| 数据库与内部 API | 主机本地或私有服务网络 | 不公开 |

示例不是可用服务。为自己的域名配置真实 DNS 与可信证书。普通 HTTP 反代不能代替 TURN UDP/TLS。主机与云防火墙均需开放 coturn 监听端口及中继端口段，独立验证公布的中继地址、NAT、证书链/SNI 和 UDP/TLS。不能关闭 TLS 校验来掩盖错误。

## 3. 审核 Control 配置

以 `services/control/src/config.ts` 为准，用 Git 外的受限环境文件或服务管理器注入。不要假定任意 `.env` 都会被自动加载。

| 配置 | 用途 |
| --- | --- |
| `DATABASE_URL` | 专用数据库与受限数据库用户 |
| `PUBLIC_ORIGIN` | 自己的 HTTPS origin，例如 `https://vodog.example.com` |
| `RP_ID` | 自己的 WebAuthn 域名，例如 `vodog.example.com` |
| `COOKIE_SECRET` | 新生成的高熵密钥，至少满足 schema 长度要求 |
| `PORT` | Control 监听端口，经反代对外，禁止直接公开访问 |
| `MEDIA_SECRET`、`TURN_SECRET` | 分别生成，仅向相关服务共享 |
| `MEDIA_NODES_JSON`、`MEDIA_DEFAULT_NODE_ID` | 真实节点注册表与默认节点，例如 `relay-primary`；字段按解析器要求 |
| `RECORDING_ROOT` | 服务专属媒体录音存储 |
| `PIXEL_ARCHIVE_ROOT`、`PIXEL_ARCHIVE_VALIDATOR_PATH` | 原始归档与校验器；schema 要求解析后的绝对路径 |
| `RECORDING_MP3_CACHE_DIR` | 私有导出缓存，需要 ffmpeg |

自行选择安装和数据根目录，在部署时解析并通过配置传入；不要沿用其他人的目录。存储根与服务权限应保持隔离。`PIXEL_*` 归档配置名也用于模组集成，不意味着功能只限 Pixel。

安装器已执行迁移和管理员初始化，不要例行重复 seed：它会覆盖同名账号密码/角色。自定义部署时先审核 `npm run migrate` 与 `npm run seed`；后者读取私密 `TEST_USERNAME`、`TEST_PASSWORD`、`TEST_USER_ROLE=admin`。不存在公共默认密码。

## 4. 检查服务，再接客户端

构建并配置媒体服务、归档校验器、coturn 与反代。相关组件中的节点 ID、媒体密钥、TURN 密钥、端点与存储合同必须一致。公网禁止访问内部 worker 路由；异机 worker 需经过审核的鉴权私有传输。HTTPS 网站可打开不等于媒体系统健康。

启动 Control 及配置的后台任务，再提供 Web 构建产物。先完成正常登录与账号隔离检查，再连接硬件。启用 Turnstile 时须同时配置 site/secret key，并完成真实挑战；不能为了自动化降低认证要求。

执行前审查每个 `infra` 脚本。名称包含 deploy、configure 或 probe 的脚本可能写配置、安装软件或发起真实通信。脚本存在不等于已获执行授权，也不意味着默认值适用于你的主机。

## 5. 可选集成

| 集成 | 需自备 | 缺省限制 |
| --- | --- | --- |
| iOS 后台来电 | Apple 签名/团队、entitlement、`APNS_KEY_ID`、`APNS_TEAM_ID`、私有 `APNS_KEY_PATH`、匹配的 topic 与环境 | 不能宣称后台来电可用 |
| Android 推送 | Firebase 项目与应用配置、`FCM_PROJECT_ID`、私有 `FCM_CREDENTIALS_PATH`，然后启用 `FCM_ENABLED` | 仅前台测试，不保证 FCM |
| 通行密钥 | 正确 RP ID/origin、Apple 关联域、已装 Android 签名证书 origin | 先用密码登录，不能在占位域上注册 |
| Turnstile | 自己的 site/secret key、允许域名与开关 | 不集成挑战 |
| AI 代接 | 供应商凭据、私有 worker token、健康 worker 与功能门 | 仅人工模式 |
| 转录/报告 | 受支持供应商凭据、模型、worker 与存储配置 | 有录音不保证有转录/报告 |

Apple/FCM 凭据可在源码构建时省略，但后台送达验收不能省略。使用自己的签名资料；`org.vodog` 及后缀只是源码身份默认值，不代表可转移的商店注册或权限授权。

## 6. 设置并配对一个网关

按具体 [Pixel 设置](pixel-setup.zh-CN.md)或 [DJI/macOS 设置](dji-setup.zh-CN.md)，结合[硬件指南](hardware.zh-CN.md)构建候选、审核权限与功能门，仅在已授权维护窗口安装。Pixel 需要兼容特权模块和真实权限；Mac 需要受支持的 USB/音频运行时和应用权限。

在 Web 管理端新建网关并生成短期配对码，在网关设置填入自己的服务器与配对码。将发现的 SIM 分配给预期账号，分别检查电话、短信、媒体、归属与同步就绪。不要手工伪造 SIM 身份或导入他人设备令牌。

按合同顺序启用相互兼容的服务端与网关功能。原始应用默认关闭若干门，主机安装器则明确开启匹配电话/归档能力；不能因此把其他门全部设为 true。启用相关服务端行为前，DTMF/防重能力必须匹配。确认网关已 ACK 目标设置，而不只是 Control 保存成功。

## 7. 验收运行

先验证 Web 前台，再分别验证原生客户端、已配置的后台推送、两种中继传输、真实呼入/呼出、短信、录音和 AI。继续阅读[运维](operations.zh-CN.md)、[录音与 AI](recording-ai.zh-CN.md)、[隐私](security.zh-CN.md)。凭据与部署结果不要写入公开文档；失败项保留可复现症状和明确待办，不含私密身份。
