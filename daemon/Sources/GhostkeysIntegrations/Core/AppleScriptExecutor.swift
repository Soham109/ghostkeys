import AppKit
import Foundation

/// Error numbers the generated scripts raise on purpose (`error "..." number 9001`).
enum ScriptErrorNumber {
    static let nothingToActOn = 9001
    static let refused = 9002
    static let unsupported = 9003
}

/// Runs scripts with NSAppleScript on one serial queue (NSAppleScript is not safe to use from several
/// threads at once). Each script must define `on gk_main(args)`. The runner calls that handler with a
/// subroutine Apple Event whose single parameter is the argument list, so arguments are passed as data.
public final class AppleScriptExecutor: ScriptExecutor, @unchecked Sendable {
    public static let shared = AppleScriptExecutor()

    /// One queue for the whole process: separate NSAppleScript instances running on different threads
    /// interfere with each other (seen in tests: one script's error surfaced in another's result).
    private static let queue = DispatchQueue(label: "ghostkeys.integrations.applescript", qos: .userInitiated)
    private var queue: DispatchQueue { Self.queue }
    private var compiled: [String: NSAppleScript] = [:]   // touched only on `queue`

    public init() {}

    public func run(source: String, args: [ScriptValue]) async -> Result<ScriptValue, IntegrationError> {
        await withCheckedContinuation { cont in
            queue.async {
                cont.resume(returning: self.runOnQueue(source: source, args: args))
            }
        }
    }

    /// Compiles without running. Compiling reads the target app's dictionary but sends it no events.
    public func compile(source: String) -> Result<Void, IntegrationError> {
        queue.sync {
            switch script(for: source) {
            case .success: return .success(())
            case .failure(let e): return .failure(e)
            }
        }
    }

    private func script(for source: String) -> Result<NSAppleScript, IntegrationError> {
        if let s = compiled[source] { return .success(s) }
        guard let s = NSAppleScript(source: source) else {
            return .failure(.scriptFailed(code: -1, message: "could not create script"))
        }
        var err: NSDictionary?
        guard s.compileAndReturnError(&err) else { return .failure(Self.map(err)) }
        compiled[source] = s
        return .success(s)
    }

    private func runOnQueue(source: String, args: [ScriptValue]) -> Result<ScriptValue, IntegrationError> {
        let s: NSAppleScript
        switch script(for: source) {
        case .success(let x): s = x
        case .failure(let e): return .failure(e)
        }
        let event = NSAppleEventDescriptor.appleEvent(
            withEventClass: FourCC.ascr, eventID: FourCC.psbr,
            targetDescriptor: NSAppleEventDescriptor.currentProcess(),
            returnID: AEReturnID(-1), transactionID: AETransactionID(0))
        event.setParam(NSAppleEventDescriptor(string: "gk_main"), forKeyword: FourCC.snam)
        let params = NSAppleEventDescriptor.list()
        params.insert(Self.descriptor(.list(args)), at: 1)
        event.setParam(params, forKeyword: FourCC.directObject)

        var err: NSDictionary?
        let result = s.executeAppleEvent(event, error: &err)
        if let err { return .failure(Self.map(err)) }
        return .success(Self.value(result))
    }

    // MARK: conversion

    static func descriptor(_ v: ScriptValue) -> NSAppleEventDescriptor {
        switch v {
        case .string(let s): return NSAppleEventDescriptor(string: s)
        case .int(let i): return NSAppleEventDescriptor(int32: Int32(clamping: i))
        case .double(let d): return NSAppleEventDescriptor(double: d)
        case .bool(let b): return NSAppleEventDescriptor(boolean: b)
        case .missing: return NSAppleEventDescriptor.null()
        case .list(let items):
            let l = NSAppleEventDescriptor.list()
            for (i, item) in items.enumerated() { l.insert(descriptor(item), at: i + 1) }
            return l
        }
    }

