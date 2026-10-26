// Explicit-device, long-lived development transport. No discovery or automatic TX.
import AppKit
import Darwin
import Foundation
import IOBluetooth

final class StreamingTransport: NSObject, NSApplicationDelegate, IOBluetoothRFCOMMChannelDelegate {
    let ipcPath: String
    let address: String
    let channelNumber: UInt8
    var channel: IOBluetoothRFCOMMChannel?
    var socketFD: Int32 = -1
    var handle: FileHandle?
    var input = Data()
    var watchdog: Timer?
    var finished = false
    var terminating = false
    var grant: String?
    var grantDeadline: TimeInterval = 0
    var absoluteDeadline: TimeInterval = 0
    var endingFrame = Data()

    init(ipcPath: String, address: String, channelNumber: UInt8) {
        self.ipcPath = ipcPath
        self.address = address
        self.channelNumber = channelNumber
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard ipcPath.utf8.count < 100 else { finish(); return }
        socketFD = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFD >= 0 else { finish(); return }
        var ignorePipe: Int32 = 1
        setsockopt(socketFD, SOL_SOCKET, SO_NOSIGPIPE, &ignorePipe, socklen_t(MemoryLayout<Int32>.size))
        var destination = sockaddr_un()
        destination.sun_family = sa_family_t(AF_UNIX)
        destination.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &destination.sun_path) { buffer in
            ipcPath.utf8CString.withUnsafeBytes { value in buffer.copyBytes(from: value) }
        }
        let result = withUnsafePointer(to: &destination) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(socketFD, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else { finish(); return }
        handle = FileHandle(fileDescriptor: socketFD, closeOnDealloc: false)
        handle?.readabilityHandler = { [weak self] fd in
            guard let self = self else { return }
            let data = fd.availableData
            DispatchQueue.main.async {
                if data.isEmpty { self.stopAndExit("parent_disconnected"); return }
                self.input.append(data)
                guard self.input.count <= 65536 else { self.stopAndExit("ipc_buffer_limit"); return }
                while let newline = self.input.firstIndex(of: 10) {
                    let line = self.input.prefix(upTo: newline)
                    self.input.removeSubrange(...newline)
                    guard let command = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                        self.stopAndExit("invalid_ipc"); return
                    }
                    self.command(command)
                }
            }
        }
        watchdog = Timer.scheduledTimer(withTimeInterval: 0.025, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let now = ProcessInfo.processInfo.systemUptime
            if self.grant != nil && (now >= self.grantDeadline || now >= self.absoluteDeadline) {
                self.stopAndExit("expired")
            }
        }
        guard let device = IOBluetoothDevice(addressString: address) else { stopAndExit("device_unavailable"); return }
        let status = device.openRFCOMMChannelAsync(&channel, withChannelID: channelNumber, delegate: self)
        if status != kIOReturnSuccess { stopAndExit("audio_open_failed") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self = self, self.channel?.isOpen() != true else { return }
            self.stopAndExit("audio_open_timeout")
        }
    }

    func emit(_ value: [String: Any]) {
        guard socketFD >= 0, !finished,
              var data = try? JSONSerialization.data(withJSONObject: value) else { return }
        data.append(10)
        let count = data.withUnsafeBytes { Darwin.send(socketFD, $0.baseAddress, $0.count, 0) }
        if count != data.count { stopAndExit("parent_disconnected") }
    }

    func command(_ command: [String: Any]) {
        guard !terminating && !finished else { return }
        switch command["type"] as? String {
        case "arm":
            guard let identifier = command["txId"] as? String, UUID(uuidString: identifier) != nil,
                  let ttl = command["ttlMs"] as? Int, ttl > 0 && ttl <= 1500,
                  let ending = command["end"] as? String, let bytes = Data(base64Encoded: ending),
                  !bytes.isEmpty && bytes.count <= 64,
                  channel?.isOpen() == true else { stopAndExit("invalid_arm"); return }
            let now = ProcessInfo.processInfo.systemUptime
            if let current = grant {
                guard current == identifier && now < grantDeadline && now < absoluteDeadline else {
                    stopAndExit("invalid_renewal"); return
                }
            } else {
                absoluteDeadline = now + 30
            }
            grant = identifier
            endingFrame = bytes
            grantDeadline = min(now + Double(ttl) / 1000, absoluteDeadline)
        case "send":
            guard let encoded = command["data"] as? String, let bytes = Data(base64Encoded: encoded),
                  !bytes.isEmpty && bytes.count <= 4096 else { stopAndExit("invalid_audio"); return }
            let now = ProcessInfo.processInfo.systemUptime
            guard bytes == endingFrame || (grant != nil && now < grantDeadline && now < absoluteDeadline) else {
                stopAndExit("expired"); return
            }
            if write(bytes) != kIOReturnSuccess { stopAndExit("audio_write_failed") }
        case "stop":
            stopAudio()
        default:
            stopAndExit("invalid_command")
        }
    }

    func write(_ data: Data) -> IOReturn {
        guard let active = channel, active.isOpen() else { return kIOReturnNotOpen }
        let mtu = max(1, Int(active.getMTU()))
        var bytes = [UInt8](data)
        let count = bytes.count
        for offset in stride(from: 0, to: count, by: mtu) {
            let status = bytes.withUnsafeMutableBytes { buffer in
                active.writeSync(buffer.baseAddress!.advanced(by: offset), length: UInt16(min(mtu, count - offset)))
            }
            if status != kIOReturnSuccess { return status }
        }
        return kIOReturnSuccess
    }

    func stopAudio() {
        grant = nil
        if !endingFrame.isEmpty {
            _ = write(endingFrame)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                guard let self = self, !self.finished else { return }
                _ = self.write(self.endingFrame)
            }
        }
    }

    func stopAndExit(_ reason: String) {
        guard !terminating && !finished else { return }
        terminating = true
        stopAudio()
        emit(["type": reason == "expired" ? "expired" : "error", "reason": reason])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in self?.finish() }
    }

    func finish() {
        guard !finished else { return }
        finished = true
        watchdog?.invalidate()
        handle?.readabilityHandler = nil
        _ = channel?.close()
        if socketFD >= 0 { Darwin.close(socketFD); socketFD = -1 }
        NSApplication.shared.terminate(nil)
    }

    func rfcommChannelOpenComplete(_ rfcommChannel: IOBluetoothRFCOMMChannel, status: IOReturn) {
        guard !finished && !terminating else { _ = rfcommChannel.close(); return }
        guard status == kIOReturnSuccess else { stopAndExit("audio_open_failed"); return }
        channel = rfcommChannel
        emit(["type": "ready"])
    }

    func rfcommChannelData(_ rfcommChannel: IOBluetoothRFCOMMChannel, data pointer: UnsafeMutableRawPointer, length count: Int) {
        guard !finished && !terminating else { return }
        for offset in stride(from: 0, to: count, by: 4096) {
            let part = Data(bytes: pointer.advanced(by: offset), count: min(4096, count - offset))
            emit(["type": "rx", "data": part.base64EncodedString()])
        }
    }

    func rfcommChannelClosed(_ rfcommChannel: IOBluetoothRFCOMMChannel) {
        stopAndExit("audio_link_closed")
    }
}

let arguments = CommandLine.arguments
guard arguments.count == 4, arguments[1].hasPrefix("/"),
      let number = UInt8(arguments[3]), number > 0 && number <= 30 else { exit(2) }
let application = NSApplication.shared
let transport = StreamingTransport(ipcPath: arguments[1], address: arguments[2], channelNumber: number)
application.setActivationPolicy(.accessory)
application.delegate = transport
application.run()
