// ghostkeys-lab: record labeled motion-sensor sessions, replay them through GhostkeysDetection, report accuracy.
// Usage: see README.md next to this file, or run `ghostkeys-lab help`.

import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let usage = """
ghostkeys-lab: collect real tap data and measure detection accuracy

  record  --out FILE.gkrec [--zones a,b,..] [--reps 20] [--interval 1.0] [--negatives 45] [--rest 20]
  replay  FILE.gkrec [--holdout 0.25 | --kfold 5] [--sensitivity 0.5] [--seed 42] [--match-ms 80]
                     [--min-confidence X] [--typing-gate-ms X] [--no-negatives] [--save-model model.json]
  info    FILE.gkrec
  export  FILE.gkrec --csv DIR
  live    [--seconds N] [--model model.json] [--sensitivity 0.5] [--no-lab-onsets]
  synth   --out FILE.gkrec [--zones ..] [--reps 20] [--negatives 45] [--rest 20] [--seed 7] [--noise 0.0015] [--hz 797]
"""

let argv = Array(CommandLine.arguments.dropFirst())
guard let cmd = argv.first, !["help", "-h", "--help"].contains(cmd) else {
    print(usage)
    exit(argv.isEmpty ? 1 : 0)
}
let args = Args(Array(argv.dropFirst()), flagNames: ["no-negatives", "no-lab-onsets"])
do {
    switch cmd {
    case "record": try runRecord(args)
    case "replay": try runReplay(args)
    case "info": try runInfo(args)
    case "export": try runExport(args)
    case "live": try runLive(args)
    case "synth": try runSynth(args)
    default:
        print("unknown command \(cmd)\n\n\(usage)")
        exit(1)
    }
} catch {
    Terminal.restore()
    DriverControl.shared.restore()
    FileHandle.standardError.write("error: \(error)\n".data(using: .utf8)!)
    exit(1)
}
