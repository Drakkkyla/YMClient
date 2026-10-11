// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "tauri-plugin-ymaudio",
  platforms: [
    .iOS(.v13)
  ],
  products: [
    .library(
      name: "tauri-plugin-ymaudio",
      type: .static,
      targets: ["tauri-plugin-ymaudio"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-ymaudio",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
