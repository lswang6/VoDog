# Third-party notices

The macOS application and its user-space PCM bridge were written independently.
The following projects were consulted for protocol behavior and test strategy;
their source code is not copied into those components:

- asterisk-chan-quectel, GPL-2.0 (protocol behavior only; no source vendored):
  <https://github.com/IchthysMaranatha/asterisk-chan-quectel>
- Quectel EC2x/EG9x Voice over USB and UAC application note:
  <https://auroraevernet.ru/upload/iblock/f57/xkjhy4olve0k1n8e0z43hq4nk5h604d2.pdf>
- warthog618/sms, MIT:
  <https://github.com/warthog618/sms>
- WWANManager, MIT:
  <https://github.com/patriczeq/WWANManager>
- Blue Robotics Cellphone Modem Manager, MIT:
  <https://github.com/bluerobotics/cellphone-modem-manager>

The eSIM implementation links the `euicc/` library from lpac v2.3.0,
commit `c2fcf5e`, under LGPL-2.1-only. CellDock provides its own modem AT/APDU
and HTTPS adapters and does not compile lpac's AGPL command-line application,
drivers, or utilities:

- lpac/libeuicc, LGPL-2.1-only OR commercial:
  <https://github.com/estkme-group/lpac/tree/v2.3.0/euicc>
- cJSON as bundled by lpac, MIT:
  <https://github.com/estkme-group/lpac/tree/v2.3.0/cjson>

Their complete corresponding source and license texts are present under
`Sources/CEuiccCore/Vendor/lpac`. Distributors of statically linked builds must
also satisfy LGPL-2.1 section 6 relinking requirements, or obtain lpac's
commercial license.

The optional, separately supplied QDC507 voice runtime uses two loadable Linux kernel modules
derived from `the-modem-distro/quectel_eg25_kernel`, commit
`82ed00908b3e8efc3ff0de27d2b5a7c0524ecd7f`, under GPL-2.0:

- <https://github.com/the-modem-distro/quectel_eg25_kernel>

The archive builder includes the GPL-2.0 license under Legal beside `VoDog.app`. The runtime
binaries are stored in the code-signed `Resources/ModuleVoice.payload` package.
This notice is included beside the app; the private historical module build report is not exported.

The VoDog gateway media leg links LiveKit's prebuilt WebRTC framework
(`LiveKitWebRTC` 150.7871.01, the same build the VoDog iOS app uses),
under the WebRTC project's BSD-3-Clause license shipped as the xcframework's
`LICENSE`:

- <https://github.com/livekit/webrtc-xcframework>

The gateway vendors libopus 1.6.1 under `Sources/COpus/opus` (BSD-style license).
Preserve its `COPYING` and `AUTHORS`, including patent-license references. Deep PLC
code and built-in weights are compiled; the app also uses system AVAudioConverter.

The bundled separate VoWiFi executable is built from
https://github.com/boa-z/vowifi-go under AGPL-3.0; its source, modifications,
`LICENSE`, `go.mod`, `go.sum` and dependency vendor notices are retained in
`ThirdParty/vowifi-go`. Preserve corresponding-source and applicable network-use
source-offer obligations; this is not covered by the CellDock noncommercial license.

The exported lpac subset contains only euicc and cjson plus upstream license
metadata. `REUSE.toml` assigns src/driver/utils to AGPL-3.0-only; those unused
CLI/driver/utility trees are not exported or compiled. The euicc library is
LGPL-2.1-only OR LicenseRef-ESTKME-Commercial. The commercial reference is a
contact notice, not a grant; no commercial authorization is claimed. cJSON is MIT.
The LGPL static-link relinking requirement above still applies.

The original CellDock root LICENSE is preserved unchanged. VoDog original additions
use AGPL-3.0-only; inherited code and vendor code retain their original terms.
Upstream CellDock: https://github.com/celldock/celldock-for-mac .

Distribution limitation: QDC507 runtime binaries are excluded from this public export.
The exact module source/build patches were unavailable; see module/RUNTIME.md.
Optional runtime packaging requires a separately supplied compliant build. The PCM
helper's source and build script are present, but its prebuilt binary is also excluded.
