import AVFoundation
import Foundation
import Photos
import PhotosUI
// xtool (SwiftPM explicit modules) does not load the PhotosUI+SwiftUI cross-import overlay.
#if canImport(_PhotosUI_SwiftUI)
  import _PhotosUI_SwiftUI
#endif
import SwiftUI
import UniformTypeIdentifiers

struct VaultItem: Codable, Identifiable, Hashable {
  enum Kind: String, Codable { case photo, video }
  let id: UUID
  let kind: Kind
  /// Original file extension (heic, jpg, mov…) — used when the file is shared/exported.
  let ext: String
  let added: Date
}

/// The encrypted vault: Application Support/HushVault/
///   index.bin        encrypted JSON list of items
///   <uuid>.d / .t    encrypted original / encrypted thumbnail
/// Files use Complete file protection and are excluded from iCloud/computer backups.
final class VaultStore: ObservableObject {
  @Published private(set) var items: [VaultItem] = []
  /// Progress text while importing ("Переношу 3 из 10"), nil when idle.
  @Published var progress: String?

  let dir: URL
  private let thumbs = NSCache<NSUUID, UIImage>()

  init() {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    var dir = base.appendingPathComponent("HushVault", isDirectory: true)
    try? FileManager.default.createDirectory(
      at: dir, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? dir.setResourceValues(values)
    self.dir = dir
    load()
    Self.clearTemp()
  }

  // MARK: index

  private var indexURL: URL { dir.appendingPathComponent("index.bin") }

  private func load() {
    guard let sealed = try? Data(contentsOf: indexURL),
      let plain = try? Crypto.open(sealed),
      let list = try? JSONDecoder().decode([VaultItem].self, from: plain)
    else { return }
    items = list
  }

  private func save() {
    guard let plain = try? JSONEncoder().encode(items), let sealed = try? Crypto.seal(plain) else { return }
    try? sealed.write(to: indexURL, options: [.atomic, .completeFileProtection])
  }

  func fileURL(_ item: VaultItem) -> URL { dir.appendingPathComponent(item.id.uuidString + ".d") }
  func thumbURL(_ item: VaultItem) -> URL { dir.appendingPathComponent(item.id.uuidString + ".t") }

  // MARK: reading

  func thumbnail(_ item: VaultItem) async -> UIImage? {
    if let cached = thumbs.object(forKey: item.id as NSUUID) { return cached }
    let url = thumbURL(item)
    let image = await Task.detached(priority: .userInitiated) { () -> UIImage? in
      guard let sealed = try? Data(contentsOf: url), let plain = try? Crypto.open(sealed) else { return nil }
      return UIImage(data: plain)
    }.value
    if let image { thumbs.setObject(image, forKey: item.id as NSUUID) }
    return image
  }

  func fullImage(_ item: VaultItem) async -> UIImage? {
    let url = fileURL(item)
    return await Task.detached(priority: .userInitiated) { () -> UIImage? in
      guard let sealed = try? Data(contentsOf: url), let plain = try? Crypto.open(sealed) else { return nil }
      return UIImage(data: plain)
    }.value
  }

  /// Decrypted copy in tmp (for video playback / sharing). The caller removes it when done;
  /// leftovers are wiped on the next launch.
  func decryptToTemp(_ item: VaultItem) async -> URL? {
    let src = fileURL(item)
    let dest = Self.tempDir.appendingPathComponent("\(UUID().uuidString).\(item.ext)")
    return await Task.detached(priority: .userInitiated) { () -> URL? in
      guard let sealed = try? Data(contentsOf: src), let plain = try? Crypto.open(sealed) else { return nil }
      do {
        try plain.write(to: dest, options: [.atomic, .completeFileProtection])
        return dest
      } catch {
        return nil
      }
    }.value
  }

  static var tempDir: URL {
    let d = FileManager.default.temporaryDirectory.appendingPathComponent("hush", isDirectory: true)
    try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
  }

  static func clearTemp() {
    try? FileManager.default.removeItem(at: tempDir)
  }

  // MARK: writing

  /// Encrypts original + thumbnail off the main thread and returns the new item.
  private func write(data: Data, kind: VaultItem.Kind, ext: String) async throws -> VaultItem {
    let item = VaultItem(id: UUID(), kind: kind, ext: ext.lowercased(), added: Date())
    let fileURL = fileURL(item)
    let thumbURL = thumbURL(item)
    try await Task.detached(priority: .userInitiated) {
      try Crypto.seal(data).write(to: fileURL, options: [.atomic, .completeFileProtection])
      if let thumb = Self.makeThumbnail(data: data, kind: kind, ext: ext),
        let jpeg = thumb.jpegData(compressionQuality: 0.8)
      {
        try Crypto.seal(jpeg).write(to: thumbURL, options: [.atomic, .completeFileProtection])
      }
    }.value
    return item
  }

  private static func makeThumbnail(data: Data, kind: VaultItem.Kind, ext: String) -> UIImage? {
    let side: CGFloat = 360
    if kind == .photo {
      guard let image = UIImage(data: data) else { return nil }
      let scale = side / min(image.size.width, image.size.height)
      let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
      return image.preparingThumbnail(of: size) ?? image
    }
    // video: grab the first frame from a short-lived decrypted temp copy
    let tmp = tempDir.appendingPathComponent("\(UUID().uuidString).\(ext)")
    defer { try? FileManager.default.removeItem(at: tmp) }
    guard (try? data.write(to: tmp, options: .completeFileProtection)) != nil else { return nil }
    let gen = AVAssetImageGenerator(asset: AVURLAsset(url: tmp))
    gen.appliesPreferredTrackTransform = true
    gen.maximumSize = CGSize(width: side * 2, height: side * 2)
    guard let cg = try? gen.copyCGImage(at: .zero, actualTime: nil) else { return nil }
    return UIImage(cgImage: cg)
  }

  @MainActor
  private func insert(_ item: VaultItem) {
    items.insert(item, at: 0)
    save()
  }

  @MainActor
  func delete(_ ids: Set<UUID>) {
    for item in items where ids.contains(item.id) {
      try? FileManager.default.removeItem(at: fileURL(item))
      try? FileManager.default.removeItem(at: thumbURL(item))
      thumbs.removeObject(forKey: item.id as NSUUID)
    }
    items.removeAll { ids.contains($0.id) }
    save()
  }

  @MainActor
  func deleteEverything() {
    delete(Set(items.map(\.id)))
  }

  // MARK: import

  /// Imports Photos assets (e.g. from the Hidden album). Returns the ones that made it in.
  @MainActor
  func importAssets(_ assets: [PHAsset]) async -> [PHAsset] {
    var done: [PHAsset] = []
    for (i, asset) in assets.enumerated() {
      progress = "Переношу \(i + 1) из \(assets.count)"
      guard let loaded = await Library.data(for: asset) else { continue }
      let (data, ext) = loaded
      let kind: VaultItem.Kind = asset.mediaType == .video ? .video : .photo
      if let item = try? await write(data: data, kind: kind, ext: ext) {
        insert(item)
        done.append(asset)
      }
    }
    progress = nil
    return done
  }

  /// Imports from the system photo picker. Returns local identifiers of what was imported
  /// (so the originals can be offered for deletion).
  @MainActor
  func importPickerItems(_ picked: [PhotosPickerItem]) async -> [String] {
    var ids: [String] = []
    for (i, entry) in picked.enumerated() {
      progress = "Переношу \(i + 1) из \(picked.count)"
      guard let data = try? await entry.loadTransferable(type: Data.self) else { continue }
      let type = entry.supportedContentTypes.first
      let isVideo = type?.conforms(to: .movie) ?? false
      let ext = type?.preferredFilenameExtension ?? (isVideo ? "mov" : "jpg")
      if let item = try? await write(data: data, kind: isVideo ? .video : .photo, ext: ext) {
        insert(item)
        if let id = entry.itemIdentifier { ids.append(id) }
      }
    }
    progress = nil
    return ids
  }
}

/// Photos library helpers.
enum Library {
  static func requestAccess() async -> PHAuthorizationStatus {
    await PHPhotoLibrary.requestAuthorization(for: .readWrite)
  }

