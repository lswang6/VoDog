import Darwin
import Foundation

struct NetworkInterfaceByteCounters: Equatable {
    let received: UInt32
    let sent: UInt32
    let uptime: TimeInterval
}

struct NetworkThroughput: Equatable {
    var downloadBytesPerSecond: Double
    var uploadBytesPerSecond: Double

    static let zero = NetworkThroughput(
        downloadBytesPerSecond: 0,
        uploadBytesPerSecond: 0
    )
}

enum NetworkThroughputCalculator {
    static func rates(
        previous: NetworkInterfaceByteCounters,
        current: NetworkInterfaceByteCounters
    ) -> NetworkThroughput? {
        let elapsed = current.uptime - previous.uptime
        guard elapsed > 0,
              let receivedDelta = counterDelta(
                  previous: previous.received,
                  current: current.received
              ),
              let sentDelta = counterDelta(
                  previous: previous.sent,
                  current: current.sent
              ) else { return nil }
        return NetworkThroughput(
            downloadBytesPerSecond: Double(receivedDelta) / elapsed,
            uploadBytesPerSecond: Double(sentDelta) / elapsed
        )
    }

    private static func counterDelta(previous: UInt32, current: UInt32) -> UInt64? {
        if current >= previous {
            return UInt64(current - previous)
        }
        // getifaddrs exposes 32-bit counters on macOS. A genuine rollover can
        // only cross from the high end into the low end between adjacent
        // samples. Smaller backwards jumps mean that the ECM interface was
        // reset or re-enumerated; treating those as rollover produced a false
        // ~4 GB/s spike in the menu bar.
        let rolloverHighMark = UInt32.max / 4 * 3
        let rolloverLowMark = UInt32.max / 4
        guard previous >= rolloverHighMark, current <= rolloverLowMark else {
            return nil
        }
        return UInt64(UInt32.max - previous) + UInt64(current) + 1
    }
}

enum NetworkSpeedFormatter {
    static func menuBarText(_ throughput: NetworkThroughput) -> String {
        let lines = menuBarLines(throughput)
        return lines.download + "\n" + lines.upload
    }

    static func menuBarLines(
        _ throughput: NetworkThroughput
    ) -> (download: String, upload: String) {
        (
            "↓ " + compact(throughput.downloadBytesPerSecond) + "/s",
            "↑ " + compact(throughput.uploadBytesPerSecond) + "/s"
        )
    }

    static func detailedText(_ throughput: NetworkThroughput) -> String {
        L10n.tr(
            "下载 %@ · 上传 %@",
            detailed(throughput.downloadBytesPerSecond),
            detailed(throughput.uploadBytesPerSecond)
        )
    }

    private static func compact(_ bytesPerSecond: Double) -> String {
        scaled(bytesPerSecond, compact: true)
    }

    private static func detailed(_ bytesPerSecond: Double) -> String {
        scaled(bytesPerSecond, compact: false)
    }

    private static func scaled(_ rawValue: Double, compact: Bool) -> String {
        let value = max(0, rawValue)
        let divisor: Double
        let compactUnit: String
        let detailedUnit: String

        switch value {
        case 1_000_000_000...:
            divisor = 1_000_000_000
            compactUnit = "G"
            detailedUnit = "GB/s"
        case 1_000_000...:
            divisor = 1_000_000
            compactUnit = "M"
            detailedUnit = "MB/s"
        case 1_000...:
            divisor = 1_000
            compactUnit = "K"
            detailedUnit = "KB/s"
        default:
            divisor = 1
            compactUnit = "B"
            detailedUnit = "B/s"
        }

        let scaledValue = value / divisor
        let decimals = scaledValue < 10 && divisor > 1 ? 1 : 0
        let number = formattedNumber(scaledValue, decimals: decimals)
        return compact ? number + compactUnit : number + " " + detailedUnit
    }

    private static func formattedNumber(_ value: Double, decimals: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = AppLanguage.storedPreference.locale
        formatter.numberStyle = .decimal
        formatter.minimumFractionDigits = 0
        formatter.maximumFractionDigits = decimals
        formatter.usesGroupingSeparator = false
        return formatter.string(from: NSNumber(value: value)) ?? "0"
    }
}

enum NetworkInterfaceCounterReader {
    static func read(interfaceName: String) -> NetworkInterfaceByteCounters? {
        var firstAddress: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&firstAddress) == 0, let firstAddress else { return nil }
        defer { freeifaddrs(firstAddress) }

        var cursor: UnsafeMutablePointer<ifaddrs>? = firstAddress
        while let address = cursor {
            let interface = address.pointee
            if String(cString: interface.ifa_name) == interfaceName,
               interface.ifa_addr?.pointee.sa_family == UInt8(AF_LINK),
               let rawData = interface.ifa_data {
                let data = rawData.assumingMemoryBound(to: if_data.self).pointee
                return NetworkInterfaceByteCounters(
                    received: data.ifi_ibytes,
                    sent: data.ifi_obytes,
                    uptime: ProcessInfo.processInfo.systemUptime
                )
            }
            cursor = interface.ifa_next
        }
        return nil
    }
}
