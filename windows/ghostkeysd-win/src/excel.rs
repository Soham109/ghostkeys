//! Excel integration commands, as text transforms on `ActiveCell.Formula` and `NumberFormat`.
//!
//! The Windows side talks to Excel over COM (see platform/windows/excel_com.rs); everything that
//! decides *what* to write lives here, so it is tested without Excel. `Range.Formula` always uses
//! en-US syntax (comma argument separators, A1 references) whatever the user's locale, which is why
//! these transforms can assume commas.
//!
//! Commands:
//!   wrap-iferror         =X  ->  =IFERROR(X,"")   and back again (toggle). args.fallback overrides "".
//!   unwrap-iferror       =IFERROR(X,...)  ->  =X  (only unwraps).
//!   toggle-absolute      cycles every A1 reference like F4: A1 -> $A$1 -> A$1 -> $A1 -> A1.
//!   cycle-number-format  General -> #,##0 -> #,##0.00 -> 0% -> 0.00% -> $#,##0.00 -> 0.00E+00 -> m/d/yyyy -> General.
//!   run-macro            Application.Run(args.macro): a VBA macro the user already has in the workbook.

use serde_json::{json, Map, Value};

pub const COMMANDS: [&str; 5] = ["wrap-iferror", "unwrap-iferror", "toggle-absolute", "cycle-number-format", "run-macro"];

/// Mac Excel commands (GhostkeysIntegrations) that the Windows daemon does not implement yet.
pub const NOT_YET: [&str; 11] = [
    "increase-decimals",
    "decrease-decimals",
    "color-inputs-formulas",
    "insert-xlookup",
    "insert-index-match",
    "insert-sumifs",
    "paste-values",
    "fill-down",
    "fill-right",
    "autosum",
    "trace-precedents",
];

/// The `catalog` reply, in the Mac's IntegrationCatalog shape: apps, commands, unsupported.
pub fn catalog() -> Value {
    let note = "Edits made over COM automation do not enter Excel's undo history.";
    let spec = |command: &str, title: &str, summary: &str, args: Value| {
        json!({
            "app": "excel", "command": command, "title": title, "summary": summary, "args": args,
            "destructive": false, "undoable": false, "mechanism": "com", "notes": note
        })
    };
    let mut unsupported = Map::new();
    for c in NOT_YET {
        unsupported.insert(format!("excel/{c}"), json!("not available on Windows yet"));
    }
    json!({
        "apps": [ { "key": "excel", "name": "Microsoft Excel", "bundleId": "excel.exe" } ],
        "commands": [
            spec("wrap-iferror", "Wrap in IFERROR", "Wraps the active cell's formula in IFERROR, or removes it again.",
                 json!([{ "name": "fallback", "kind": "string", "required": false, "defaultValue": "\"\"", "help": "Value shown on error" }])),
            spec("unwrap-iferror", "Remove IFERROR", "Removes an IFERROR around the active cell's formula.", json!([])),
            spec("toggle-absolute", "Cycle $ anchors", "Cycles every reference in the active cell like F4: A1, $A$1, A$1, $A1.", json!([])),
            spec("cycle-number-format", "Cycle number format", "General, #,##0, #,##0.00, 0%, 0.00%, $#,##0.00, 0.00E+00, m/d/yyyy.", json!([])),
            spec("run-macro", "Run macro", "Runs a VBA macro that is already in an open workbook (Application.Run).",
                 json!([{ "name": "macro", "kind": "string", "required": true, "help": "Macro name, e.g. Book1.xlsm!Tidy" }])),
        ],
        "unsupported": unsupported,
    })
}

/// Removes a whole-formula IFERROR; an error if there is none.
pub fn unwrap_iferror(formula: &str) -> Result<String, String> {
    let f = formula.trim();
    let body = f.strip_prefix('=').ok_or("the active cell has no formula")?.trim();
    const HEAD: &str = "IFERROR(";
    if body.len() > HEAD.len() && body[..HEAD.len()].eq_ignore_ascii_case(HEAD) && matching_paren(body, HEAD.len() - 1) == Some(body.len() - 1) {
        let inner = &body[HEAD.len()..body.len() - 1];
        if let Some(comma) = top_level_comma(inner) {
            return Ok(format!("={}", inner[..comma].trim()));
        }
    }
    Err("the formula is not wrapped in IFERROR".into())
}

pub const NUMBER_FORMATS: [&str; 8] = ["General", "#,##0", "#,##0.00", "0%", "0.00%", "$#,##0.00", "0.00E+00", "m/d/yyyy"];

/// Next format in the cycle. Anything not in the cycle goes back to General.
pub fn next_number_format(current: &str) -> &'static str {
    match NUMBER_FORMATS.iter().position(|f| f.eq_ignore_ascii_case(current)) {
        Some(i) => NUMBER_FORMATS[(i + 1) % NUMBER_FORMATS.len()],
        None => NUMBER_FORMATS[0],
    }
}

