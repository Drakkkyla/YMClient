import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// Small Keychain wrapper. Everything is stored "when unlocked, this device only": it never
/// leaves the phone (not in backups, not on a new device) and is unreadable while locked.
enum Keychain {
  private static let service = "hush"

  private static func base(_ key: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: key,
    ]
  }

  static func get(_ key: String) -> Data? {
    var query = base(key)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess else { return nil }
    return out as? Data
  }

  @discardableResult
  static func set(_ data: Data, for key: String) -> Bool {
    SecItemDelete(base(key) as CFDictionary)
    var add = base(key)
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
  }

  static func delete(_ key: String) {
    SecItemDelete(base(key) as CFDictionary)
  }
}

/// AES-256-GCM with one random master key created on first launch and kept in the Keychain.
enum Crypto {
  enum Failure: Error { case sealFailed }

  static let key: SymmetricKey = {
    if let stored = Keychain.get("masterKey"), stored.count == 32 {
      return SymmetricKey(data: stored)
    }
    let fresh = SymmetricKey(size: .bits256)
    Keychain.set(fresh.withUnsafeBytes { Data($0) }, for: "masterKey")
    return fresh
  }()

  static func seal(_ data: Data) throws -> Data {
    guard let combined = try AES.GCM.seal(data, using: key).combined else { throw Failure.sealFailed }
    return combined
  }

  static func open(_ data: Data) throws -> Data {
    try AES.GCM.open(AES.GCM.SealedBox(combined: data), using: key)
  }
}

/// 6-digit PIN, stored as a salted SHA-256 hash. Wrong attempts lock input for a while.
enum Pin {
  static let length = 6
  private static let defaults = UserDefaults.standard

  static var isSet: Bool { Keychain.get("pinHash") != nil }

  private static func hash(_ pin: String, salt: Data) -> Data {
    Data(SHA256.hash(data: salt + Data(pin.utf8)))
  }

  static func set(_ pin: String) {
    let salt = Data((0..<16).map { _ in UInt8.random(in: 0...255) })
    Keychain.set(salt, for: "pinSalt")
    Keychain.set(hash(pin, salt: salt), for: "pinHash")
    resetFailures()
  }

  static func check(_ pin: String) -> Bool {
    guard let salt = Keychain.get("pinSalt"), let stored = Keychain.get("pinHash") else { return false }
    return hash(pin, salt: salt) == stored
  }

  /// Seconds left before another attempt is allowed, or nil.
  static var lockoutRemaining: Int? {
    let until = defaults.double(forKey: "pinLockUntil")
    let left = Int(ceil(until - Date().timeIntervalSince1970))
    return left > 0 ? left : nil
  }

  static func registerFailure() {
    let failures = defaults.integer(forKey: "pinFailures") + 1
    defaults.set(failures, forKey: "pinFailures")
    if failures >= 5 {
      // 30 s after the 5th miss, then 60, 90…
      let wait = Double(30 * (failures - 4))
      defaults.set(Date().timeIntervalSince1970 + wait, forKey: "pinLockUntil")
    }
  }

  static func resetFailures() {
    defaults.set(0, forKey: "pinFailures")
    defaults.set(0, forKey: "pinLockUntil")
  }
}

enum Biometrics {
  static var available: Bool {
    LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
  }

  static var iconName: String {
    let ctx = LAContext()
    _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
    return ctx.biometryType == .touchID ? "touchid" : "faceid"
  }

  static func authenticate() async -> Bool {
    let ctx = LAContext()
    ctx.localizedFallbackTitle = "Ввести PIN"
    do {
      return try await ctx.evaluatePolicy(
        .deviceOwnerAuthenticationWithBiometrics, localizedReason: "Открыть Hush")
    } catch {
      return false
    }
  }
}
