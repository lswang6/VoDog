# Licenses and attribution

[Documentation](README.md) · [简体中文](licensing.zh-CN.md) · [Attribution inventory](attribution.md)

## Mixed-license distribution

First-party VoDog code is licensed under **AGPL-3.0-only**, as specified by the root license and applicable file notices. This statement does not relicense dependencies, vendored material, or upstream-derived code. Do not infer an “or later” option or a license exception unless the actual license notice grants it.

The macOS integration derives from **CellDock**, whose root license is a **custom non-commercial license**. It permits copying, modification, and distribution with attribution, and excludes business use. Preserve the upstream license text, copyright notices, authorship, and required attribution. VoDog branding on the interface does not change those terms.

This repository must therefore not be described as wholly OSI open source, wholly AGPL, or freely usable commercially. Even if first-party files permit a use under AGPL, that does not grant the same use for the CellDock-derived component. Consult each component's actual license before use or redistribution.

## Distribution boundaries

Retained upstream notices govern modified CellDock-derived files and bundled dependencies alongside the first-party license. QDC507 kernel binaries and the compiled module PCM payload are excluded; see the [runtime exclusions](../apps/macos/module/RUNTIME.md) for why and what voice functionality is unavailable. A directory boundary or build success does not grant additional redistribution rights.

Before distributing an artifact:

1. Identify its actual source/dependency contents and versioned license texts.
2. Preserve upstream notices and supply required attribution/source materials.
3. Check first-party AGPL obligations and the distinct non-commercial terms of the macOS component.
4. Review binary libraries, generated assets, fonts/icons, firmware payloads, and any omitted source/build prerequisites.
5. Check the actual contents of each artifact against the retained license terms; do not replace a missing license with a guessed one.

The [attribution inventory](attribution.md) is a navigation aid, not a substitute for the license files. Third-party names describe integrations; they do not imply endorsement by their owners.

Authoritative texts: [root LICENSE](../LICENSE), [root NOTICE](../NOTICE.md), [CellDock-derived component license](../apps/macos/LICENSE).
