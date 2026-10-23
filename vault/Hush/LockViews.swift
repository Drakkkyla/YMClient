import SwiftUI

/// Numeric PIN pad with dots, shake on error and an optional biometrics key.
struct PinPad: View {
  let title: String
  var subtitle: String?
  var error: String?
  /// Bump to replay the shake (the same error text can repeat).
  var errorTick: Int = 0
  var showBiometric = false
  var onBiometric: () -> Void = {}
  let onComplete: (String) -> Void

  @State private var digits = ""
  @State private var shake: CGFloat = 0

  var body: some View {
    VStack(spacing: 26) {
      Spacer(minLength: 20)
      Image(systemName: "circle.hexagongrid.fill")
        .font(.system(size: 40))
        .foregroundStyle(Theme.accent)
      VStack(spacing: 6) {
        Text(title).font(.title2.weight(.bold))
        if let subtitle {
          Text(subtitle)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
        }
      }
      HStack(spacing: 16) {
        ForEach(0..<Pin.length, id: \.self) { i in
          Circle()
            .fill(i < digits.count ? Theme.accent : Color.white.opacity(0.18))
            .frame(width: 14, height: 14)
        }
      }
      .modifier(Shake(amount: shake))
      Text(error ?? " ")
        .font(.footnote)
        .foregroundStyle(.red)
        .opacity(error == nil ? 0 : 1)
      Spacer(minLength: 10)
      keypad
    }
    .padding(.horizontal, 28)
    .padding(.bottom, 28)
    .onChange(of: errorTick) { _ in
      digits = ""
      withAnimation(.linear(duration: 0.35)) { shake += 1 }
      UINotificationFeedbackGenerator().notificationOccurred(.error)
    }
  }

  private var keypad: some View {
    let rows = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["bio", "0", "del"]]
    return VStack(spacing: 14) {
      ForEach(rows, id: \.self) { row in
        HStack(spacing: 24) {
          ForEach(row, id: \.self) { key in keyButton(key) }
        }
      }
    }
  }

  @ViewBuilder
  private func keyButton(_ key: String) -> some View {
    switch key {
    case "bio":
      Button(action: onBiometric) {
        Image(systemName: Biometrics.iconName).font(.title)
          .frame(width: 78, height: 78)
      }
      .buttonStyle(.plain)
      .opacity(showBiometric ? 1 : 0)
      .disabled(!showBiometric)
    case "del":
      Button {
        if !digits.isEmpty { digits.removeLast() }
      } label: {
        Image(systemName: "delete.left").font(.title2)
          .frame(width: 78, height: 78)
      }
      .buttonStyle(.plain)
    default:
      Button {
        press(key)
      } label: {
        Text(key)
          .font(.system(size: 30, weight: .medium, design: .rounded))
          .frame(width: 78, height: 78)
          .background(Circle().fill(Color.white.opacity(0.08)))
      }
      .buttonStyle(.plain)
    }
  }

  private func press(_ key: String) {
    guard digits.count < Pin.length else { return }
    digits += key
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    if digits.count == Pin.length {
      let entered = digits
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
        onComplete(entered)
        digits = ""
      }
    }
  }
}

struct Shake: GeometryEffect {
  var amount: CGFloat
  var animatableData: CGFloat {
    get { amount }
    set { amount = newValue }
  }
  func effectValue(size: CGSize) -> ProjectionTransform {
    ProjectionTransform(CGAffineTransform(translationX: 10 * sin(amount * .pi * 4), y: 0))
  }
}

/// First launch: choose a PIN (twice).
struct SetupPinView: View {
  @EnvironmentObject var lock: LockState
  var onDone: (() -> Void)?
  @State private var first: String?
  @State private var error: String?
  @State private var tick = 0

  var body: some View {
    PinPad(
      title: first == nil ? "Придумайте PIN" : "Повторите PIN",
      subtitle: first == nil ? "6 цифр. Открывает Hush, если Face ID не сработал" : nil,
      error: error,
      errorTick: tick
    ) { pin in
      if let f = first {
        if f == pin {
          Pin.set(pin)
          lock.hasPin = true
          lock.unlocked = true
          onDone?()
        } else {
          first = nil
          error = "PIN не совпал, попробуйте ещё раз"
          tick += 1
        }
      } else {
        first = pin
        error = nil
      }
    }
  }
}

/// Locked: Face ID right away when the app becomes active, PIN as a fallback.
struct LockView: View {
  @EnvironmentObject var lock: LockState
  @Environment(\.scenePhase) private var phase
  @AppStorage("useBiometrics") private var useBiometrics = true
  @State private var error: String?
  @State private var tick = 0
  @State private var asking = false

  private var biometricsOn: Bool { useBiometrics && Biometrics.available }

  var body: some View {
    PinPad(
      title: "Hush",
      subtitle: "Введите PIN",
      error: error,
      errorTick: tick,
      showBiometric: biometricsOn,
      onBiometric: askBiometrics
    ) { pin in
      if let wait = Pin.lockoutRemaining {
        error = "Слишком много попыток. Подождите \(wait) с"
        tick += 1
        return
      }
      if Pin.check(pin) {
        Pin.resetFailures()
        lock.unlocked = true
      } else {
        Pin.registerFailure()
        error = "Неверный PIN"
        tick += 1
      }
    }
    .onAppear { if phase == .active { askBiometrics() } }
    .onChange(of: phase) { p in if p == .active { askBiometrics() } }
  }

  private func askBiometrics() {
    guard biometricsOn, !asking else { return }
    asking = true
    Task {
      let ok = await Biometrics.authenticate()
      await MainActor.run {
        asking = false
        if ok {
          Pin.resetFailures()
          lock.unlocked = true
        }
      }
    }
  }
}

/// Settings → change PIN: current, then new twice.
struct ChangePinView: View {
  @Environment(\.dismiss) private var dismiss
  @State private var verified = false
  @State private var first: String?
  @State private var error: String?
  @State private var tick = 0

  var body: some View {
    ZStack {
      Theme.bg.ignoresSafeArea()
      PinPad(
        title: !verified ? "Текущий PIN" : (first == nil ? "Новый PIN" : "Повторите новый PIN"),
        error: error,
        errorTick: tick
      ) { pin in
        if !verified {
          if Pin.check(pin) {
            verified = true
            error = nil
          } else {
            error = "Неверный PIN"
            tick += 1
          }
        } else if let f = first {
          if f == pin {
            Pin.set(pin)
            dismiss()
          } else {
            first = nil
            error = "PIN не совпал"
            tick += 1
          }
        } else {
          first = pin
          error = nil
        }
      }
    }
    .overlay(alignment: .topTrailing) {
      Button("Отмена") { dismiss() }.padding()
    }
  }
}
