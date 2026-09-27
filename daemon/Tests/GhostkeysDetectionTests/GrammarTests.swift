import Testing
@testable import GhostkeysDetection

/// Drives the grammar the way the engine does: taps arrive ~80 ms after their onset, and the
/// clock ticks every millisecond in between.
struct GrammarDriver {
    var grammar = GestureGrammar()
    var now = 0.0
    var out: [GestureEvent] = []
    let delay = 0.08

    init(multi: Set<String> = [], window: Double = 0.35) {
        grammar.zonesNeedingMultiTap = multi
        grammar.doubleWindow = window
    }

    /// Feeds taps (zone, onset time) and runs the clock until `until`.
    mutating func play(_ taps: [(String, Double)], until: Double) {
        var queue = taps.sorted { $0.1 < $1.1 }
        while now <= until {
            while let first = queue.first, first.1 + delay <= now {
                queue.removeFirst()
                out += grammar.accept(TapEvent(t: first.1, zone: first.0, confidence: 0.95, x: 0.5, y: 0.5, strength: 0.5, modifiers: []))
            }
            let inFlight = queue.first.map { $0.1 <= now ? $0.1 : nil } ?? nil
            out += grammar.tick(now: now, oldestInFlight: inFlight)
            now += 0.001
        }
    }

    var names: [String] { out.map(\.gesture) }
}

@Suite struct GrammarTests {
    @Test func immediateTapForZonesWithoutMultiTap() {
        var d = GrammarDriver(multi: ["right-grille"])
        d.play([("left-palm", 1.0)], until: 1.2)
        #expect(d.names == ["tap"])
        #expect(d.out[0].zone == "left-palm")
    }

    @Test func singleTapWaitsForWindowInMultiTapZones() {
        var d = GrammarDriver(multi: ["left-palm"])
        d.play([("left-palm", 1.0)], until: 1.3)
        #expect(d.names.isEmpty)            // window (350 ms) still open
        d.play([], until: 1.5)
        #expect(d.names == ["tap"])
    }

    @Test func doubleTap() {
        var d = GrammarDriver(multi: ["left-palm"])
        d.play([("left-palm", 1.0), ("left-palm", 1.2)], until: 2.5)
        #expect(d.names == ["double"])
        #expect(d.out[0].zones == ["left-palm"])
    }

    @Test func doubleTapGapLimits() {
        // 60 ms apart: one tap (bounce). 400 ms apart: two single taps.
        var d = GrammarDriver(multi: ["z"])
        d.play([("z", 1.0), ("z", 1.06)], until: 2)
        #expect(d.names == ["tap"])
        var e = GrammarDriver(multi: ["z"])
        e.play([("z", 1.0), ("z", 1.4)], until: 3)
        #expect(e.names == ["tap", "tap"])
    }

    @Test func secondTapArrivingLateStillCountsAsDouble() {
        // Gap 340 ms: the second tap is only classified at 1.42 s, after the window "deadline" of
        // 1.35 s. The grammar must wait because that spike started inside the window.
        var d = GrammarDriver(multi: ["z"])
        d.play([("z", 1.0), ("z", 1.34)], until: 2.5)
        #expect(d.names == ["double"])
    }

    @Test func doubleWindowFollowsSettings() {
        var d = GrammarDriver(multi: ["z"], window: 0.5)
        d.play([("z", 1.0), ("z", 1.45)], until: 3)
        #expect(d.names == ["double"])
    }

    @Test func tripleTapIsEmittedAtTheThirdTap() {
        var d = GrammarDriver(multi: ["z"])
        d.play([("z", 1.0), ("z", 1.2), ("z", 1.4)], until: 1.49)
        #expect(d.names == ["triple"])
        d.play([], until: 3)
        #expect(d.names == ["triple"])
    }

    @Test func sequenceOfTwoZones() {
        var d = GrammarDriver(multi: ["a", "b"])
        d.play([("a", 1.0), ("b", 1.3)], until: 2.5)
        #expect(d.names == ["sequence"])
        #expect(d.out[0].zones == ["a", "b"])
        // Too slow: two taps.
        var e = GrammarDriver(multi: ["a", "b"])
        e.play([("a", 1.0), ("b", 1.6)], until: 3)
        #expect(e.names == ["tap", "tap"])
    }

