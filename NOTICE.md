# Licensing and attribution

Original VoDog code is licensed under **GNU AGPL-3.0-only**; see [LICENSE](LICENSE).
Copyright (c) 2026 VoDog contributors.

This is a mixed-license source distribution. The root license does **not** replace
licenses, copyright notices, or restrictions attached to third-party components.

- **macOS / CellDock-derived application:** see [its license](apps/macos/LICENSE).
  The upstream license permits copying, modification and redistribution for
  personal, noncommercial purposes, and requires written permission for commercial
  use. This component is source-available under that license, not unrestricted
  open-source software. VoDog does not grant an exception to those terms.
- **Pixel supporting components:** source snapshots and their individual notices
  are kept under [infra/pixel/external](infra/pixel/external/).
- **Android gateway:** retained Apache/GPL notices and the libopus license live
  under [apps/android/gateway](apps/android/gateway/).
- **macOS dependencies:** retain the licenses in `apps/macos/Sources`,
  `apps/macos/ThirdParty` and its third-party notice documents. Separate components
  can have different licenses, including copyleft requirements.
- Package managers fetch further dependencies identified by the committed lockfiles;
  their upstream licenses apply independently.

Names such as Pixel, Android, DJI, Apple, Magisk and CellDock identify compatibility
or upstream provenance. This project is not an official product of those vendors.

[Contributors and upstream acknowledgments / 贡献者与上游致谢](CONTRIBUTORS.md)
