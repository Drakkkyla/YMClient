// swift-tools-version: 6.0
// SwiftPM manifest for building Hush with xtool (https://github.com/xtool-org/xtool) on
// Linux / Windows-WSL. The same sources also build through XcodeGen (project.yml) on a Mac.
import PackageDescription

let package = Package(
  name: "Hush",
  platforms: [
    .iOS(.v16)
  ],
  products: [
    // xtool: exactly one library product = the app.
    .library(name: "Hush", targets: ["Hush"])
  ],
  targets: [
    .target(
      name: "Hush",
      path: "Hush",
      // Asset catalogs need Apple's actool; xtool takes the icon from iconPath instead.
      exclude: ["Assets.xcassets"],
      swiftSettings: [.swiftLanguageMode(.v5)]
    )
  ]
)
