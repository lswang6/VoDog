// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "VoDog",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "VoDog", targets: ["VoDog"]),
        .executable(name: "VoDogNetworkHelper", targets: ["VoDogNetworkHelper"]),
        .executable(name: "VoDogDialProbe", targets: ["VoDogDialProbe"]),
        .executable(name: "VoDogSMSDeleteProbe", targets: ["VoDogSMSDeleteProbe"])
    ],
    dependencies: [
        // Same WebRTC build as the VoDog iOS app (apps/ios/project.yml); has a macOS slice.
        .package(url: "https://github.com/livekit/webrtc-xcframework", exact: "150.7871.01")
    ],
    targets: [
        .target(
            name: "CModemBridge",
            dependencies: [],
            publicHeadersPath: "include",
            linkerSettings: [
                .linkedFramework("CoreFoundation"),
                .linkedFramework("IOKit")
            ]
        ),
        .target(
            name: "CUACProbe",
            dependencies: [],
            publicHeadersPath: "include",
            linkerSettings: [
                .linkedFramework("CoreAudio"),
                .linkedFramework("CoreFoundation"),
                .linkedFramework("IOKit")
            ]
        ),
        .target(
            name: "CEuiccCore",
            dependencies: [],
            path: "Sources/CEuiccCore",
            sources: [
                "VoDogEUICCBridge.c",
                "Vendor/lpac/cjson/cJSON.c",
                "Vendor/lpac/cjson/cJSON_ex.c",
                "Vendor/lpac/euicc/base64.c",
                "Vendor/lpac/euicc/derutil.c",
                "Vendor/lpac/euicc/es8p.c",
                "Vendor/lpac/euicc/es9p.c",
                "Vendor/lpac/euicc/es9p_errors.c",
                "Vendor/lpac/euicc/es10a.c",
                "Vendor/lpac/euicc/es10b.c",
                "Vendor/lpac/euicc/es10c.c",
                "Vendor/lpac/euicc/es10c_ex.c",
                "Vendor/lpac/euicc/euicc.c",
                "Vendor/lpac/euicc/hexutil.c",
                "Vendor/lpac/euicc/interface.c",
                "Vendor/lpac/euicc/sha256.c",
                "Vendor/lpac/euicc/tostr.c"
            ],
            publicHeadersPath: "include",
            cSettings: [
                .headerSearchPath("Vendor/lpac")
            ]
        ),
        // S70: libopus 1.6.1 from opus-1.6.1.tar.gz (SHA256 6ffcb593…a1, the Pixel gateway's tarball),
        // vendored as plain C: celt/, silk/ + silk/float/, src/ lib sources per the upstream *_sources.mk
        // (no arm/x86 intrinsics). Float build, VAR_ARRAYS. Deep PLC ON like the Pixel gateway (S70f):
        // ENABLE_DEEP_PLC + dnn/ = exactly upstream DEEP_PLC_SOURCES/HEAD (lpcnet_*.mk, no DRED/OSCE)
        // with the built-in weights; runs at decoder complexity >= 5 (celldock_opus.c).
        // Keep the flags in sync with scripts/run_gateway_media_tests.sh.
        .target(
            name: "COpus",
            dependencies: [],
            path: "Sources/COpus",
            exclude: ["opus/COPYING", "opus/AUTHORS"],
            publicHeadersPath: "include",
            cSettings: [
                .define("OPUS_BUILD"),
                .define("VAR_ARRAYS"),
                .define("HAVE_LRINTF"),
                .define("HAVE_LRINT"),
                .define("ENABLE_DEEP_PLC"),
                .headerSearchPath("opus/celt"),
                .headerSearchPath("opus/silk"),
                .headerSearchPath("opus/silk/float"),
                .headerSearchPath("opus/src"),
                .headerSearchPath("opus/dnn")
            ]
        ),
        .target(
            name: "VoDogNetworkIPC",
            dependencies: [],
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ]
        ),
        .executableTarget(
            name: "VoDog",
            dependencies: [
                "CModemBridge",
                "CUACProbe",
                "CEuiccCore",
                "COpus",
                "VoDogNetworkIPC",
                .product(name: "LiveKitWebRTC", package: "webrtc-xcframework")
            ],
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ],
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("Contacts"),
                .linkedFramework("Vision"),
                .linkedFramework("SystemConfiguration"),
                .linkedFramework("Security"),
                .linkedFramework("UserNotifications"),
                .linkedLibrary("z"),
                .unsafeFlags([
                    "-Xlinker", "-rpath",
                    "-Xlinker", "@executable_path/../Frameworks"
                ])
            ]
        ),
        .executableTarget(
            name: "VoDogNetworkHelper",
            dependencies: ["VoDogNetworkIPC"],
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ],
            linkerSettings: [
                .linkedFramework("IOKit"),
                .linkedFramework("Security"),
                .linkedFramework("SystemConfiguration")
            ]
        ),
        .executableTarget(
            name: "VoDogDialProbe",
            dependencies: ["CModemBridge", "CUACProbe"],
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ]
        ),
        .executableTarget(
            name: "VoDogSMSDeleteProbe",
            dependencies: ["CModemBridge"],
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ]
        )
    ]
)
