import SwiftUI

@main
struct HushApp: App {
  @StateObject private var store = VaultStore()
  @StateObject private var lock = LockState()
  @Environment(\.scenePhase) private var phase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(store)
        .environmentObject(lock)
        .preferredColorScheme(.dark)
        .tint(Theme.accent)
    }
    .onChange(of: phase) { newPhase in
      // Leaving the app locks it; decrypted temp copies (video, share) are wiped.
      if newPhase == .background {
        lock.unlocked = false
        VaultStore.clearTemp()
      }
    }
  }
}

final class LockState: ObservableObject {
  @Published var unlocked = false
  @Published var hasPin = Pin.isSet
}

enum Theme {
  static let bg = Color(red: 0.035, green: 0.035, blue: 0.05)
  static let surface = Color.white.opacity(0.06)
  static let accent = Color(red: 0.45, green: 0.86, blue: 0.78)
}

struct RootView: View {
  @EnvironmentObject var lock: LockState
  @Environment(\.scenePhase) private var phase

  var body: some View {
    ZStack {
      Theme.bg.ignoresSafeArea()
      if !lock.hasPin {
        SetupPinView()
      } else if !lock.unlocked {
        LockView()
      } else {
        GalleryView()
      }
      // App switcher / Control Center: show a cover instead of the contents.
      if phase != .active {
        PrivacyCover().transition(.opacity)
      }
    }
    .animation(.easeInOut(duration: 0.2), value: lock.unlocked)
    .animation(.easeInOut(duration: 0.15), value: phase)
  }
}

struct PrivacyCover: View {
  var body: some View {
    ZStack {
      Theme.bg.ignoresSafeArea()
      Image(systemName: "circle.hexagongrid.fill")
        .font(.system(size: 54))
        .foregroundStyle(Theme.accent.opacity(0.8))
    }
  }
}