  /// Everything in the system "Hidden" album, newest first. Needs full (not limited) access.
  static func hiddenAssets() -> [PHAsset] {
    let options = PHFetchOptions()
    options.includeHiddenAssets = true
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    let albums = PHAssetCollection.fetchAssetCollections(
      with: .smartAlbum, subtype: .smartAlbumAllHidden, options: nil)
    guard let hidden = albums.firstObject else { return [] }
    let result = PHAsset.fetchAssets(in: hidden, options: options)
    var out: [PHAsset] = []
    result.enumerateObjects { asset, _, _ in out.append(asset) }
    return out
  }

  static func assets(withIds ids: [String]) -> [PHAsset] {
    let options = PHFetchOptions()
    options.includeHiddenAssets = true
    let result = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: options)
    var out: [PHAsset] = []
    result.enumerateObjects { asset, _, _ in out.append(asset) }
    return out
  }

  static func thumbnail(_ asset: PHAsset, side: CGFloat = 300) async -> UIImage? {
    let options = PHImageRequestOptions()
    options.deliveryMode = .highQualityFormat  // exactly one callback
    options.resizeMode = .fast
    options.isNetworkAccessAllowed = true
    return await withCheckedContinuation { cont in
      PHImageManager.default().requestImage(
        for: asset, targetSize: CGSize(width: side, height: side), contentMode: .aspectFill,
        options: options
      ) { image, _ in cont.resume(returning: image) }
    }
  }

  /// Original bytes + file extension of an asset.
  static func data(for asset: PHAsset) async -> (Data, String)? {
    if asset.mediaType == .video {
      let options = PHVideoRequestOptions()
      options.isNetworkAccessAllowed = true
      options.version = .current
      options.deliveryMode = .highQualityFormat
      return await withCheckedContinuation { cont in
        PHImageManager.default().requestAVAsset(forVideo: asset, options: options) { av, _, _ in
          guard let url = (av as? AVURLAsset)?.url, let data = try? Data(contentsOf: url) else {
            cont.resume(returning: nil)
            return
          }
          let ext = url.pathExtension.isEmpty ? "mov" : url.pathExtension.lowercased()
          cont.resume(returning: (data, ext))
        }
      }
    }
    let options = PHImageRequestOptions()
    options.isNetworkAccessAllowed = true
    options.version = .current
    options.deliveryMode = .highQualityFormat
    return await withCheckedContinuation { cont in
      PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) {
        data, uti, _, _ in
        guard let data else {
          cont.resume(returning: nil)
          return
        }
        let ext = uti.flatMap { UTType($0)?.preferredFilenameExtension } ?? "jpg"
        cont.resume(returning: (data, ext))
      }
    }
  }

  /// Deletes originals from the Photos library. iOS shows its own confirmation; returns false
  /// if the user declined. (They then sit in "Recently Deleted" for 30 days — iOS rule.)
  static func delete(_ assets: [PHAsset]) async -> Bool {
    guard !assets.isEmpty else { return true }
    do {
      try await PHPhotoLibrary.shared().performChanges {
        PHAssetChangeRequest.deleteAssets(assets as NSArray)
      }
      return true
    } catch {
      return false
    }
  }
}
