import Testing
@testable import GhostkeysIntegrations

@Suite struct A1ReferenceTests {

    func refs(_ f: String) -> [String] { A1Formula.references(in: f).map(\.text) }

    @Test func roundTripsExactly() {
        let formulas = [
            "=SUM(A1:B2)", "='My Sheet'!A1+Sheet2!$B$3", "=IF(A1>0,\"$A$1 is text\",B2)",
            "=[Book1.xlsx]Sheet1!A1", "=Table1[[#This Row],[Col A]]*2", "=LOG10(A1)", "=R1C1+RC[-1]",
            "=SUM(A:A,1:1)", "=\"unterminated", "='it''s'!C4", "={1,2;3,4}", "=A1#", "=#REF!+1",
        ]
        for f in formulas {
            #expect(A1Formula.tokenize(f).map(\.text).joined() == f, "\(f)")
        }
    }

    @Test func findsCellsAndRanges() {
        #expect(refs("=SUM(A1:B2)") == ["A1", "B2"])
        #expect(refs("=$A$1+A$1+$A1+a1") == ["$A$1", "A$1", "$A1", "a1"])
        #expect(refs("=XFD1048576+XFE1+A1048577+A0") == ["XFD1048576"])
    }

    @Test func crossSheetReferences() {
        #expect(refs("='My Sheet'!A1") == ["A1"])
        #expect(refs("='Q1 $A$1 data'!B2") == ["B2"])      // $ inside the quoted sheet name is untouched
        #expect(refs("=Sheet2!C3:D4") == ["C3", "D4"])
        #expect(refs("='it''s'!C4") == ["C4"])
        #expect(refs("=[Book1.xlsx]Sheet1!A1") == ["A1"])
        #expect(refs("=SUM(Sheet1:Sheet3!A1)") == ["A1"])
        #expect(refs("=SUM(Jan:Mar!B2)") == ["B2"])        // 3-D sheet span, not a column range
        #expect(refs("=Q1!A1") == ["A1"])                   // sheet named like a cell
    }

    @Test func wholeColumnsAndRows() {
        #expect(refs("=SUM(A:A)") == ["A", "A"])
        #expect(refs("=SUM($B:$D)") == ["$B", "$D"])
        #expect(refs("=SUM(1:1)") == ["1", "1"])
        #expect(refs("=SUM($3:5)") == ["$3", "5"])
        #expect(refs("=A") == [])                           // a lone name is not a column
        #expect(refs("=SUM(A:1)") == [])
    }

    @Test func skipsStringsFunctionsAndNames() {
        #expect(refs("=IF(A1,\"$A$1\",\"B2\")") == ["A1"])
        #expect(refs("=\"say \"\"A1\"\"\"&B2") == ["B2"])
        #expect(refs("=LOG10(A1)") == ["A1"])               // LOG10 looks like a cell but is a function
        #expect(refs("=ATAN2(1,2)") == [])
        #expect(refs("=_xlfn.XLOOKUP(A1,B:B,C:C)") == ["A1", "B", "B", "C", "C"])
        #expect(refs("=TRUE+my_name+TAXRATE") == [])
        #expect(refs("=Table1[Col1]+Table1[[#Headers],[A1]]") == [])
        #expect(refs("=1E5+1.5") == [])
        #expect(refs("=#REF!+#N/A") == [])
    }

    @Test func r1c1IsNotSupportedAndLeftAlone() {
        #expect(refs("=R1C1") == [])
        #expect(refs("=RC[-1]+R[2]C3") == [])
        #expect(A1Formula.cycleAbsolute("=R1C1+RC[-1]") == "=R1C1+RC[-1]")
    }

    @Test func nestedFunctions() {
        let f = "=IFERROR(INDEX($B:$B,MATCH(A2,Sheet2!$A$1:$A$100,0)),\"n/a $1\")"
        #expect(refs(f) == ["$B", "$B", "A2", "$A$1", "$A$100"])
    }

    @Test func cycleOrderMatchesF4() {
        var f = "=A1"
        var seen: [String] = []
        for _ in 0..<4 { f = A1Formula.cycleAbsolute(f); seen.append(f) }
        #expect(seen == ["=$A$1", "=A$1", "=$A1", "=A1"])
    }

    @Test func cycleAppliesFirstReferenceStateToAll() {
        #expect(A1Formula.cycleAbsolute("=A1+$B$2") == "=$A$1+$B$2")
        #expect(A1Formula.cycleAbsolute("=$A$1+B2") == "=A$1+B$2")
        #expect(A1Formula.cycleAbsolute("=SUM(A1:B2)") == "=SUM($A$1:$B$2)")
        #expect(A1Formula.cycleAbsolute("=\"$A$1\"&A1") == "=\"$A$1\"&$A$1")
        #expect(A1Formula.cycleAbsolute("='My $Sheet'!A1") == "='My $Sheet'!$A$1")
    }

    @Test func wholeColumnsAndRowsToggle() {
        #expect(A1Formula.cycleAbsolute("=SUM(A:A)") == "=SUM($A:$A)")
        #expect(A1Formula.cycleAbsolute("=SUM($A:$A)") == "=SUM(A:A)")
        #expect(A1Formula.cycleAbsolute("=SUM(1:1)") == "=SUM($1:$1)")
        #expect(A1Formula.cycleAbsolute("=SUM($1:$1)") == "=SUM(1:1)")
    }

