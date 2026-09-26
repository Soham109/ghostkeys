import Foundation

/// Runs catalog commands.
///
/// `run` returns the result as JSON: `{"followUpKeys":[{"key":"u","modifiers":["ctrl"]}],"output":"..."}`.
/// When `followUpKeys` is non-empty the runner has already brought the target app to the front, and the
/// daemon should post those keys in order (as `keystroke` actions).
public struct IntegrationRunner: Sendable {
    public static let shared = IntegrationRunner()

    /// Cells a selection may hold before Excel commands refuse (after clipping to the used range).
    public static let maxExcelCells = 5_000

    let scripts: ScriptExecutor
    let env: IntegrationEnvironment

    public init(scripts: ScriptExecutor = AppleScriptExecutor.shared, environment: IntegrationEnvironment = SystemEnvironment()) {
        self.scripts = scripts
        self.env = environment
    }

    public static func run(app: String, command: String, args: [String: String] = [:]) async -> Result<String, IntegrationError> {
        await shared.run(app: app, command: command, args: args)
    }

    public func run(app: String, command: String, args: [String: String] = [:]) async -> Result<String, IntegrationError> {
        await execute(app: app, command: command, args: args).map(\.json)
    }

    /// Same as `run`, but returns the structured result.
    public func execute(app: String, command: String, args: [String: String] = [:]) async -> Result<IntegrationResult, IntegrationError> {
        if let reason = IntegrationCatalog.unsupported["\(app)/\(command)"] { return .failure(.unsupported(reason)) }
        guard let appSpec = IntegrationCatalog.app(app) else { return .failure(.unknownApp(app)) }
        guard let spec = IntegrationCatalog.command(app: app, command: command) else {
            return .failure(.unknownCommand(app: app, command: command))
        }
        let parsed: Args
        switch Args.validate(args, against: spec.args) {
        case .success(let a): parsed = a
        case .failure(let e): return .failure(e)
        }

        if let bundle = appSpec.bundleId {
            if spec.command == "open-url" {
                guard env.isInstalled(bundleId: bundle) else { return .failure(.appNotInstalled(bundleId: bundle)) }
            } else if !env.isRunning(bundleId: bundle) {
                // Never launch an app as a side effect of a tap.
                return .failure(.appNotRunning(bundleId: bundle))
            }
        }

        let ctx = Context(runner: self, bundleId: appSpec.bundleId ?? "", args: parsed)
        var result = await dispatch(spec, ctx)

        // Scripts cannot tell which app refused them; fill in the bundle id we were talking to.
        if case .failure(.notAuthorized) = result, let b = appSpec.bundleId { result = .failure(.notAuthorized(bundleId: b)) }
        if case .failure(.appNotRunning) = result, let b = appSpec.bundleId { result = .failure(.appNotRunning(bundleId: b)) }

        if case .success(let r) = result, !r.followUpKeys.isEmpty, let b = appSpec.bundleId {
            guard await env.activate(bundleId: b) else {
                return .failure(.nothingToActOn("could not bring \(appSpec.name) to the front for its shortcut"))
            }
        }
        return result
    }

    // MARK: dispatch

    struct Context {
        let runner: IntegrationRunner
        let bundleId: String
        let args: Args

        func script(_ source: String, _ args: [ScriptValue] = []) async -> Result<ScriptValue, IntegrationError> {
            await runner.scripts.run(source: source, args: args)
        }
    }

    private func dispatch(_ spec: IntegrationCommandSpec, _ c: Context) async -> Result<IntegrationResult, IntegrationError> {
        switch spec.app {
        case "excel": return await ExcelCommands.run(spec.command, c)
        case "chrome", "arc", "safari": return await BrowserCommands.run(spec.app, spec.command, c)
        case "music", "spotify": return await PlayerCommands.run(spec.app, spec.command, c)
        case "finder": return await FinderCommands.run(spec.command, c)
        case "powerpoint", "keynote": return await PresentationCommands.run(spec.app, spec.command, c)
        case "zoom", "meet": return await CallCommands.run(spec.app, spec.command, c)
        case "system": return SystemCommands.run(spec.command, c)
        default: return .failure(.unknownApp(spec.app))
        }
    }
}

/// Validated arguments with defaults filled in.
struct Args {
    var values: [String: String]

    func string(_ name: String) -> String { values[name] ?? "" }
    func bool(_ name: String) -> Bool { ["true", "1", "yes"].contains(values[name]?.lowercased() ?? "") }
    func number(_ name: String) -> Double { Double(values[name] ?? "") ?? 0 }

    static func validate(_ raw: [String: String], against specs: [IntegrationArgSpec]) -> Result<Args, IntegrationError> {
        var out: [String: String] = [:]
        for s in specs {
            let given = raw[s.name]?.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let v = (given?.isEmpty == false ? given : nil) ?? s.defaultValue else {
                if s.required { return .failure(.invalidArgument(name: s.name, reason: "required")) }
                continue
            }
            switch s.kind {
            case .string:
                guard v.count <= 1_000 else { return .failure(.invalidArgument(name: s.name, reason: "too long")) }
            case .number:
                guard let d = Double(v), d.isFinite else { return .failure(.invalidArgument(name: s.name, reason: "not a number")) }
            case .bool:
                guard ["true", "false", "1", "0", "yes", "no"].contains(v.lowercased()) else {
                    return .failure(.invalidArgument(name: s.name, reason: "expected true or false"))
                }
            case .url:
                guard let u = URLArgument.validate(v) else {
                    return .failure(.invalidArgument(name: s.name, reason: "expected an http or https address"))
                }
                out[s.name] = u.absoluteString
                continue
            case .bundleId:
                let ok = !v.isEmpty && v.count <= 255 && v.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") }
                guard ok else { return .failure(.invalidArgument(name: s.name, reason: "not a bundle id")) }
            }
            out[s.name] = v
        }
        return .success(Args(values: out))
    }
}

/// Helpers for callers holding loosely typed JSON arguments (numbers, booleans).
public enum IntegrationArgs {
    public static func strings(from any: [String: Any]) -> [String: String] {
        var out: [String: String] = [:]
        for (k, v) in any {
            switch v {
            case let s as String: out[k] = s
            case let b as Bool: out[k] = b ? "true" : "false"
            case let n as NSNumber:
                // NSNumber booleans are caught above only when bridged as Bool.
                out[k] = CFGetTypeID(n) == CFBooleanGetTypeID() ? (n.boolValue ? "true" : "false") : n.stringValue
            case let i as Int: out[k] = String(i)
            case let d as Double: out[k] = String(d)
            default: continue
            }
        }
        return out
    }
}
