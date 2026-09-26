// AVCaptureSession wrapper for short "air sessions". Nothing here touches the camera until `start` is called:
// constructing a CameraSession, or listing devices, never turns on the green light or prompts for permission.
import AVFoundation
import CoreMedia
import Foundation

public enum CameraKind: String, Sendable, CaseIterable {
    /// The FaceTime camera looking at the user: in-air gestures in front of the screen.
    case front
    /// Apple's Desk View camera (M-series, macOS 13+): a synthesized top-down view of the desk.
    case deskView = "desk_view"
}

public struct CameraDeviceInfo: Sendable, Equatable {
    public var uniqueID: String
    public var name: String
    public var kind: CameraKind
    public var maxWidth: Int
    public var maxHeight: Int
    public var centerStageSupported: Bool
}

public final class CameraSession: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    public struct Options: Sendable {
        public var kind: CameraKind = .front
        /// Smallest capture size we ask for. Vision's hand model does not need more than ~640 wide.
        public var preferredWidth: Int = 640
        public var preferredHeight: Int = 480
        public var activeFPS: Double = 30
        public var idleFPS: Double = 5
        /// How long without a hand before dropping back to idleFPS.
        public var idleAfter: TimeInterval = 1.0
        /// Hard stop for an air session, so the camera (and its green light) never stays on by accident.
        public var maxDuration: TimeInterval = 30
        public init() {}
    }

    public enum StopReason: String, Sendable {
        case requested, timeout, error, interrupted
    }

    public enum CameraError: Error, CustomStringConvertible {
        case notAuthorized
        case noDevice(CameraKind)
        case configuration(String)
        public var description: String {
            switch self {
            case .notAuthorized: return "camera access not granted"
            case .noDevice(let k): return "no \(k.rawValue) camera on this Mac"
            case .configuration(let m): return "camera configuration failed: \(m)"
            }
        }
    }

    public let options: Options
    /// Called on the capture queue for every frame that passes the rate limiter.
    public var onFrame: ((CMSampleBuffer) -> Void)?
    /// Called when the session stops for any reason.
    public var onStop: ((StopReason) -> Void)?

    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let captureQueue = DispatchQueue(label: "ghostkeys.vision.capture", qos: .userInteractive)
    private let controlQueue = DispatchQueue(label: "ghostkeys.vision.control")
    private var device: AVCaptureDevice?
    private var timeoutWork: DispatchWorkItem?
    private var running = false

    // Rate control. Guarded by captureQueue.
    private var currentFPS: Double = 0
    private var hardwareRateOK = false
    private var lastDelivered: CMTime = .invalid
    private var lastHandSeen: TimeInterval = 0

    public init(options: Options = Options()) {
        self.options = options
        super.init()
    }

    // MARK: device discovery (safe: does not open any camera)

    public static func availableDevices() -> [CameraDeviceInfo] {
        var types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera]
        if #available(macOS 13.0, *) { types.append(.deskViewCamera) }
        let discovery = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: .unspecified)
        return discovery.devices.map { d in
            var kind: CameraKind = .front
            if #available(macOS 13.0, *), d.deviceType == .deskViewCamera { kind = .deskView }
            var mw = 0, mh = 0, cs = false
            for f in d.formats {
                let dim = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
                if Int(dim.width) * Int(dim.height) > mw * mh { mw = Int(dim.width); mh = Int(dim.height) }
                if f.isCenterStageSupported { cs = true }
            }
            return CameraDeviceInfo(uniqueID: d.uniqueID, name: d.localizedName, kind: kind,
                                    maxWidth: mw, maxHeight: mh, centerStageSupported: cs)
        }
    }

    static func findDevice(_ kind: CameraKind) -> AVCaptureDevice? {
        switch kind {
        case .front:
            let s = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera], mediaType: .video,
                                                     position: .unspecified)
            // Prefer the built-in camera over Continuity or external cameras.
            return s.devices.first { $0.localizedName.localizedCaseInsensitiveContains("MacBook") } ?? s.devices.first
        case .deskView:
            guard #available(macOS 13.0, *) else { return nil }
            let s = AVCaptureDevice.DiscoverySession(deviceTypes: [.deskViewCamera], mediaType: .video,
                                                     position: .unspecified)
            return s.devices.first
        }
    }

    // MARK: lifecycle

    public var isRunning: Bool { controlQueue.sync { running } }

    /// Starts an air session. Asks for camera permission the first time (that is a user-visible prompt, so the
    /// daemon must only call this in response to an explicit user action).
    public func start(completion: @escaping (Error?) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            controlQueue.async { completion(self.configureAndRun()) }
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                self.controlQueue.async { completion(granted ? self.configureAndRun() : CameraError.notAuthorized) }
            }
        default:
            completion(CameraError.notAuthorized)
        }
    }

    public func stop() { controlQueue.async { self.stopLocked(.requested) } }

    /// Tell the session whether the tracker currently sees a hand. Drives the 5 fps / 30 fps switch.
    public func setHandPresent(_ present: Bool, now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        captureQueue.async {
            if present {
                self.lastHandSeen = now
                if self.currentFPS != self.options.activeFPS { self.applyRate(self.options.activeFPS) }
            } else if now - self.lastHandSeen > self.options.idleAfter, self.currentFPS != self.options.idleFPS {
                self.applyRate(self.options.idleFPS)
            }
        }
    }

    private func configureAndRun() -> Error? {
        guard !running else { return nil }
        guard let dev = CameraSession.findDevice(options.kind) else { return CameraError.noDevice(options.kind) }
        device = dev

        // Center Stage crops and pans to follow faces, which moves the geometry under the gestures. Turn it off.
        if #available(macOS 12.3, *) {
            AVCaptureDevice.centerStageControlMode = .app
            AVCaptureDevice.isCenterStageEnabled = false
        }

        session.beginConfiguration()
        do {
            let input = try AVCaptureDeviceInput(device: dev)
            guard session.canAddInput(input) else {
                session.commitConfiguration()
                return CameraError.configuration("cannot add input")
            }
            session.addInput(input)
        } catch {
            session.commitConfiguration()
            return error
        }
        output.alwaysDiscardsLateVideoFrames = true
        var settings: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ]
        do {
            try dev.lockForConfiguration()
            if let f = CameraSession.pickFormat(dev.formats, width: options.preferredWidth,
                                                height: options.preferredHeight, fps: options.activeFPS) {
                dev.activeFormat = f
                let dim = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
                // Ask the output to scale down while keeping the format's aspect ratio.
                let w = min(Int(dim.width), options.preferredWidth)
                settings[kCVPixelBufferWidthKey as String] = w
                settings[kCVPixelBufferHeightKey as String] = Int(Double(w) * Double(dim.height) / Double(dim.width))
            }
            dev.unlockForConfiguration()
        } catch {
            session.commitConfiguration()
            return CameraError.configuration("lockForConfiguration: \(error)")
        }
        output.videoSettings = settings
        output.setSampleBufferDelegate(self, queue: captureQueue)
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            return CameraError.configuration("cannot add output")
        }
        session.addOutput(output)
        session.commitConfiguration()

        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)),
                                               name: .AVCaptureSessionRuntimeError, object: session)
        session.startRunning()
        running = true
        captureQueue.sync {
            lastHandSeen = 0
            lastDelivered = .invalid
            applyRate(options.idleFPS)
        }

        let work = DispatchWorkItem { [weak self] in self?.stopLocked(.timeout) }
        timeoutWork = work
        controlQueue.asyncAfter(deadline: .now() + options.maxDuration, execute: work)
        return nil
    }

    @objc private func interrupted(_ note: Notification) {
        controlQueue.async { self.stopLocked(.interrupted) }
    }

    private func stopLocked(_ reason: StopReason) {
        guard running else { return }
        running = false
        timeoutWork?.cancel()
        timeoutWork = nil
        NotificationCenter.default.removeObserver(self)
        session.stopRunning()
        session.beginConfiguration()
        session.inputs.forEach { session.removeInput($0) }
        session.outputs.forEach { session.removeOutput($0) }
        session.commitConfiguration()
        device = nil
        onStop?(reason)
    }

    /// Prefers the hardware frame rate; if the format cannot go that slow, frames are dropped in software instead.
    private func applyRate(_ fps: Double) {
        currentFPS = fps
        hardwareRateOK = false
        guard let dev = device, (try? dev.lockForConfiguration()) != nil else { return }
        defer { dev.unlockForConfiguration() }
        let ranges = dev.activeFormat.videoSupportedFrameRateRanges
        if ranges.contains(where: { $0.minFrameRate <= fps + 0.01 && fps - 0.01 <= $0.maxFrameRate }) {
            let d = CMTime(value: 1000, timescale: CMTimeScale(fps * 1000))
            dev.activeVideoMinFrameDuration = d
            dev.activeVideoMaxFrameDuration = d
            hardwareRateOK = true
        }
    }

    static func pickFormat(_ formats: [AVCaptureDevice.Format], width: Int, height: Int,
                           fps: Double) -> AVCaptureDevice.Format? {
        let usable = formats.filter { f in
            f.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= fps - 0.01 }
        }
        func area(_ f: AVCaptureDevice.Format) -> Int {
            let d = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            return Int(d.width) * Int(d.height)
        }
        let bigEnough = usable.filter {
            let d = CMVideoFormatDescriptionGetDimensions($0.formatDescription)
            return Int(d.width) >= width && Int(d.height) >= height
        }
        return bigEnough.min { area($0) < area($1) } ?? usable.max { area($0) < area($1) }
    }

    // MARK: AVCaptureVideoDataOutputSampleBufferDelegate

    public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                              from connection: AVCaptureConnection) {
        if !hardwareRateOK, currentFPS > 0 {
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            if lastDelivered.isValid, (pts - lastDelivered).seconds < (1.0 / currentFPS) * 0.9 { return }
            lastDelivered = pts
        }
        onFrame?(sampleBuffer)
    }
}
