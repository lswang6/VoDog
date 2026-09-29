# vowifi-go

本页是 [README.md](README.md) 的中文翻译版本。项目默认文档语言为英语；如中英文表述存在差异，请以英文文档为准。

vowifi-go 是 VoHive VoWiFi 运行时边界的第三方独立 Go 实现。

本仓库聚焦 VoHive 所需的公开运行时 API 与协议层，包括 SIM/ISIM AKA、SWu/ePDG 隧道、IMS 注册、消息、语音桥接以及用户态数据平面实验。

## 状态

vowifi-go 仍在积极开发中。本项目与任何设备厂商、运营商或官方闭源 VoWiFi 实现均无官方关联、授权、背书或合作关系，也不是其直接替代品。

本项目**尚未实现官方闭源版本的完整功能**。完整 SIP 事务定时器状态机、高级 IMS 功能互通、运营商特定行为、生产级加固以及真实网络兼容性仍在当前 API 之后逐步实现。

## 快速开始

运行测试：

```sh
go test ./...
```

运行与 GitHub Actions 相同的本地 CI 入口：

```sh
make ci
```

VoHive 集成时建议在消费者 `go.mod` 中使用 tag 或 pseudo-version：

```sh
go get github.com/boa-z/vowifi-go@latest
```

本地兼容验证请使用 `make compat-vohive`；该命令会复制临时 VoHive
检出，并只在临时目录内加入本地 replace，不会修改或要求提交本地路径依赖。

## 文档

- [功能列表](docs/FEATURES.md) - 当前实现清单与已知缺口。
- [VoHive 可用性差距](docs/VOHIVE_READINESS.md) - 在 VoHive 中视为可用前仍需完成的工作。
- [架构说明](docs/ARCHITECTURE.md) - 包布局、运行时边界与高层流程。
- [开发说明](docs/DEVELOPMENT.md) - CI 目标、本地验证和工作区使用方式。
- [英文免责声明](docs/DISCLAIMER.md)。
- [中文免责声明](docs/DISCLAIMER.zh-CN.md)。

## 免责声明摘要

vowifi-go 主要面向个人学习、技术研究与功能测试场景。使用者需要自行确保符合所在地法律法规、电信运营商服务条款、设备要求和网络策略。本软件按“现状”提供，不附带任何担保；因使用、误用、部署或无法使用本项目造成的损失，作者及贡献者不承担责任。

使用前请阅读完整的 [中文免责声明](docs/DISCLAIMER.zh-CN.md)。
