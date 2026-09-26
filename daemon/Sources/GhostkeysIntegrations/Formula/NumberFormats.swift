import Foundation

public enum NumberFormatCycle {
    /// The formats cycle-number-format steps through, in order.
    public static let formats = ["General", "#,##0", "#,##0.0%", "0.0\"x\"", "$#,##0"]

    /// The format after `current`. A format that is not in the list moves to `#,##0`.
    public static func next(after current: String) -> String {
        let key = normalized(current)
        if let i = formats.firstIndex(where: { normalized($0) == key }) {
            return formats[(i + 1) % formats.count]
        }
        return formats[1]
    }

    /// Excel may hand back `0.0"x"` as `0.0x` or `0.0\x`, and `General` in any case.
    static func normalized(_ f: String) -> String {
        f.replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "\\", with: "").lowercased()
    }
}

public enum DecimalPlaces {
    public static let maxDecimals = 15

    /// Adds (`delta` > 0) or removes (`delta` < 0) one decimal place in every section of a number format,
    /// the way Excel's Increase/Decrease Decimal buttons do. Text in quotes, escaped characters, `[...]`
    /// codes and padding (`_x`, `*x`) are left alone. Formats with no digit placeholders (dates, text)
    /// come back unchanged.
    public static func adjust(_ format: String, by delta: Int) -> String {
        if format.trimmingCharacters(in: .whitespaces).lowercased() == "general" || format.isEmpty {
            return delta > 0 ? "0.0" : "0"
        }
        return splitSections(format).map { adjustSection($0, delta: delta) }.joined(separator: ";")
    }

    static func splitSections(_ f: String) -> [String] {
        let c = Array(f)
        var out: [String] = []
        var cur = ""
        var i = 0
        while i < c.count {
            let ch = c[i]
            if ch == "\"" {
                let end = A1Formula.skipQuoted(c, from: i, quote: "\"")
                cur += String(c[i..<end]); i = end; continue
            }
            if ch == "\\" || ch == "_" || ch == "*" {
                cur += String(c[i..<min(i + 2, c.count)]); i += 2; continue
            }
            if ch == "[" {
                let end = c[i...].firstIndex(of: "]").map { $0 + 1 } ?? c.count
                cur += String(c[i..<end]); i = end; continue
            }
            if ch == ";" { out.append(cur); cur = ""; i += 1; continue }
            cur.append(ch); i += 1
        }
        out.append(cur)
        return out
    }

    static func adjustSection(_ s: String, delta: Int) -> String {
        let c = Array(s)
        let placeholders: Set<Character> = ["0", "#", "?"]
        var i = 0
        while i < c.count {
            let ch = c[i]
            if ch == "\"" { i = A1Formula.skipQuoted(c, from: i, quote: "\""); continue }
            if ch == "\\" || ch == "_" || ch == "*" { i += 2; continue }
            if ch == "[" { i = c[i...].firstIndex(of: "]").map { $0 + 1 } ?? c.count; continue }
            let startsNumber = placeholders.contains(ch)
                || (ch == "." && i + 1 < c.count && placeholders.contains(c[i + 1]))
            if !startsNumber { i += 1; continue }

            // The first number in the section: integer part, then optional "." and decimal placeholders.
            var j = i
            while j < c.count, placeholders.contains(c[j]) || c[j] == "," { j += 1 }
            let dot: Int? = (j < c.count && c[j] == ".") ? j : nil
            var decimals = 0
            if let d = dot {
                j = d + 1
                while j < c.count, placeholders.contains(c[j]) { j += 1; decimals += 1 }
            }
            let head = String(c[0..<i])
            let intPart = String(c[i..<(dot ?? j)])
            let decPart = dot.map { String(c[($0 + 1)..<j]) } ?? ""
            let tail = String(c[j..<c.count])

            if delta > 0 {
                guard decimals < maxDecimals else { return s }
                let digit = decPart.last.map(String.init) ?? "0"
                return head + intPart + "." + decPart + digit + tail
            } else {
                guard decimals > 0 else { return s }
                let kept = String(decPart.dropLast())
                return head + intPart + (kept.isEmpty ? "" : "." + kept) + tail
            }
        }
        return s
    }
}

public enum MarkdownLink {
    /// `[title](url)` with the characters that would break Markdown escaped. An empty title uses the URL.
    public static func make(title: String, url: String) -> String {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let shownTitle = t.isEmpty ? url : t
        var escapedTitle = ""
        for ch in shownTitle {
            if ch == "\\" || ch == "[" || ch == "]" { escapedTitle.append("\\") }
            escapedTitle.append(ch == "\n" ? " " : ch)
        }
        var escapedURL = ""
        for ch in url {
            switch ch {
            case " ": escapedURL += "%20"
            case "(": escapedURL += "%28"
            case ")": escapedURL += "%29"
            case "<": escapedURL += "%3C"
            case ">": escapedURL += "%3E"
            default: escapedURL.append(ch)
            }
        }
        return "[\(escapedTitle)](\(escapedURL))"
    }
}

public enum URLArgument {
    /// Accepts http and https URLs. A bare host like `example.com/path` gets `https://` in front.
    /// Everything else (file:, javascript:, custom schemes) is rejected.
    public static func validate(_ raw: String) -> URL? {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !t.contains(where: { $0.isWhitespace }) else { return nil }
        var candidate = t
        if !t.contains("://") {
            guard t.contains(".") else { return nil }
            candidate = "https://" + t
        }
        guard let url = URL(string: candidate), let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https", let host = url.host, !host.isEmpty,
              url.user == nil else { return nil }
        return url
    }
}