    static func value(_ d: NSAppleEventDescriptor) -> ScriptValue {
        switch d.descriptorType {
        case FourCC.list:
            var out: [ScriptValue] = []
            if d.numberOfItems > 0 {
                for i in 1...d.numberOfItems {
                    if let item = d.atIndex(i) { out.append(value(item)) }
                }
            }
            return .list(out)
        case FourCC.bool, FourCC.true_, FourCC.false_:
            return .bool(d.booleanValue)
        case FourCC.long, FourCC.short:
            return .int(Int(d.int32Value))
        case FourCC.double, FourCC.float:
            return .double(d.doubleValue)
        case FourCC.null:
            return .missing
        case FourCC.type, FourCC.enumerated:
            // `missing value` comes back as a type descriptor 'msng'.
            if d.typeCodeValue == FourCC.msng || d.enumCodeValue == FourCC.msng { return .missing }
            return .string(d.stringValue ?? "")
        default:
            return d.stringValue.map(ScriptValue.string) ?? .missing
        }
    }

    static func map(_ err: NSDictionary?) -> IntegrationError {
        let code = (err?[NSAppleScript.errorNumber] as? Int) ?? -1
        let message = (err?[NSAppleScript.errorMessage] as? String)
            ?? (err?[NSAppleScript.errorBriefMessage] as? String) ?? "unknown AppleScript error"
        switch code {
        case -1743, -1744: return .notAuthorized(bundleId: "")
        case -1712: return .timedOut
        case -600, -609: return .appNotRunning(bundleId: "")
        case -1728, -1719: return .nothingToActOn(message)
        case ScriptErrorNumber.nothingToActOn: return .nothingToActOn(message)
        case ScriptErrorNumber.refused: return .refused(message)
        case ScriptErrorNumber.unsupported: return .unsupported(message)
        default: return .scriptFailed(code: code, message: message)
        }
    }

}

/// Four-character Apple Event codes, spelled out so the module does not need Carbon headers.
enum FourCC {
    static func code(_ s: String) -> UInt32 { s.utf8.reduce(0) { ($0 << 8) | UInt32($1) } }
    static let ascr = code("ascr")          // kASAppleScriptSuite
    static let psbr = code("psbr")          // kASSubroutineEvent
    static let snam = code("snam")          // keyASSubroutineName
    static let directObject = code("----")  // keyDirectObject
    static let list = code("list")
    static let bool = code("bool")
    static let true_ = code("true")
    static let false_ = code("fals")
    static let long = code("long")
    static let short = code("shor")
    static let double = code("doub")
    static let float = code("sing")
    static let null = code("null")
    static let type = code("type")
    static let enumerated = code("enum")
    static let msng = code("msng")
}

/// The real system: NSWorkspace, NSPasteboard, NSRunningApplication.
public struct SystemEnvironment: IntegrationEnvironment {
    public init() {}

    public func isRunning(bundleId: String) -> Bool {
        !NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).isEmpty
    }

    public func isInstalled(bundleId: String) -> Bool {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) != nil
    }

    public func frontmostBundleId() -> String? {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    }

    public func activate(bundleId: String) async -> Bool {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first else { return false }
        if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleId { return true }
        app.activate(options: [.activateAllWindows])
        for _ in 0..<25 {   // up to about half a second
            if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleId {
                try? await Task.sleep(nanoseconds: 60_000_000)   // let the key window settle
                return true
            }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return false
    }

    public func copyToClipboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
    }

    public func open(_ urls: [URL], withBundleId bundleId: String) async -> Bool {
        guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return false }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        return await withCheckedContinuation { cont in
            NSWorkspace.shared.open(urls, withApplicationAt: appURL, configuration: config) { _, error in
                cont.resume(returning: error == nil)
            }
        }
    }
}

public enum AutomationPermission: Sendable, Equatable {
    case granted, denied, notYetAsked, appNotRunning, unknown(Int)
}

extension IntegrationRunner {
    /// Whether Ghostkeys may send Apple Events to the app, checked without showing the permission prompt.
    /// The app must be running for macOS to answer.
    public static func automationPermission(bundleId: String) -> AutomationPermission {
        let target = NSAppleEventDescriptor(bundleIdentifier: bundleId)
        guard let desc = target.aeDesc else { return .unknown(-1) }
        let status = AEDeterminePermissionToAutomateTarget(desc, typeWildCard, typeWildCard, false)
        switch status {
        case noErr: return .granted
        case OSStatus(errAEEventNotPermitted): return .denied
        case OSStatus(errAEEventWouldRequireUserConsent): return .notYetAsked
        case OSStatus(procNotFound): return .appNotRunning
        default: return .unknown(Int(status))
        }
    }
}
