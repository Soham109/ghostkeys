import Foundation

/// A function call that spans a whole formula, e.g. `=IFERROR(A1/B1,0)` -> name IFERROR, args ["A1/B1", "0"].
public struct FormulaCall: Equatable, Sendable {
    public var name: String
    public var arguments: [String]

    /// Parses `formula` (with or without the leading `=`) as a single top-level call. Returns nil when the
    /// formula is anything else, e.g. `=IFERROR(A1,0)+1`.
    public static func parse(_ formula: String) -> FormulaCall? {
        var body = Substring(formula.trimmingCharacters(in: .whitespaces))
        if body.first == "=" { body = body.dropFirst() }
        let c = Array(body.trimmingCharacters(in: .whitespaces))
        var i = 0
        while i < c.count, c[i].isLetter || c[i].isNumber || c[i] == "_" || c[i] == "." { i += 1 }
        guard i > 0, i < c.count, c[i] == "(" else { return nil }
        let name = String(c[0..<i])
        guard let close = matchingParen(c, open: i) else { return nil }
        guard close == c.count - 1 else { return nil }
        let args = splitTopLevel(Array(c[(i + 1)..<close]))
        return FormulaCall(name: name, arguments: args)
    }

    /// Index of the `)` that closes the `(` at `open`, skipping strings, quoted sheet names and brackets.
    static func matchingParen(_ c: [Character], open: Int) -> Int? {
        var depth = 0
        var j = open
        while j < c.count {
            let ch = c[j]
            if ch == "\"" || ch == "'" { j = A1Formula.skipQuoted(c, from: j, quote: ch); continue }
            if ch == "[" { j = A1Formula.skipBrackets(c, from: j); continue }
            if ch == "(" { depth += 1 }
            if ch == ")" { depth -= 1; if depth == 0 { return j } }
            j += 1
        }
        return nil
    }

    /// Splits an argument list on commas that are not inside parentheses, array constants, strings,
    /// quoted sheet names or brackets. `""` (no arguments) gives `[]`.
    static func splitTopLevel(_ c: [Character]) -> [String] {
        if c.allSatisfy({ $0 == " " }) { return [] }
        var parts: [String] = []
        var depth = 0
        var start = 0
        var j = 0
        while j < c.count {
            let ch = c[j]
            if ch == "\"" || ch == "'" { j = A1Formula.skipQuoted(c, from: j, quote: ch); continue }
            if ch == "[" { j = A1Formula.skipBrackets(c, from: j); continue }
            if ch == "(" || ch == "{" { depth += 1 }
            if ch == ")" || ch == "}" { depth -= 1 }
            if ch == "," && depth == 0 {
                parts.append(String(c[start..<j])); start = j + 1
            }
            j += 1
        }
        parts.append(String(c[start..<c.count]))
        return parts
    }
}

public enum IfErrorTransform {

    /// Wraps a formula in IFERROR. Constants (no leading `=`) give nil. A formula that is already one
    /// IFERROR call is returned unchanged, so repeated presses do not stack wrappers.
    public static func wrap(_ formula: String, fallback: String = "0") -> String? {
        guard isFormula(formula) else { return nil }
        if isWrapped(formula) { return formula }
        let body = String(formula.trimmingCharacters(in: .whitespaces).dropFirst())
        return "=IFERROR(" + body + "," + fallbackLiteral(fallback) + ")"
    }

    /// Removes one IFERROR wrapper that spans the whole formula. Anything else is returned unchanged.
    public static func unwrap(_ formula: String) -> String {
        guard let call = FormulaCall.parse(formula), call.name.uppercased() == "IFERROR",
              call.arguments.count == 2 else { return formula }
        let inner = call.arguments[0].trimmingCharacters(in: .whitespaces)
        guard !inner.isEmpty else { return formula }
        return "=" + inner
    }

    public static func isWrapped(_ formula: String) -> Bool {
        guard let call = FormulaCall.parse(formula) else { return false }
        return call.name.uppercased() == "IFERROR" && call.arguments.count == 2
    }

    static func isFormula(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespaces)
        return t.hasPrefix("=") && t.count > 1
    }

    /// Turns a user-supplied fallback into a safe Excel literal. Numbers and TRUE/FALSE stay as they are,
    /// `blank` or an empty string become `""`, and anything else becomes a quoted text literal, so the
    /// argument can never inject formula syntax.
    public static func fallbackLiteral(_ raw: String) -> String {
        let t = raw.trimmingCharacters(in: .whitespaces)
        if t.isEmpty || t.lowercased() == "blank" || t == "\"\"" { return "\"\"" }
        if isNumberLiteral(t) { return t }
        if t.uppercased() == "TRUE" || t.uppercased() == "FALSE" { return t.uppercased() }
        let clipped = String(t.prefix(255))
        return "\"" + clipped.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }

    static func isNumberLiteral(_ s: String) -> Bool {
        var c = Substring(s)
        if c.first == "-" { c = c.dropFirst() }
        guard !c.isEmpty else { return false }
        let parts = c.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= 2 else { return false }
        guard let ip = parts.first, !ip.isEmpty, ip.allSatisfy({ $0.isASCII && $0.isNumber }) else { return false }
        if parts.count == 2 {
            guard !parts[1].isEmpty, parts[1].allSatisfy({ $0.isASCII && $0.isNumber }) else { return false }
        }
        return true
    }
}

/// Formula skeletons for the insert-* commands. `caret` is the character offset where typing should
/// continue once the cell is in edit mode (just after the first opening parenthesis).
public struct FormulaTemplate: Equatable, Sendable {
    public var formula: String
    public var caret: Int

    public static let xlookup = FormulaTemplate(formula: "=XLOOKUP(,,)", caret: 9)
    public static let indexMatch = FormulaTemplate(formula: "=INDEX(,MATCH(,,0))", caret: 7)
    public static let sumifs = FormulaTemplate(formula: "=SUMIFS(,,)", caret: 8)

    /// Keys that put the cell into edit mode (Control-U in Excel for Mac, cursor at the end) and then walk
    /// the cursor back to `caret`.
    public var followUpKeys: [KeyStroke] {
        let lefts = max(0, formula.count - caret)
        return [KeyStroke("u", ["ctrl"])] + Array(repeating: KeyStroke("left"), count: lefts)
    }
}
