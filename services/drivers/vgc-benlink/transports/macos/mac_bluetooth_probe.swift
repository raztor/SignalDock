// Minimal transport for local Bluetooth Classic, RX, and TX tests.
import AppKit
import Foundation
import IOBluetooth

final class Probe: NSObject, NSApplicationDelegate, IOBluetoothDeviceInquiryDelegate, IOBluetoothRFCOMMChannelDelegate {
    var inquiry: IOBluetoothDeviceInquiry?
    var timer: Timer?
    var started = false
    var finished = false
    var audioChannel: IOBluetoothRFCOMMChannel?
    var audioBytes = 0
    var audioChunks: [String] = []
    var lastAudioSave = Date.distantPast
    var txJob: [String: Any]?
    var txChunks: [Data] = []
    var txEnd = Data()
    var txIndex = 0
    var endingTX = false
    var txTimer: Timer?
    let captureAudio: Bool
    var data: [String: Any] = ["result": "running", "transport": "IOBluetooth", "opens_audio": false]
    let output: URL

    init(output: URL, captureAudio: Bool, txJob: [String: Any]?) {
        self.output = output
        self.captureAudio = captureAudio
        self.txJob = txJob
        super.init()
        data["opens_audio"] = captureAudio
    }

    func save() {
        do {
            let bytes = try JSONSerialization.data(withJSONObject: data, options: [.prettyPrinted, .sortedKeys])
            try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
            try bytes.write(to: output, options: .atomic)
        } catch { fputs("Could not save the diagnostic report: \(error)\n", stderr) }
    }

