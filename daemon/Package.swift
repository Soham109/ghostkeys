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
        .testTarget(name: "GhostkeysDetectionTests", dependencies: ["GhostkeysDetection"],
                    // Command Line Tools only (no Xcode): point at the bundled swift-testing framework.
                    swiftSettings: [.unsafeFlags(["-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"])],
                    linkerSettings: [.unsafeFlags(["-F", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks", "-Xlinker", "-rpath", "-Xlinker", "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"])]),
    ]
)
