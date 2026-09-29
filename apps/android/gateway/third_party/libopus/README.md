# libopus build dependency

- Upstream: Xiph.Org libopus
- Fixed version: 1.6.1 (2026-01-14)
- Official source: https://downloads.xiph.org/releases/opus/opus-1.6.1.tar.gz
- SHA-256: `6ffcb593207be92584df15b32466ed64bbec99109f007c82205f0194572411a1`
- License: three-clause BSD-style license plus the royalty-free patent grants listed in `COPYING`

`src/main/cpp/CMakeLists.txt` fetches this exact archive and requires the SHA-256 before extraction.
The Android native build is absent unless Gradle is invoked with
`-PvodogLibopusFec=true`; the property defaults to `false` and accepts no other values.
Only `arm64-v8a` is built for the attended Pixel candidate.

CMake stores fetched sources and generated native objects in its local build directory.
DRED and OSCE are disabled; deep PLC is enabled and selected by decoder complexity.
