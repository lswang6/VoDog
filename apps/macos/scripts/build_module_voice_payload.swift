#!/usr/bin/env swift

import CryptoKit
import Foundation

struct SourceManifest: Decodable {
    struct FileEntry: Decodable {
        let name: String
        let mode: UInt32
        let size: Int
        let sha256: String
    }

    struct KernelModule: Codable {
        let file: String
        let name: String
    }

    let formatVersion: Int
    let runtimeVersion: String
    let kernelRelease: String
    let cardName: String
    let helper: String
    let files: [FileEntry]
    let modules: [KernelModule]
    let requiredDevices: [String]
}

struct PayloadManifest: Encodable {
    struct FileEntry: Encodable {
        let name: String
        let mode: UInt32
        let size: Int
        let sha256: String
        let offset: Int
    }

    let formatVersion: Int
    let runtimeVersion: String
    let kernelRelease: String
    let cardName: String
    let helper: String
    let files: [FileEntry]
    let modules: [SourceManifest.KernelModule]
    let requiredDevices: [String]
}

enum BuilderError: LocalizedError {
    case usage
    case invalid(String)

    var errorDescription: String? {
        switch self {
        case .usage:
            return "usage: build_module_voice_payload.swift SOURCE_DIRECTORY OUTPUT_FILE"
        case let .invalid(message):
            return message
        }
    }
}

let magic = Data([
    0x4D, 0x41, 0x56, 0x4F, 0x56, 0x4F,
    0x49, 0x43, 0x45, 0x50, 0x4B, 0x47,
])

func sha256(_ data: Data) -> String {
    SHA256.hash(data: data)
        .map { String(format: "%02x", $0) }
        .joined()
}

func appendUInt32LE(_ value: UInt32, to data: inout Data) {
    for index in 0 ..< 4 {
        data.append(UInt8(truncatingIfNeeded: value >> UInt32(index * 8)))
    }
}

func appendUInt64LE(_ value: UInt64, to data: inout Data) {
    for index in 0 ..< 8 {
        data.append(UInt8(truncatingIfNeeded: value >> UInt64(index * 8)))
    }
}

func safeName(_ name: String) -> Bool {
    !name.isEmpty && name.allSatisfy {
        $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-")
    }
}

func safeModuleName(_ name: String) -> Bool {
    !name.isEmpty && name.allSatisfy {
        $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_")
    }
}

func isSHA256(_ value: String) -> Bool {
    value.count == 64 && value.allSatisfy {
        $0.isASCII && ($0.isNumber || ("a" ... "f").contains($0))
    }
}

func build() throws {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard arguments.count == 2 else { throw BuilderError.usage }

    let sourceDirectory = URL(fileURLWithPath: arguments[0], isDirectory: true)
        .standardizedFileURL
    let outputURL = URL(fileURLWithPath: arguments[1]).standardizedFileURL
    let manifestData = try Data(
        contentsOf: sourceDirectory.appendingPathComponent("manifest.json")
    )
    let source = try JSONDecoder().decode(SourceManifest.self, from: manifestData)
    let names = source.files.map(\.name)
    let nameSet = Set(names)
    let moduleNames = source.modules.map(\.name)
    let moduleFiles = source.modules.map(\.file)

    guard source.formatVersion == 1,
          !source.runtimeVersion.isEmpty,
          safeName(source.kernelRelease),
          safeName(source.cardName),
          safeName(source.helper),
          !source.files.isEmpty,
          source.files.count <= 32,
          nameSet.count == names.count,
          nameSet.contains(source.helper),
          source.files.allSatisfy({
              safeName($0.name) &&
                  $0.mode >= 0o400 &&
                  $0.mode <= 0o777 &&
                  $0.size > 0 &&
                  $0.size <= 64 * 1_024 * 1_024 &&
                  isSHA256($0.sha256)
          }),
          Set(moduleNames).count == moduleNames.count,
          Set(moduleFiles).count == moduleFiles.count,
          source.modules.allSatisfy({
              safeName($0.file) &&
                  safeModuleName($0.name) &&
                  nameSet.contains($0.file)
          }),
          source.requiredDevices.allSatisfy({
              $0.hasPrefix("/dev/snd/") && !$0.contains("'")
          }) else {
        throw BuilderError.invalid("ModuleVoice source manifest is invalid.")
    }

    var content = Data()
    var outputEntries: [PayloadManifest.FileEntry] = []
    for entry in source.files {
        let fileURL = sourceDirectory.appendingPathComponent(entry.name)
        guard fileURL.deletingLastPathComponent().standardizedFileURL == sourceDirectory,
              FileManager.default.isReadableFile(atPath: fileURL.path) else {
            throw BuilderError.invalid("Missing ModuleVoice component: \(entry.name)")
        }
        let component = try Data(contentsOf: fileURL, options: .mappedIfSafe)
        guard component.count == entry.size else {
            throw BuilderError.invalid("Size mismatch for ModuleVoice component: \(entry.name)")
        }
        guard sha256(component) == entry.sha256 else {
            throw BuilderError.invalid("SHA-256 mismatch for ModuleVoice component: \(entry.name)")
        }
        outputEntries.append(
            PayloadManifest.FileEntry(
                name: entry.name,
                mode: entry.mode,
                size: entry.size,
                sha256: entry.sha256,
                offset: content.count
            )
        )
        content.append(component)
    }

    let payloadManifest = PayloadManifest(
        formatVersion: source.formatVersion,
        runtimeVersion: source.runtimeVersion,
        kernelRelease: source.kernelRelease,
        cardName: source.cardName,
        helper: source.helper,
        files: outputEntries,
        modules: source.modules,
        requiredDevices: source.requiredDevices
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let encodedManifest = try encoder.encode(payloadManifest)

    var output = Data()
    output.append(magic)
    appendUInt32LE(1, to: &output)
    appendUInt64LE(UInt64(encodedManifest.count), to: &output)
    output.append(encodedManifest)
    output.append(content)

    try FileManager.default.createDirectory(
        at: outputURL.deletingLastPathComponent(),
        withIntermediateDirectories: true
    )
    try output.write(to: outputURL, options: .atomic)
    print(outputURL.path)
}

do {
    try build()
} catch {
    fputs("ModuleVoice payload build failed: \(error.localizedDescription)\n", stderr)
    exit(1)
}