    @Test func sequenceWithImmediateZones() {
        var d = GrammarDriver()
        d.play([("a", 1.0), ("b", 1.2)], until: 2)
        #expect(d.names == ["tap", "tap", "sequence"])
        #expect(d.out[2].zones == ["a", "b"])
    }

    @Test func rhythm() {
        var d = GrammarDriver(multi: ["z"])
        // tap, pause 600 ms, double
        d.play([("z", 1.0), ("z", 1.6), ("z", 1.8)], until: 3)
        #expect(d.names == ["tap", "rhythm"])
        // Pause too long (1.2 s): tap, then an ordinary double.
        var e = GrammarDriver(multi: ["z"])
        e.play([("z", 1.0), ("z", 2.2), ("z", 2.4)], until: 4)
        #expect(e.names == ["tap", "double"])
    }

    @Test func differentZoneClosesPendingGroup() {
        var d = GrammarDriver(multi: ["a"])
        d.play([("a", 1.0), ("a", 1.2), ("b", 1.4)], until: 3)
        #expect(d.names == ["double", "tap"])
    }
}

@Suite struct EngineGrammarTests {
    static let zones: [ZoneSpec] = [.leftPalm, .rightPalm, .rightGrille, .topStrip]
    static let model: ZoneModel = {
        let cal = captureCalibration(zones: zones, perZone: 15, keystrokes: 30)
        let t = Trainer()
        for (f, l) in zip(cal.features, cal.labels) { t.add(f, label: l) }
        return t.train().0
    }()

    func engine(multi: Set<String>) -> TapEngine {
        let e = TapEngine(settings: DetectionSettings())
        e.model = Self.model
        e.zonesNeedingMultiTap = multi
        return e
    }

    @Test func immediateEmitHasLowLatency() {
        var b = StreamBuilder(seconds: 3, seed: 61)
        let t0 = b.addTap(.rightGrille, at: 1.0, amp: 0.2)
        let events = run(engine(multi: ["left-palm"]), b.samples())
        let taps = events.taps
        #expect(taps.count == 1 && taps.first?.zone == "right-grille")
        let g = events.gestures
        #expect(g.map(\.g.gesture) == ["tap"])
        if let at = g.first?.at {
            #expect(at - t0 < 0.15, "emitted \((at - t0) * 1000) ms after the tap")
        }
    }

    @Test func multiTapZoneWaitsThenEmitsDouble() {
        var b = StreamBuilder(seconds: 3, seed: 62)
        let t0 = b.addTap(.rightGrille, at: 1.0, amp: 0.2)
        b.addTap(.rightGrille, at: 1.2, amp: 0.2)
        let events = run(engine(multi: ["right-grille"]), b.samples())
        #expect(events.taps.count == 2)
        let g = events.gestures
        #expect(g.map(\.g.gesture) == ["double"])
        #expect((g.first?.at ?? 0) - t0 > 0.2 + 0.35 - 0.01)   // after the window closed
    }

    @Test func singleTapInMultiTapZoneEmitsAfterWindow() {
        var b = StreamBuilder(seconds: 3, seed: 63)
        let t0 = b.addTap(.leftPalm, at: 1.0, amp: 0.2)
        let events = run(engine(multi: ["left-palm"]), b.samples())
        let g = events.gestures
        #expect(g.map(\.g.gesture) == ["tap"])
        #expect((g.first?.at ?? 0) - t0 >= 0.35)
    }

    @Test func tripleAndModifiersThroughEngine() {
        var b = StreamBuilder(seconds: 3, seed: 64)
        for k in 0..<3 { b.addTap(.topStrip, at: 1.0 + Double(k) * 0.18, amp: 0.2) }
        let input = InputScript(modifiers: ["shift"])
        let events = run(engine(multi: ["top-strip"]), b.samples(), input: input)
        #expect(events.gestures.map(\.g.gesture) == ["triple"])
        #expect(events.gestures.first?.g.modifiers == ["shift"])
        #expect(events.taps.allSatisfy { $0.modifiers == ["shift"] })
    }

