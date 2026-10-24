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
      guard let plain = try? Crypto.openFile(url) else { return nil }
      return UIImage(data: plain)
    }.value
  }

  /// Decrypted copy in tmp (for video playback / sharing). The caller removes it when done;
  /// leftovers are wiped on the next launch.
  func decryptToTemp(_ item: VaultItem) async -> URL? {
    let src = fileURL(item)
    let dest = Self.tempDir.appendingPathComponent("\(UUID().uuidString).\(item.ext)")
    return await Task.detached(priority: .userInitiated) { () -> URL? in
      do {
        try Crypto.openFile(from: src, to: dest)
        return dest
      } catch {
        try? FileManager.default.removeItem(at: dest)
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

  /// Encrypts a photo + its thumbnail off the main thread and returns the new item.
  private func write(data: Data, ext: String) async throws -> VaultItem {
    let item = VaultItem(id: UUID(), kind: .photo, ext: ext.lowercased(), added: Date())
    let fileURL = fileURL(item)
    let thumbURL = thumbURL(item)
    try await Task.detached(priority: .userInitiated) {
      try Crypto.seal(data).write(to: fileURL, options: [.atomic, .completeFileProtection])
      if let thumb = Self.photoThumbnail(data), let jpeg = thumb.jpegData(compressionQuality: 0.8) {
        try Crypto.seal(jpeg).write(to: thumbURL, options: [.atomic, .completeFileProtection])
      }
    }.value
    return item
  }

  /// Encrypts a video file chunk by chunk (never fully in memory). The source file is removed.
  private func write(videoAt src: URL) async throws -> VaultItem {
    let ext = src.pathExtension.isEmpty ? "mov" : src.pathExtension
    let item = VaultItem(id: UUID(), kind: .video, ext: ext.lowercased(), added: Date())
    let fileURL = fileURL(item)
    let thumbURL = thumbURL(item)
    defer { try? FileManager.default.removeItem(at: src) }
    try await Task.detached(priority: .userInitiated) {
      do {
        try Crypto.sealFile(from: src, to: fileURL)
      } catch {
        try? FileManager.default.removeItem(at: fileURL)
        throw error
      }
      if let thumb = Self.videoThumbnail(src), let jpeg = thumb.jpegData(compressionQuality: 0.8) {
        try Crypto.seal(jpeg).write(to: thumbURL, options: [.atomic, .completeFileProtection])
      }
    }.value
    return item
  }

  private static let thumbSide: CGFloat = 360

  private static func photoThumbnail(_ data: Data) -> UIImage? {
    guard let image = UIImage(data: data) else { return nil }
    let scale = thumbSide / min(image.size.width, image.size.height)
    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    return image.preparingThumbnail(of: size) ?? image
  }

  private static func videoThumbnail(_ url: URL) -> UIImage? {
    let gen = AVAssetImageGenerator(asset: AVURLAsset(url: url))
    gen.appliesPreferredTrackTransform = true
    gen.maximumSize = CGSize(width: thumbSide * 2, height: thumbSide * 2)
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
      var item: VaultItem?
      if asset.mediaType == .video {
        if let file = await Library.exportVideo(asset) {
          item = try? await write(videoAt: file)
        }
      } else if let loaded = await Library.photoData(for: asset) {
        item = try? await write(data: loaded.0, ext: loaded.1)
      }
      if let item {
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
      let isVideo = entry.supportedContentTypes.contains { $0.conforms(to: .movie) }
      var item: VaultItem?
      if isVideo {
        if let movie = try? await entry.loadTransferable(type: MovieFile.self) {
          item = try? await write(videoAt: movie.url)
        }
      } else if let data = try? await entry.loadTransferable(type: Data.self) {
        let ext = entry.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
        item = try? await write(data: data, ext: ext)
      }
      if let item {
        insert(item)
        if let id = entry.itemIdentifier { ids.append(id) }
      }
    }
    progress = nil
    return ids
  }
}

/// Picker video delivered as a file (copied into our temp dir) instead of in-memory Data.
struct MovieFile: Transferable {
  let url: URL

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(contentType: .movie) { movie in
      SentTransferredFile(movie.url)
    } importing: { received in
      let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
      let copy = VaultStore.tempDir.appendingPathComponent("\(UUID().uuidString).\(ext)")
      try FileManager.default.copyItem(at: received.file, to: copy)
      return MovieFile(url: copy)
    }
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

  /// Original photo bytes + file extension.
  static func photoData(for asset: PHAsset) async -> (Data, String)? {
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

  /// Writes a video (the edited version if there is one) to a temp file. Works for slo-mo and
  /// edited clips too, where requestAVAsset returns a composition instead of a file URL.
  static func exportVideo(_ asset: PHAsset) async -> URL? {
    let resources = PHAssetResource.assetResources(for: asset)
    guard
      let resource = resources.first(where: { $0.type == .fullSizeVideo })
        ?? resources.first(where: { $0.type == .video })
    else { return nil }
    let ext = (resource.originalFilename as NSString).pathExtension
    let dest = VaultStore.tempDir.appendingPathComponent(
      "\(UUID().uuidString).\(ext.isEmpty ? "mov" : ext.lowercased())")
    let options = PHAssetResourceRequestOptions()
    options.isNetworkAccessAllowed = true
    return await withCheckedContinuation { cont in
      PHAssetResourceManager.default().writeData(for: resource, toFile: dest, options: options) { error in
        if error != nil { try? FileManager.default.removeItem(at: dest) }
        cont.resume(returning: error == nil ? dest : nil)
      }
    }
  }

  enum DeleteResult {
    case deleted, cancelled
    case failed(String)
  }

  /// Deletes originals from the Photos library (Hidden ones included). iOS shows its own
  /// confirmation. They then sit in "Recently Deleted" for 30 days — iOS rule.
  static func delete(ids: [String]) async -> DeleteResult {
    // Fresh objects: the ones fetched before a long import can be stale.
    let found = assets(withIds: ids)
    guard !found.isEmpty else { return .failed("Фото не найдены в медиатеке") }
    do {
      try await PHPhotoLibrary.shared().performChanges {
        PHAssetChangeRequest.deleteAssets(found as NSArray)
      }
      return .deleted
    } catch {
      let ns = error as NSError
      if ns.domain == PHPhotosErrorDomain && ns.code == PHPhotosError.userCancelled.rawValue {
        return .cancelled
      }
      return .failed("\(ns.localizedDescription) (\(ns.domain) \(ns.code))")
    }
  }
}
