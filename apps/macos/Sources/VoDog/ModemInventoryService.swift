import CModemBridge
import Foundation

struct DiscoveredModemDevice: Equatable, Identifiable {
    let vendorID: UInt16
    let productID: UInt16
    let locationID: UInt32
    let registryID: UInt64

    var id: UInt32 { locationID }

    var moduleID: CellularModuleID {
        CellularModuleID(rawValue: String(format: "usb-location:%08X", locationID))
    }

    var usbIdentity: String {
        String(format: "%04X:%04X", vendorID, productID)
    }

    var locationDescription: String {
        String(format: "0x%08X", locationID)
    }
}

final class ModemInventoryService {
    var onDevices: (([DiscoveredModemDevice]) -> Void)?

    private let queue = DispatchQueue(
        label: "org.vodog.macos.modem-inventory",
        qos: .utility
    )
    private var timer: DispatchSourceTimer?
    private var lastPublishedDevices: [DiscoveredModemDevice]?

    func start() {
        queue.async { [weak self] in
            guard let self, self.timer == nil else { return }
            self.scanAndPublish()

            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(
                deadline: .now() + .seconds(2),
                repeating: .seconds(2),
                leeway: .milliseconds(250)
            )
            timer.setEventHandler { [weak self] in self?.scanAndPublish() }
            self.timer = timer
            timer.resume()
        }
    }

    func refresh() {
        queue.async { [weak self] in self?.scanAndPublish(force: true) }
    }

    func stop() {
        queue.async { [weak self] in
            self?.timer?.cancel()
            self?.timer = nil
        }
    }

    private func scanAndPublish(force: Bool = false) {
        let devices = Self.scan()
        guard force || devices != lastPublishedDevices else { return }
        lastPublishedDevices = devices
        DispatchQueue.main.async { [weak self] in
            self?.onDevices?(devices)
        }
    }

    private static func scan() -> [DiscoveredModemDevice] {
        var capacity = Int(celldock_modem_copy_devices(nil, 0))
        guard capacity > 0 else { return [] }

        for _ in 0 ..< 2 {
            var rawDevices = Array(
                repeating: VoDogModemDevice(
                    vendor_id: 0,
                    product_id: 0,
                    location_id: 0,
                    registry_id: 0
                ),
                count: capacity
            )
            let discoveredCount = rawDevices.withUnsafeMutableBufferPointer { buffer in
                celldock_modem_copy_devices(buffer.baseAddress, buffer.count)
            }
            if discoveredCount > capacity {
                capacity = discoveredCount
                continue
            }
            return rawDevices.prefix(discoveredCount).map { device in
                DiscoveredModemDevice(
                    vendorID: device.vendor_id,
                    productID: device.product_id,
                    locationID: device.location_id,
                    registryID: device.registry_id
                )
            }
        }
        return []
    }
}
