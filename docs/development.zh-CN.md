# 开发与测试

[文档目录](README.zh-CN.md) · [English](development.md)

以下命令从 VoDog 根目录执行，仅构建或测试源码，不安装网关、不部署服务器、不发布制品，也不证明真实蜂窝可用。具体 Go、Gradle、Android SDK、Swift/Xcode 版本以锁文件和 manifest 为准。

## Web 与服务

```bash
(cd apps/web && npm ci && npm test && npm run build)
(cd services/control && npm ci && npm run build)
(cd services/media && go test -race ./...)
(cd services/recording-archive-validator && go test ./...)
(cd services/voice && npm ci && npm test)
```

Control 测试需要三个**相互独立、可销毁**的 PostgreSQL 数据库，库名均含 `test`。在隔离实例自行创建，测试可能重建 public schema，绝不能替换为生产地址。

```bash
(cd services/control &&   TEST_DATABASE_URL=postgresql://localhost/vodog_control_test   REPLAY_TEST_DATABASE_URL=postgresql://localhost/vodog_replay_test   REPLAY_MIGRATION_TEST_DATABASE_URL=postgresql://localhost/vodog_replay_migration_test   npm test)
```

变量缺失可能导致部分测试跳过或失败，报告中必须注明。Voice 原生 WebRTC 依赖还需在目标系统/架构实际加载；仅 JS 测试通过不能证明这一点。

## Android

```bash
(cd apps/android && ./gradlew   :client:testDebugUnitTest :client:assembleDebug   :gateway:testDebugUnitTest :gateway:assembleDebug   --no-daemon --max-workers=1)
```

默认网关构建会保留真实电话功能门。经过审核的受控验收候选使用：

```bash
(cd apps/android && ./gradlew :gateway:testDebugUnitTest :gateway:assembleDebug   -PvodogCellularAcceptance=true   -PvodogRecordingArchive=true   -PvodogLibopusFec=true   -PvodogReceiveRecovery=true   -PvodogCommandReplayHorizon=true   --no-daemon --max-workers=1)
```

命令不代表获得安装或拨号授权。核对 APK 实际功能门、application ID、证书和服务端兼容性。真实使用时通过 `vodogApiBaseUrl` 配置自己的 HTTPS `/api/v1` 地址；示例端点不能提供服务。正式签名与 Firebase 配置属于私密部署输入，debug APK 不等于发行包。

## iOS

导出项目使用 XcodeGen，名称 `VoDog`，源码最低目标为 iOS 17。选择本机已安装的模拟器；下列 `IOS_SIMULATOR` 是 shell 变量，不是应用设置。

```bash
export IOS_SIMULATOR='iPhone simulator name from Xcode'
(cd apps/ios && xcodegen generate && xcodebuild   -project VoDog.xcodeproj -scheme VoDog   -destination "platform=iOS Simulator,name=$IOS_SIMULATOR"   -derivedDataPath ../../build/ios-derived   test -only-testing:VoDogTests)
```

真机签名使用自己的团队，关联域通过 `VODOG_DOMAIN` 设置自己的域名。执行测试时保留 Xcode 正常模拟器签名；上述命令刻意不设置 `CODE_SIGNING_ALLOWED=NO`。未签名构建仅用于编译检查，不算模拟器测试执行通过。不要全局关闭 App 签名来绕过 Keychain 错误：构建成功仍可能无法保存会话。模拟器不覆盖 APNs、真机 CallKit/音频、后台来电或分发签名。

## macOS

构建或分发 CellDock 衍生集成前先读[许可](licensing.zh-CN.md)。Swift package、系统框架、原生 helper/runtime、WebRTC/Opus 依赖均属于构建的一部分，并非 Electron 封装。

```bash
(cd apps/macos && swift build)
(cd apps/macos && scripts/run_tests.sh)
(cd apps/macos && scripts/run_gateway_control_tests.sh)
(cd apps/macos && scripts/run_gateway_media_tests.sh)
```

先审核脚本前提；网关媒体测试可能需要 Go 与共享归档校验器。这些是源码检查，不是现场模组探针。App 打包、helper 签名、entitlement、安装、公证与实际 USB 占用分别验收，不要顺手运行同目录的真实通话探针。

## 修改与验证

只改自己负责的组件，保留并行贡献者改动。修改协议或身份字段前追踪共享调用方，以最小相关可运行检查覆盖受影响合同。保留幂等、版本冲突、鉴权、防重账本和删除证明。

修改公开身份时同步核对包名、entitlement、签名关联、推送 topic、服务名、默认值、测试和文档；不要重写第三方署名。真实凭据、设备身份、日志、媒体、构建产物和部署证据不进入源码发行。
