import Foundation

enum ExcelCommands {
    typealias Context = IntegrationRunner.Context

    static func run(_ command: String, _ c: Context) async -> Result<IntegrationResult, IntegrationError> {
        switch command {
        case "wrap-iferror":
            let fallback = c.args.string("fallback")
            return await transformFormulas(c) { IfErrorTransform.wrap($0, fallback: fallback) ?? $0 }
        case "unwrap-iferror":
            return await transformFormulas(c) { IfErrorTransform.unwrap($0) }
        case "toggle-absolute":
            return await toggleAbsolute(c)
        case "cycle-number-format":
            return await changeNumberFormat(c) { NumberFormatCycle.next(after: $0) }
        case "increase-decimals":
            return await changeNumberFormat(c) { DecimalPlaces.adjust($0, by: 1) }
        case "decrease-decimals":
            return await changeNumberFormat(c) { DecimalPlaces.adjust($0, by: -1) }
        case "color-inputs-formulas":
            let r = await c.script(Scripts.Excel.colorInputsFormulas,
                                   [.bool(c.args.bool("includeText")), .int(IntegrationRunner.maxExcelCells)])
            return r.map { v in
                let n = v.list ?? []
                let constants = n.first?.string ?? "0", formulas = n.dropFirst().first?.string ?? "0"
                return IntegrationResult(output: "\(constants) inputs blue, \(formulas) formulas black")
            }
        case "insert-xlookup": return await insert(.xlookup, c)
        case "insert-index-match": return await insert(.indexMatch, c)
        case "insert-sumifs": return await insert(.sumifs, c)
        case "paste-values":
            return await c.script(Scripts.Excel.pasteValues).map { _ in IntegrationResult(output: "Pasted values") }
        case "fill-down":
            return .success(IntegrationResult(output: "Fill down", followUpKeys: [KeyStroke("d", ["cmd"])]))
        case "fill-right":
            return .success(IntegrationResult(output: "Fill right", followUpKeys: [KeyStroke("r", ["cmd"])]))
        case "autosum":
            return .success(IntegrationResult(output: "AutoSum", followUpKeys: [KeyStroke("t", ["cmd", "shift"])]))
        case "trace-precedents":
            switch await c.script(Scripts.Excel.tracePrecedents) {
            case .success: return .success(IntegrationResult(output: "Traced precedents"))
            case .failure(let e):
                switch e {
                case .notAuthorized, .timedOut, .appNotRunning, .nothingToActOn: return .failure(e)
                default:
                    return .success(IntegrationResult(output: "Selected direct precedents",
                                                      followUpKeys: [KeyStroke("[", ["ctrl"])]))
                }
            }
        default:
            return .failure(.unknownCommand(app: "excel", command: command))
        }
    }

    // MARK: formulas

    struct FormulaCell: Equatable { var address: String; var formula: String }

    /// Parses {sheetName, {{address, formula}, ...}} from the read script.
    static func parseFormulaRead(_ v: ScriptValue) -> (sheet: String, cells: [FormulaCell])? {
        guard let top = v.list, top.count == 2, let sheet = top[0].string, let rows = top[1].list else { return nil }
        var cells: [FormulaCell] = []
        for row in rows {
            guard let pair = row.list, pair.count == 2, let a = pair[0].string, let f = pair[1].string else { return nil }
            cells.append(FormulaCell(address: a, formula: f))
        }
        return (sheet, cells)
    }

    static func readFormulas(_ c: Context) async -> Result<(sheet: String, cells: [FormulaCell]), IntegrationError> {
        switch await c.script(Scripts.Excel.readFormulas, [.int(IntegrationRunner.maxExcelCells)]) {
        case .failure(let e): return .failure(e)
        case .success(let v):
            guard let parsed = parseFormulaRead(v) else {
                return .failure(.scriptFailed(code: -2, message: "unexpected reply from Excel"))
            }
            guard !parsed.cells.isEmpty else { return .failure(.nothingToActOn("No formulas in the selection.")) }
            return .success(parsed)
        }
    }

    /// Reads the selection's formulas, rewrites them, and writes back only the cells that changed.
    static func transformFormulas(_ c: Context, _ f: (String) -> String) async -> Result<IntegrationResult, IntegrationError> {
        let read: (sheet: String, cells: [FormulaCell])
        switch await readFormulas(c) {
        case .failure(let e): return .failure(e)
        case .success(let r): read = r
        }
        return await write(c, sheet: read.sheet, changes: plan(read.cells, f))
    }

    /// Cells whose formula changes under `f`.
    static func plan(_ cells: [FormulaCell], _ f: (String) -> String) -> [FormulaCell] {
        cells.compactMap { cell in
            let new = f(cell.formula)
            return new == cell.formula ? nil : FormulaCell(address: cell.address, formula: new)
        }
    }

    static func write(_ c: Context, sheet: String, changes: [FormulaCell]) async -> Result<IntegrationResult, IntegrationError> {
        guard !changes.isEmpty else { return .success(IntegrationResult(output: "Nothing to change")) }
        let payload: [ScriptValue] = [.string(sheet), .list(changes.map { .list([.string($0.address), .string($0.formula)]) })]
        return await c.script(Scripts.Excel.writeFormulas, payload).map { _ in
            let first = changes[0].formula
            return IntegrationResult(output: changes.count == 1 ? first : "Updated \(changes.count) cells")
        }
    }

    /// Every reference in every selected formula moves to the successor of the first reference's state,
    /// so a mixed selection lines up after one press.
    static func toggleAbsolute(_ c: Context) async -> Result<IntegrationResult, IntegrationError> {
        let read: (sheet: String, cells: [FormulaCell])
        switch await readFormulas(c) {
        case .failure(let e): return .failure(e)
        case .success(let r): read = r
        }
        guard let mode = read.cells.lazy.compactMap({ A1Formula.nextMode(for: $0.formula) }).first else {
            return .failure(.nothingToActOn("The selected formulas have no cell references."))
        }
        return await write(c, sheet: read.sheet, changes: plan(read.cells) { A1Formula.apply(mode, to: $0) })
    }

    // MARK: number formats

    static func changeNumberFormat(_ c: Context, _ f: (String) -> String) async -> Result<IntegrationResult, IntegrationError> {
        let current: String
        switch await c.script(Scripts.Excel.readActiveNumberFormat) {
        case .failure(let e): return .failure(e)
        case .success(let v): current = v.string ?? "General"
        }
        let next = f(current)
        return await c.script(Scripts.Excel.setSelectionNumberFormat, [.string(next)]).map { _ in
            IntegrationResult(output: next)
        }
    }

    // MARK: templates

    static func insert(_ t: FormulaTemplate, _ c: Context) async -> Result<IntegrationResult, IntegrationError> {
        await c.script(Scripts.Excel.insertTemplate, [.string(t.formula), .bool(c.args.bool("overwrite"))]).map { _ in
            IntegrationResult(output: t.formula, followUpKeys: t.followUpKeys)
        }
    }
}
