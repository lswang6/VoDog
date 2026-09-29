# 第三方署名清单

[文档目录](README.zh-CN.md) · [English](attribution.md) · [许可边界](licensing.zh-CN.md)

VoDog 将第三方作者署名与产品品牌分开保留。组件、依赖包和 vendor 目录中的权威声明必须保留；本文不替代原文，也不赋予新许可。

| 项目或技术 | 关系 |
| --- | --- |
| CellDock | 原生 macOS 客户端/模组集成的上游；自定义非商业条件与署名继续适用 |
| LiveKit WebRTC / WebRTC | 原生媒体框架，需保留上游及传递依赖声明 |
| Pion | Go WebRTC 媒体栈 |
| Opus / libopus | 音频编解码及原生实现 |
| coturn | 独立部署的 TURN 中继 |
| React、Vite、Fastify、TypeScript、Node.js、PostgreSQL | 前后端技术栈 |
| Kotlin、Jetpack Compose、AndroidX、Swift | 原生客户端语言与框架生态 |
| Magisk | Pixel 集成所用 root/特权模块基础设施 |
| BCR | 可选独立 Android 录音器，与 VoDog 原始归档不同 |
| ffmpeg | 可选录音转换与导出工具 |
| xAI、豆包、Gemini 与 OpenAI 兼容 API | 外部服务集成，凭据与供应商条款独立 |

准确范围以根许可、macOS 保留许可、锁文件/manifest 和 vendor 声明为准。现已原样包含 CellDock 公开提交 `6d0461de3a94292e7549a1d8e6e9180bd0b5ed0c` 的模组语音二进制，见[运行时来源](../apps/macos/module/RUNTIME.md)。内核模块保留 GPL-2.0 条款，CellDock 非商业条件仍适用。尚未取得精确对应的内核源码、配置和补丁，不声称内核源码完整或可重复构建，也不声称再分发义务已解决。随附不构成新增许可授权。应用改名或端点脱敏不是删除贡献者身份的理由。

[Contributors and upstream acknowledgments / 贡献者与上游致谢](../CONTRIBUTORS.md)
