import Foundation

/// One A1-style reference found inside a formula: a cell (`$A$1`), a whole column (`A`, as in `A:A`)
/// or a whole row (`1`, as in `1:1`). A range such as `A1:B2` is two references joined by `:` text.
public struct A1Reference: Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case cell, column, row }

    public var kind: Kind
    public var column: String      // letters as written ("" for a row reference)
    public var row: String         // digits as written ("" for a column reference)
    public var columnAbsolute: Bool
    public var rowAbsolute: Bool

    public var text: String {
        var s = ""
        if kind != .row { s += (columnAbsolute ? "$" : "") + column }
        if kind != .column { s += (rowAbsolute ? "$" : "") + row }
        return s
    }

    /// The anchoring state this reference is in. Whole-column and whole-row references only have one
    /// meaningful anchor, so they report a state whose successor flips that anchor.
    public var mode: AnchorMode {
        switch kind {
        case .cell:
            switch (columnAbsolute, rowAbsolute) {
            case (true, true): return .absolute
            case (false, true): return .rowAbsolute
            case (true, false): return .columnAbsolute
            case (false, false): return .relative
            }
        case .column: return columnAbsolute ? .columnAbsolute : .relative
        case .row: return rowAbsolute ? .rowAbsolute : .relative
        }
    }

    public func with(mode: AnchorMode) -> A1Reference {
        var r = self
        r.columnAbsolute = (mode == .absolute || mode == .columnAbsolute)
        r.rowAbsolute = (mode == .absolute || mode == .rowAbsolute)
        return r
    }

    // MARK: parsing one token

    static let maxRow = 1_048_576

    /// Parses a whole token (no surrounding text) as a cell reference, or nil.
    static func cell(_ token: String) -> A1Reference? {
        let c = Array(token)
        var i = 0
        let colAbs = i < c.count && c[i] == "$"
        if colAbs { i += 1 }
        let colStart = i
        while i < c.count, c[i].isASCII, c[i].isLetter { i += 1 }
        let col = String(c[colStart..<i])
        let rowAbs = i < c.count && c[i] == "$"
        if rowAbs { i += 1 }
        let rowStart = i
        while i < c.count, c[i].isASCII, c[i].isNumber { i += 1 }
        let row = String(c[rowStart..<i])
        guard i == c.count, validColumn(col), validRow(row) else { return nil }
        return A1Reference(kind: .cell, column: col, row: row, columnAbsolute: colAbs, rowAbsolute: rowAbs)
    }

    static func columnOnly(_ token: String) -> A1Reference? {
        var t = Substring(token)
        let abs = t.first == "$"
        if abs { t = t.dropFirst() }
        guard t.allSatisfy({ $0.isASCII && $0.isLetter }), validColumn(String(t)) else { return nil }
        return A1Reference(kind: .column, column: String(t), row: "", columnAbsolute: abs, rowAbsolute: false)
    }

    static func rowOnly(_ token: String) -> A1Reference? {
        var t = Substring(token)
        let abs = t.first == "$"
        if abs { t = t.dropFirst() }
        guard t.allSatisfy({ $0.isASCII && $0.isNumber }), validRow(String(t)) else { return nil }
        return A1Reference(kind: .row, column: "", row: String(t), columnAbsolute: false, rowAbsolute: abs)
    }

    /// Columns run A through XFD (16,384 columns).
    static func validColumn(_ s: String) -> Bool {
        guard (1...3).contains(s.count), s.allSatisfy({ $0.isASCII && $0.isLetter }) else { return false }
        var n = 0
        for ch in s.uppercased().unicodeScalars { n = n * 26 + Int(ch.value - 64) }
        return n <= 16_384
    }

    static func validRow(_ s: String) -> Bool {
        guard let first = s.first, first != "0", s.count <= 7, let n = Int(s) else { return false }
        return n >= 1 && n <= maxRow
    }
}

/// The four anchoring states F4 cycles through in Excel.
public enum AnchorMode: CaseIterable, Sendable {
    case absolute        // $A$1
    case rowAbsolute     // A$1
    case columnAbsolute  // $A1
    case relative        // A1

    /// $A$1 -> A$1 -> $A1 -> A1 -> $A$1
    public var next: AnchorMode {
        switch self {
        case .absolute: return .rowAbsolute
        case .rowAbsolute: return .columnAbsolute
        case .columnAbsolute: return .relative
        case .relative: return .absolute
        }
    }
}

/// A formula split into plain text and A1 references. Joining the pieces gives back the exact input.
public enum FormulaPiece: Equatable, Sendable {
    case text(String)
    case reference(A1Reference)

    public var text: String {
        switch self {
        case .text(let s): return s
        case .reference(let r): return r.text
        }
    }
}

/// Tokenizer and transformer for A1-style formulas as Excel's `formula` / `formula2` properties return them
/// (English function names, comma separators).
///
/// Skips string literals (`"a$1"`), quoted sheet names (`'My Sheet'!`), unquoted sheet and workbook prefixes,
/// bracketed parts (`[Book.xlsx]`, `Table1[Col]`, R1C1 offsets), function names (`LOG10(`) and defined names.
/// R1C1 notation is not supported: tokens like `R1C1` are left untouched.
public enum A1Formula {

