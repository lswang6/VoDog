# Third-party attribution inventory

[Documentation](README.md) · [简体中文](attribution.zh-CN.md) · [License boundaries](licensing.md)

VoDog retains third-party authorship separately from its product branding. Preserve the authoritative notices in each component, dependency package, or vendored directory; this summary does not replace them or assign new licenses.

| Project or technology | Relationship |
| --- | --- |
| CellDock | Upstream basis of the native macOS client/module integration; custom non-commercial terms and attribution remain applicable |
| LiveKit WebRTC / WebRTC | Native media framework dependency; retain upstream notices, including transitive notices |
| Pion | Go WebRTC media stack |
| Opus / libopus | Audio codec and native implementation |
| coturn | Independently deployed TURN relay |
| React, Vite, Fastify, TypeScript, Node.js, PostgreSQL | Application and backend stack |
| Kotlin, Jetpack Compose, AndroidX, Swift | Native client language/framework ecosystem |
| Magisk | Root/privileged-module infrastructure used by the Pixel integration |
| BCR | Optional independent Android recorder; distinct from VoDog's original archive |
| ffmpeg | Optional recording conversion/export tool |
| xAI, Doubao, Gemini and OpenAI-compatible APIs | External service integrations; credentials and provider terms are separate |

Read the root license, the macOS component's retained license, lockfiles/manifests, and vendored notices for exact scope. The module voice binaries are now included unchanged from public CellDock commit `6d0461de3a94292e7549a1d8e6e9180bd0b5ed0c`; see [runtime provenance](../apps/macos/module/RUNTIME.md). Kernel modules retain GPL-2.0 terms, and CellDock noncommercial terms remain applicable. Exact corresponding kernel source/configuration/patches have not been obtained; no complete or reproducible kernel source or resolved redistribution obligations are claimed. Bundling grants no new permission. No contributor identity is removed merely because an application name or endpoint is neutralized.

[Contributors and upstream acknowledgments / 贡献者与上游致谢](../CONTRIBUTORS.md)