    @Test func fourPressesReturnToStart() {
        for f in ["=A1*$B$2+SUM(C:C)", "=Sheet1!$A1/'x y'!B$9", "=SUM(1:3)+A1"] {
            // After the first press all references share one state, so four more presses return there.
            let once = A1Formula.cycleAbsolute(f)
            var g = once
            for _ in 0..<4 { g = A1Formula.cycleAbsolute(g) }
            #expect(g == once, "\(f)")
        }
    }

    @Test func formulasWithoutReferencesAreUnchanged() {
        #expect(A1Formula.cycleAbsolute("=1+2") == "=1+2")
        #expect(A1Formula.cycleAbsolute("=\"A1\"") == "=\"A1\"")
        #expect(A1Formula.nextMode(for: "=NOW()") == nil)
    }
}

@Suite struct IfErrorTests {
    @Test func wrapsWithFallback() {
        #expect(IfErrorTransform.wrap("=A1/B1") == "=IFERROR(A1/B1,0)")
        #expect(IfErrorTransform.wrap("=A1/B1", fallback: "blank") == "=IFERROR(A1/B1,\"\")")
        #expect(IfErrorTransform.wrap("=A1/B1", fallback: "-1.5") == "=IFERROR(A1/B1,-1.5)")
        #expect(IfErrorTransform.wrap("=A1/B1", fallback: "false") == "=IFERROR(A1/B1,FALSE)")
        #expect(IfErrorTransform.wrap("=A1/B1", fallback: "n/a") == "=IFERROR(A1/B1,\"n/a\")")
    }

    @Test func fallbackCannotInjectFormula() {
        #expect(IfErrorTransform.wrap("=A1", fallback: "0),HYPERLINK(\"x\"") == "=IFERROR(A1,\"0),HYPERLINK(\"\"x\"\"\")")
        #expect(IfErrorTransform.fallbackLiteral("=CMD()") == "\"=CMD()\"")
        #expect(IfErrorTransform.fallbackLiteral("1e5") == "\"1e5\"")
    }

    @Test func constantsAreNotWrapped() {
        #expect(IfErrorTransform.wrap("42") == nil)
        #expect(IfErrorTransform.wrap("=") == nil)
    }

    @Test func wrapIsIdempotent() {
        for f in ["=A1/B1", "=VLOOKUP(A1,B:C,2,FALSE)", "=IFERROR(A1,0)+1"] {
            let once = IfErrorTransform.wrap(f)!
            #expect(IfErrorTransform.wrap(once) == once, "\(f)")
        }
        // A formula that merely contains IFERROR is still wrapped once.
        #expect(IfErrorTransform.wrap("=IFERROR(A1,0)+1") == "=IFERROR(IFERROR(A1,0)+1,0)")
    }

    @Test func unwrapInvertsWrap() {
        for f in ["=A1/B1", "=SUM(A1:A3)", "=IF(A1=\"x,y\",B1,C1)", "=INDEX(A:A,MATCH(1,{1,2},0))", "='a,b'!A1"] {
            #expect(IfErrorTransform.unwrap(IfErrorTransform.wrap(f)!) == f, "\(f)")
        }
    }

    @Test func unwrapIsIdempotentOnUnwrapped() {
        for f in ["=A1/B1", "=IFERROR(A1,0)+1", "=IFERROR(A1)", "42", "=SUM(IFERROR(A1,0))"] {
            #expect(IfErrorTransform.unwrap(f) == f, "\(f)")
        }
    }

    @Test func unwrapHandlesCaseSpacesAndNesting() {
        #expect(IfErrorTransform.unwrap("=iferror( A1/B1 , 0 )") == "=A1/B1")
        #expect(IfErrorTransform.unwrap("=IFERROR(IFERROR(A1,0),\"\")") == "=IFERROR(A1,0)")
        #expect(IfErrorTransform.unwrap("=IFERROR(A1,\"a)b\")") == "=A1")
    }

    @Test func callParser() {
        #expect(FormulaCall.parse("=SUM(A1,B1)") == FormulaCall(name: "SUM", arguments: ["A1", "B1"]))
        #expect(FormulaCall.parse("=NOW()") == FormulaCall(name: "NOW", arguments: []))
        #expect(FormulaCall.parse("=SUM(A1)+1") == nil)
        #expect(FormulaCall.parse("=X({1,2},\"a,b\",'s,t'!A1,T[[#All],[a,b]])")?.arguments.count == 4)
    }
}

@Suite struct TemplateTests {
    @Test func caretLandsAfterFirstParen() {
        for t in [FormulaTemplate.xlookup, .indexMatch, .sumifs] {
            let chars = Array(t.formula)
            #expect(chars[t.caret - 1] == "(", "\(t.formula)")
            #expect(t.followUpKeys.first == KeyStroke("u", ["ctrl"]))
            #expect(t.followUpKeys.count - 1 == t.formula.count - t.caret)
            #expect(t.followUpKeys.dropFirst().allSatisfy { $0 == KeyStroke("left") })
        }
        #expect(FormulaTemplate.xlookup.followUpKeys.count == 4)   // ctrl-u, then 3 lefts past ",,)"
    }
}