    func finish(_ result: String) {
        guard !finished else { return }
        if txIndex > 0 && !endingTX { stopTX(result); return }
        finished = true
        timer?.invalidate()
        txTimer?.invalidate()
        if let channel = audioChannel { data["audio_close_status"] = channel.close() }
        data["result"] = result
        data["finished_utc"] = ISO8601DateFormatter().string(from: Date())
        save()
        NSApplication.shared.terminate(nil)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        data["started_utc"] = ISO8601DateFormatter().string(from: Date())
        let pairedRadios = (IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice] ?? [])
            .filter { ($0.name ?? "").uppercased().contains("VR-N7500") }
        data["paired_radio"] = pairedRadios.map { ["name": $0.name ?? "", "address": $0.addressString ?? ""] }
        inquiry = IOBluetoothDeviceInquiry(delegate: self)
        inquiry?.inquiryLength = 12
        inquiry?.updateNewDeviceNames = true
        timer = Timer.scheduledTimer(withTimeInterval: 35, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            let result = self.captureAudio ? "audio_open_timeout" : self.data["sdp_started"] as? Bool == true ? "sdp_timeout" :
                (self.started ? "inquiry_timeout" : "inquiry_never_started")
            self.data["inquiry_started"] = self.started
            // Save the reason before stop() invokes the delegate.
            self.finished = true
            self.inquiry?.stop()
            self.finished = false
            self.finish(result)
        }
        if let radio = pairedRadios.first {
            if captureAudio { openAudio(radio) } else { query(radio) }
            return
        }
        let status = inquiry?.start() ?? kIOReturnError
        data["start_return"] = status
        save()
        if status != kIOReturnSuccess { finish("inquiry_start_failed") }
    }

    func deviceInquiryStarted(_ sender: IOBluetoothDeviceInquiry) {
        started = true
        data["inquiry_started"] = true
        save()
    }

    func deviceInquiryComplete(_ sender: IOBluetoothDeviceInquiry, error: IOReturn, aborted: Bool) {
        guard !finished else { return }
        data["inquiry_error"] = error
        data["inquiry_aborted"] = aborted
        let devices = sender.foundDevices() as? [IOBluetoothDevice] ?? []
        data["devices"] = devices.map { ["name": $0.name ?? "", "address": $0.addressString ?? "", "paired": $0.isPaired()] as [String: Any] }
        guard error == kIOReturnSuccess && !aborted else { finish("inquiry_failed"); return }
        guard let radio = devices.first(where: { ($0.name ?? "").uppercased().contains("VR-N7500") }) else {
            finish("radio_not_found"); return
        }
        if captureAudio { openAudio(radio) } else { query(radio) }
    }

    func openAudio(_ radio: IOBluetoothDevice) {
        data["radio_address"] = radio.addressString
        let services = serviceDescriptions(radio)
        data["cached_services"] = services
        data["cached_services_are_fresh"] = false
        let matches = services.filter { $0["name"] as? String == "BS AOC" }
        guard matches.count == 1, let number = matches[0]["rfcomm_channel"] as? Int,
              number > 0 && number <= 30 else { finish("audio_service_not_identified"); return }
        data["audio_channel"] = number
        let status = radio.openRFCOMMChannelAsync(&audioChannel, withChannelID: UInt8(number), delegate: self)
        data["audio_open_start_return"] = status
        save()
        if status != kIOReturnSuccess { finish("audio_open_failed") }
    }

    func rfcommChannelOpenComplete(_ rfcommChannel: IOBluetoothRFCOMMChannel, status: IOReturn) {
        guard !finished else { return }
        data["audio_open_status"] = status
        guard status == kIOReturnSuccess else { finish("audio_open_failed"); return }
        audioChannel = rfcommChannel
        data["audio_link_open"] = true
        timer?.invalidate()
        if txJob != nil { startTX(); return }
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.data["audio_bytes"] = self.audioBytes
            self.data["audio_chunks_base64"] = self.audioChunks
            self.finish(self.audioBytes > 0 ? "audio_bytes_received" : "audio_link_open_no_data")
        }
        save()
    }

    func write(_ payload: Data) -> IOReturn {
        guard let channel = audioChannel, channel.isOpen() else { return kIOReturnNotOpen }
        let mtu = max(1, Int(channel.getMTU()))
        var bytes = [UInt8](payload)
        for offset in stride(from: 0, to: bytes.count, by: mtu) {
            let count = min(mtu, bytes.count - offset)
            let status = bytes.withUnsafeMutableBytes { buffer in
                channel.writeSync(buffer.baseAddress!.advanced(by: offset), length: UInt16(count))
            }
            if status != kIOReturnSuccess { return status }
        }
        return kIOReturnSuccess
    }

    func startTX() {
        guard let job = txJob,
              let expiry = job["expires_epoch"] as? Double, Date().timeIntervalSince1970 < expiry,
              let chunks = job["chunks_base64"] as? [String], !chunks.isEmpty, chunks.count <= 100,
              job["interval_seconds"] as? Double == 0.02,
              let ending = job["end_base64"] as? String, let end = Data(base64Encoded: ending) else {
            finish("invalid_or_expired_tx_job"); return
        }
        txChunks = chunks.compactMap { Data(base64Encoded: $0) }
        guard txChunks.count == chunks.count, txChunks.allSatisfy({ !$0.isEmpty && $0.count <= 4096 }) else {
            finish("invalid_tx_job"); return
        }
        txEnd = end
        guard !txCancelled() else { finish("tx_cancelled_before_start"); return }
        data["tx_started_utc"] = ISO8601DateFormatter().string(from: Date())
        data["tx_test_max_audio_seconds"] = Double(chunks.count) * 0.02
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in self?.stopTX("tx_watchdog") }
        txTimer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in
            guard let self = self, !self.endingTX else { return }
            if self.txCancelled() { self.stopTX("tx_cancelled"); return }
            if self.txIndex == self.txChunks.count { self.stopTX("tx_audio_sent"); return }
            // Mark the attempt before write: an error does not prove that nothing was sent.
            let payload = self.txChunks[self.txIndex]
            self.txIndex += 1
            let status = self.write(payload)
            self.data["tx_chunks_attempted"] = self.txIndex
            if status != kIOReturnSuccess {
                self.data["tx_write_error"] = status
                self.stopTX("tx_write_failed")
            }
        }
        save()
    }

    func txCancelled() -> Bool {
        if let deadline = txJob?["expires_epoch"] as? Double,
           Date().timeIntervalSince1970 >= deadline { return true }
        if let path = txJob?["cancel_path"] as? String,
           FileManager.default.fileExists(atPath: path) { return true }
        return false
    }

    func stopTX(_ result: String) {
        guard !endingTX && !finished else { return }
        endingTX = true
        timer?.invalidate()
        txTimer?.invalidate()
        data["audio_end_first_status"] = write(txEnd)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            guard let self = self else { return }
            self.data["audio_end_second_status"] = self.write(self.txEnd)
            self.save()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.finish(result) }
        }
    }

    func rfcommChannelData(_ rfcommChannel: IOBluetoothRFCOMMChannel, data dataPointer: UnsafeMutableRawPointer, length dataLength: Int) {
        guard !finished else { return }
        audioBytes += dataLength
        audioChunks.append(Data(bytes: dataPointer, count: dataLength).base64EncodedString())
        data["audio_bytes"] = audioBytes
        data["audio_chunks_base64"] = audioChunks
        if Date().timeIntervalSince(lastAudioSave) >= 1 {
            lastAudioSave = Date()
            save()
        }
        if audioBytes >= 1_048_576 { finish("audio_capture_limit_reached") }
    }

    func rfcommChannelClosed(_ rfcommChannel: IOBluetoothRFCOMMChannel) {
        if !finished { finish("audio_link_closed_by_radio") }
    }

    func query(_ radio: IOBluetoothDevice) {
        data["radio_address"] = radio.addressString
        data["cached_services"] = serviceDescriptions(radio)
        data["cached_services_are_fresh"] = false
        data["sdp_started"] = true
        let status = radio.performSDPQuery(self)
        data["sdp_start_return"] = status
        save()
        if status != kIOReturnSuccess { finish("sdp_start_failed") }
    }

    @objc func sdpQueryComplete(_ device: IOBluetoothDevice, status: IOReturn) {
        guard !finished else { return }
        data["sdp_status"] = status
        data["services"] = serviceDescriptions(device)
        finish(status == kIOReturnSuccess ? "sdp_complete" : "sdp_failed")
    }

    func serviceDescriptions(_ device: IOBluetoothDevice) -> [[String: Any]] {
        return (device.services as? [IOBluetoothSDPServiceRecord] ?? []).map { service in
            var channel: BluetoothRFCOMMChannelID = 0
            let result = service.getRFCOMMChannelID(&channel)
            return ["name": service.getServiceName() ?? "", "rfcomm_status": result,
                    "rfcomm_channel": result == kIOReturnSuccess ? Int(channel) : NSNull()] as [String: Any]
        }
    }
}

let arguments = CommandLine.arguments
guard arguments.count == 2 || (arguments.count == 3 && arguments[2] == "--audio-rx") ||
    (arguments.count == 4 && arguments[2] == "--audio-tx") else { exit(2) }
var txJob: [String: Any]?
if arguments.count == 4 {
    guard let bytes = try? Data(contentsOf: URL(fileURLWithPath: arguments[3])),
          let job = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { exit(2) }
    txJob = job
}
let probe = Probe(output: URL(fileURLWithPath: arguments[1]), captureAudio: arguments.count >= 3, txJob: txJob)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.delegate = probe
app.run()