    @Test func keystrokesDoNotBecomeTaps() {
        // Even with the typing gate unable to help (no key events reported), keystroke spikes are
        // classified as none and rejected with low_confidence.
        var b = StreamBuilder(seconds: 8, seed: 65)
        for k in 0..<20 { b.addKeystroke(at: 1 + Double(k) * 0.3) }
        let events = run(engine(multi: []), b.samples())
        #expect(events.taps.count <= 1, "\(events.taps.map(\.zone))")
        #expect(events.gestures.count <= 1)
    }
}

@Suite struct WeakFollowUpTests {
    func tap(_ zone: String, _ t: Double, _ conf: Double) -> TapEvent {
        TapEvent(t: t, zone: zone, confidence: conf, x: 0.5, y: 0.5, strength: 0.5, modifiers: [])
    }

    @Test func strongThenWeakMakesADouble() {
        var g = GestureGrammar()
        g.zonesNeedingMultiTap = ["z"]
        #expect(g.accept(tap("z", 1.0, 0.95)).isEmpty)
        let (absorbed, out) = g.acceptWeak(tap("z", 1.2, 0.6))
        #expect(absorbed && out.isEmpty)
        #expect(g.tick(now: 2, oldestInFlight: nil).map(\.gesture) == ["double"])
    }

    @Test func weakTapNeverStartsAGroup() {
        var g = GestureGrammar()
        g.zonesNeedingMultiTap = ["z"]
        let (absorbed, _) = g.acceptWeak(tap("z", 1.0, 0.6))
        #expect(!absorbed)
        #expect(g.accept(tap("z", 1.2, 0.95)).isEmpty)
        #expect(g.tick(now: 2, oldestInFlight: nil).map(\.gesture) == ["tap"])
    }

    /// Real desk junk read as another grille at 0.5 to 0.8 must not break a real double apart.
    @Test func weakJunkFromAnotherZoneDoesNotBreakADouble() {
        var g = GestureGrammar()
        g.zonesNeedingMultiTap = ["right-grille", "left-grille"]
        _ = g.accept(tap("right-grille", 1.0, 0.95))
        let (absorbed, out) = g.acceptWeak(tap("left-grille", 1.1, 0.7))
        #expect(!absorbed && out.isEmpty)
        #expect(g.accept(tap("right-grille", 1.25, 0.9)).isEmpty)
        #expect(g.tick(now: 2, oldestInFlight: nil).map(\.gesture) == ["double"])
    }

    @Test func weakTapsAloneNeverFire() {
        var g = GestureGrammar()
        g.zonesNeedingMultiTap = ["z"]
        _ = g.acceptWeak(tap("z", 1.0, 0.6))
        _ = g.acceptWeak(tap("z", 1.2, 0.6))
        #expect(g.tick(now: 2, oldestInFlight: nil).isEmpty)
        var h = GestureGrammar()
        h.zonesNeedingMultiTap = ["z"]
        let (_, out) = h.acceptWeak(tap("z", 1.0, 0.6))
        _ = h.acceptWeak(tap("z", 1.2, 0.6))
        let (_, out3) = h.acceptWeak(tap("z", 1.4, 0.6))
        #expect(out.isEmpty && out3.isEmpty)
    }

    @Test func weakTapInImmediateZoneIsIgnored() {
        var g = GestureGrammar()
        g.zonesNeedingMultiTap = ["other"]
        let (absorbed, out) = g.acceptWeak(tap("z", 1.0, 0.6))
        #expect(!absorbed && out.isEmpty)
        #expect(g.tick(now: 2, oldestInFlight: nil).isEmpty)
    }

    @Test func weakTapOfAnotherZoneDoesNotBreakASequence() {
        var g = GestureGrammar()
        g.zonesNeedingMultiTap = ["a", "b", "c"]
        _ = g.accept(tap("a", 1.0, 0.95))
        let (_, closed) = g.acceptWeak(tap("c", 1.1, 0.6))    // a stray weak tap changes nothing
        #expect(closed.isEmpty)
        let out = g.accept(tap("b", 1.3, 0.95))                // a then b within 500 ms: a sequence
        #expect(out.map(\.gesture) == ["sequence"])
        #expect(out.first?.zones == ["a", "b"])
    }
}
