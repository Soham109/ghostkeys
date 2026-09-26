// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ghostkeysd",
    platforms: [.macOS(.v14)],
    targets: [
        // Pure logic, no hardware: features, classifier, calibration, gesture grammar. Unit tested.
        .target(name: "GhostkeysDetection"),
        // The daemon: sensors (IOKit), WebSocket server, actions, config.
        .executableTarget(name: "ghostkeysd", dependencies: ["GhostkeysDetection"]),
        // Optional sound mode: knuckle vs fingertip, rubs and swipes by friction sound, hand waves by inaudible sonar.
        .target(name: "GhostkeysAcoustics"),
        // Optional camera add-on (M4/M5 Desk View): hand tracking, pinches, air gestures.
        .target(name: "GhostkeysVision"),
        // Lab tool: record labeled sensor sessions, replay them through detection, report accuracy.
        .executableTarget(name: "ghostkeys-lab", dependencies: ["GhostkeysDetection"]),
        .testTarget(name: "GhostkeysAcousticsTests", dependencies: ["GhostkeysAcoustics"],
                    swiftSettings: [.unsafeFlags(["-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"])],
                    linkerSettings: [.unsafeFlags(["-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks", "-Xlinker", "-rpath", "-Xlinker", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"])]),
        .testTarget(name: "GhostkeysVisionTests", dependencies: ["GhostkeysVision"],
                    swiftSettings: [.unsafeFlags(["-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"])],
                    linkerSettings: [.unsafeFlags(["-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks", "-Xlinker", "-rpath", "-Xlinker", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"])]),
        // App integrations: context-aware commands for Excel, browsers, music, Finder, etc. via Apple Events.
        .target(name: "GhostkeysIntegrations"),
        .testTarget(name: "GhostkeysIntegrationsTests", dependencies: ["GhostkeysIntegrations"],
                    swiftSettings: [.unsafeFlags(["-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"])],
                    linkerSettings: [.unsafeFlags(["-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks", "-Xlinker", "-rpath", "-Xlinker", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"])]),
        .testTarget(name: "GhostkeysDetectionTests", dependencies: ["GhostkeysDetection"],
                    // Command Line Tools only (no Xcode): point at the bundled swift-testing framework.
                    swiftSettings: [.unsafeFlags(["-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"])],
                    linkerSettings: [.unsafeFlags(["-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks", "-Xlinker", "-rpath", "-Xlinker", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"])]),
    ]
)