    public static func tokenize(_ formula: String) -> [FormulaPiece] {
        let c = Array(formula)
        var out: [FormulaPiece] = []
        var text = ""
        func flush() { if !text.isEmpty { out.append(.text(text)); text = "" } }

        var i = 0
        while i < c.count {
            let ch = c[i]
            if ch == "\"" || ch == "'" {
                let end = skipQuoted(c, from: i, quote: ch)
                text += String(c[i..<end]); i = end
            } else if ch == "[" {
                let end = skipBrackets(c, from: i)
                text += String(c[i..<end]); i = end
            } else if isRunChar(ch) {
                let end = runEnd(c, from: i)
                let token = String(c[i..<end])
                let after: Character? = end < c.count ? c[end] : nil

                // A run glued to a following "(" is a function, "!" is a sheet, "[" is a table name.
                // One glued to a preceding "]" is R1C1 (R[2]C3) or a workbook prefix, never an A1 reference.
                let before: Character? = i > 0 ? c[i - 1] : nil
                if after == "(" || after == "!" || after == "[" || before == "]" {
                    text += token; i = end; continue
                }
                if let ref = A1Reference.cell(token) {
                    flush(); out.append(.reference(ref)); i = end; continue
                }
                // Whole columns / rows only count as references in a pair: A:A, $B:$D, 1:1, $3:5.
                if after == ":", end + 1 < c.count, isRunChar(c[end + 1]) {
                    let end2 = runEnd(c, from: end + 1)
                    let token2 = String(c[(end + 1)..<end2])
                    let after2: Character? = end2 < c.count ? c[end2] : nil
                    let glued = after2 == "(" || after2 == "!" || after2 == "["
                    if !glued {
                        if let a = A1Reference.columnOnly(token), let b = A1Reference.columnOnly(token2) {
                            flush(); out.append(.reference(a)); out.append(.text(":")); out.append(.reference(b))
                            i = end2; continue
                        }
                        if let a = A1Reference.rowOnly(token), let b = A1Reference.rowOnly(token2) {
                            flush(); out.append(.reference(a)); out.append(.text(":")); out.append(.reference(b))
                            i = end2; continue
                        }
                    }
                }
                text += token; i = end
            } else {
                text.append(ch); i += 1
            }
        }
        flush()
        return merged(out)
    }

    public static func references(in formula: String) -> [A1Reference] {
        tokenize(formula).compactMap { if case .reference(let r) = $0 { return r } else { return nil } }
    }

    /// Rewrites every reference to the given anchoring state.
    public static func apply(_ mode: AnchorMode, to formula: String) -> String {
        tokenize(formula).map { piece -> String in
            if case .reference(let r) = piece { return r.with(mode: mode).text }
            return piece.text
        }.joined()
    }

    /// The state the next F4-style press should move to, taken from the first reference in the formula.
    public static func nextMode(for formula: String) -> AnchorMode? {
        references(in: formula).first?.mode.next
    }

    /// One F4-style press over the whole formula: every reference moves to the successor of the first
    /// reference's state, so mixed formulas converge to one state. Formulas without references are unchanged.
    public static func cycleAbsolute(_ formula: String) -> String {
        guard let mode = nextMode(for: formula) else { return formula }
        return apply(mode, to: formula)
    }

    // MARK: scanning helpers (shared with FormulaCall)

    /// Characters that make up names, numbers and references.
    static func isRunChar(_ ch: Character) -> Bool {
        ch.isLetter || ch.isNumber || ch == "_" || ch == "." || ch == "$" || ch == "\\" || ch == "?"
    }

    static func runEnd(_ c: [Character], from start: Int) -> Int {
        var j = start
        while j < c.count, isRunChar(c[j]) { j += 1 }
        return j
    }

    /// Index just past a quoted section starting at `from`. A doubled quote is an escaped quote.
    /// An unterminated quote runs to the end.
    static func skipQuoted(_ c: [Character], from start: Int, quote: Character) -> Int {
        var j = start + 1
        while j < c.count {
            if c[j] == quote {
                if j + 1 < c.count, c[j + 1] == quote { j += 2; continue }
                return j + 1
            }
            j += 1
        }
        return c.count
    }

    /// Index just past a balanced `[...]` section (nesting allowed, as in `Table1[[#This Row],[Col]]`).
    static func skipBrackets(_ c: [Character], from start: Int) -> Int {
        var depth = 0
        var j = start
        while j < c.count {
            if c[j] == "[" { depth += 1 }
            else if c[j] == "]" { depth -= 1; if depth == 0 { return j + 1 } }
            else if c[j] == "'" && depth > 0, j + 1 < c.count {
                // In structured references ' escapes the next character.
                j += 2; continue
            }
            j += 1
        }
        return c.count
    }

    private static func merged(_ pieces: [FormulaPiece]) -> [FormulaPiece] {
        var out: [FormulaPiece] = []
        for p in pieces {
            if case .text(let t) = p, case .text(let prev)? = out.last {
                out[out.count - 1] = .text(prev + t)
            } else {
                out.append(p)
            }
        }
        return out
    }
}