/// Byte ranges of `s` that are inside a "string" or a 'quoted sheet name' (quotes included).
fn quoted_spans(s: &str) -> Vec<(usize, usize)> {
    let b = s.as_bytes();
    let mut spans = vec![];
    let mut i = 0;
    while i < b.len() {
        let q = b[i];
        if q == b'"' || q == b'\'' {
            let start = i;
            i += 1;
            while i < b.len() {
                if b[i] == q {
                    // Doubled quote is an escaped quote inside the literal.
                    if i + 1 < b.len() && b[i + 1] == q {
                        i += 2;
                        continue;
                    }
                    break;
                }
                i += 1;
            }
            spans.push((start, (i + 1).min(b.len())));
        }
        i += 1;
    }
    spans
}

fn in_spans(spans: &[(usize, usize)], i: usize) -> bool {
    spans.iter().any(|&(a, b)| i >= a && i < b)
}

/// Index of the parenthesis that closes the one at `open`, skipping quoted text.
fn matching_paren(s: &str, open: usize) -> Option<usize> {
    let spans = quoted_spans(s);
    let mut depth = 0i32;
    for (i, c) in s.bytes().enumerate().skip(open) {
        if in_spans(&spans, i) {
            continue;
        }
        match c {
            b'(' => depth += 1,
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// First top-level comma in `s` (not inside parentheses, braces or quotes).
fn top_level_comma(s: &str) -> Option<usize> {
    let spans = quoted_spans(s);
    let mut depth = 0i32;
    for (i, c) in s.bytes().enumerate() {
        if in_spans(&spans, i) {
            continue;
        }
        match c {
            b'(' | b'{' => depth += 1,
            b')' | b'}' => depth -= 1,
            b',' if depth == 0 => return Some(i),
            _ => {}
        }
    }
    None
}

/// Wraps a formula in IFERROR, or unwraps it if it already is one.
pub fn toggle_iferror(formula: &str, fallback: Option<&str>) -> Result<String, String> {
    let f = formula.trim();
    let Some(body) = f.strip_prefix('=') else {
        return Err("the active cell has no formula".into());
    };
    let body = body.trim();
    if body.is_empty() {
        return Err("the active cell has no formula".into());
    }
    const HEAD: &str = "IFERROR(";
    if body.len() > HEAD.len() && body[..HEAD.len()].eq_ignore_ascii_case(HEAD) {
        let open = HEAD.len() - 1;
        if matching_paren(body, open) == Some(body.len() - 1) {
            let inner = &body[HEAD.len()..body.len() - 1];
            if let Some(comma) = top_level_comma(inner) {
                return Ok(format!("={}", inner[..comma].trim()));
            }
        }
    }
    let fb = fallback.unwrap_or("\"\"");
    Ok(format!("=IFERROR({body},{fb})"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefMode {
    Relative,    // A1
    Absolute,    // $A$1
    RowAbsolute, // A$1
    ColAbsolute, // $A1
}

impl RefMode {
    pub fn next(self) -> RefMode {
        match self {
            RefMode::Relative => RefMode::Absolute,
            RefMode::Absolute => RefMode::RowAbsolute,
            RefMode::RowAbsolute => RefMode::ColAbsolute,
            RefMode::ColAbsolute => RefMode::Relative,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct CellRef {
    start: usize,
    end: usize,
    col: String,
    row: String,
    mode: RefMode,
}

fn col_number(letters: &str) -> u32 {
    letters.bytes().fold(0, |n, c| n * 26 + (c.to_ascii_uppercase() - b'A' + 1) as u32)
}

/// A1-style cell references outside quotes. Skips function names (LOG10( ), defined names that
/// merely end in digits but are out of range, and anything glued to other identifier characters.
fn find_refs(s: &str) -> Vec<CellRef> {
    let b = s.as_bytes();
    let spans = quoted_spans(s);
    let is_ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'.';
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        if in_spans(&spans, i) || (i > 0 && (is_ident(b[i - 1]) || b[i - 1] == b'$')) {
            i += 1;
            continue;
        }
        let start = i;
        let mut j = i;
        let col_abs = b.get(j) == Some(&b'$');
        if col_abs {
            j += 1;
        }
        let cs = j;
        while j < b.len() && b[j].is_ascii_alphabetic() && j - cs < 3 {
            j += 1;
        }
        let col = &s[cs..j];
        let row_abs = b.get(j) == Some(&b'$');
        if row_abs {
            j += 1;
        }
        let rs = j;
        while j < b.len() && b[j].is_ascii_digit() && j - rs < 7 {
            j += 1;
        }
        let row = &s[rs..j];
        let followed_ok = j >= b.len() || !(is_ident(b[j]) || b[j] == b'(' || b[j] == b'!' || b[j] == b'$');
        let valid = !col.is_empty()
            && !row.is_empty()
            && col_number(col) <= 16_384
            && row.parse::<u32>().map(|r| (1..=1_048_576).contains(&r)).unwrap_or(false)
            && !row.starts_with('0');
        if valid && followed_ok {
            let mode = match (col_abs, row_abs) {
                (false, false) => RefMode::Relative,
                (true, true) => RefMode::Absolute,
                (false, true) => RefMode::RowAbsolute,
                (true, false) => RefMode::ColAbsolute,
            };
            out.push(CellRef { start, end: j, col: col.to_string(), row: row.to_string(), mode });
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// F4 for the whole formula: every reference moves to the mode after the first reference's mode.
pub fn toggle_absolute(formula: &str) -> Result<String, String> {
    if !formula.trim_start().starts_with('=') {
        return Err("the active cell has no formula".into());
    }
    let refs = find_refs(formula);
    let Some(first) = refs.first() else {
        return Err("the formula has no cell references".into());
    };
    let mode = first.mode.next();
    let mut out = String::with_capacity(formula.len() + refs.len() * 2);
    let mut last = 0;
    for r in &refs {
        out.push_str(&formula[last..r.start]);
        let (c, rw) = match mode {
            RefMode::Relative => ("", ""),
            RefMode::Absolute => ("$", "$"),
            RefMode::RowAbsolute => ("", "$"),
            RefMode::ColAbsolute => ("$", ""),
        };
        out.push_str(&format!("{c}{}{rw}{}", r.col, r.row));
        last = r.end;
    }
    out.push_str(&formula[last..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iferror_wraps_and_unwraps() {
        assert_eq!(toggle_iferror("=A1/B1", None).unwrap(), "=IFERROR(A1/B1,\"\")");
        assert_eq!(toggle_iferror("=IFERROR(A1/B1,\"\")", None).unwrap(), "=A1/B1");
        assert_eq!(toggle_iferror("=iferror(VLOOKUP(A1,B:C,2,FALSE),0)", None).unwrap(), "=VLOOKUP(A1,B:C,2,FALSE)");
        assert_eq!(toggle_iferror("=A1/B1", Some("0")).unwrap(), "=IFERROR(A1/B1,0)");
        // IFERROR(...) + 1 is not a whole-formula IFERROR: wrap it again.
        assert_eq!(toggle_iferror("=IFERROR(A1,0)+1", None).unwrap(), "=IFERROR(IFERROR(A1,0)+1,\"\")");
        // Commas and parentheses inside strings do not confuse it.
        assert_eq!(toggle_iferror("=IFERROR(CONCAT(\"a,)\",A1),\"x\")", None).unwrap(), "=CONCAT(\"a,)\",A1)");
        assert!(toggle_iferror("42", None).is_err());
        assert!(toggle_iferror("", None).is_err());
    }

    #[test]
    fn absolute_cycles_like_f4() {
        let f1 = toggle_absolute("=A1+B2").unwrap();
        assert_eq!(f1, "=$A$1+$B$2");
        let f2 = toggle_absolute(&f1).unwrap();
        assert_eq!(f2, "=A$1+B$2");
        let f3 = toggle_absolute(&f2).unwrap();
        assert_eq!(f3, "=$A1+$B2");
        assert_eq!(toggle_absolute(&f3).unwrap(), "=A1+B2");
    }

    #[test]
    fn absolute_skips_functions_strings_and_sheet_names() {
        assert_eq!(toggle_absolute("=LOG10(A1)").unwrap(), "=LOG10($A$1)");
        assert_eq!(toggle_absolute("=SUM(Sheet1!A1:B10)").unwrap(), "=SUM(Sheet1!$A$1:$B$10)");
        assert_eq!(toggle_absolute("='My A1 Sheet'!C3&\"B2\"").unwrap(), "='My A1 Sheet'!$C$3&\"B2\"");
        assert_eq!(toggle_absolute("=XFD1048576").unwrap(), "=$XFD$1048576");
        assert!(toggle_absolute("=XFE1").is_err(), "column past XFD is not a reference");
        assert!(toggle_absolute("=A0").is_err());
        assert!(toggle_absolute("=PI()").is_err());
        assert!(toggle_absolute("A1").is_err());
    }

    #[test]
    fn unwrap_only_unwraps() {
        assert_eq!(unwrap_iferror("=IFERROR(A1/B1,0)").unwrap(), "=A1/B1");
        assert!(unwrap_iferror("=A1/B1").is_err());
        assert!(unwrap_iferror("=IFERROR(A1,0)+1").is_err());
    }

    #[test]
    fn catalog_lists_what_windows_runs() {
        let c = catalog();
        let cmds: Vec<&str> = c["commands"].as_array().unwrap().iter().map(|x| x["command"].as_str().unwrap()).collect();
        for cmd in COMMANDS {
            assert!(cmds.contains(&cmd), "{cmd}");
        }
        assert_eq!(c["unsupported"]["excel/insert-xlookup"], "not available on Windows yet");
    }

    #[test]
    fn number_format_cycle_wraps() {
        assert_eq!(next_number_format("General"), "#,##0");
        assert_eq!(next_number_format("general"), "#,##0");
        assert_eq!(next_number_format("m/d/yyyy"), "General");
        assert_eq!(next_number_format("[Red]0.0"), "General");
        let mut f = "General";
        for _ in 0..NUMBER_FORMATS.len() {
            f = next_number_format(f);
        }
        assert_eq!(f, "General");
    }
}
