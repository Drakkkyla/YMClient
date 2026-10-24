import Photos
import SwiftUI

/// Grid of the system "Hidden" album: pick items, move them into Hush, then optionally delete
/// the originals from Photos.
struct HiddenImportView: View {
  @EnvironmentObject var store: VaultStore
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL

  @State private var status: PHAuthorizationStatus = .notDetermined
  @State private var assets: [PHAsset] = []
  @State private var selected = Set<String>()
  @State private var loading = true
  @State private var importing = false
  @State private var showNote = false
  @State private var deleteError: String?
  @AppStorage("deleteHiddenAfterImport") private var deleteAfter = true

  private let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 3)

  var body: some View {
    NavigationStack {
      content
        .background(Theme.bg)
        .navigationTitle("Скрытые")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Закрыть") { dismiss() }
          }
          ToolbarItem(placement: .primaryAction) {
            if !assets.isEmpty {
              Button(selected.count == assets.count ? "Снять все" : "Выбрать все") {
                if selected.count == assets.count {
                  selected = []
                } else {
                  selected = Set(assets.map(\.localIdentifier))
                }
              }
            }
          }
        }
        .safeAreaInset(edge: .bottom) {
          if !assets.isEmpty {
            VStack(spacing: 8) {
            Toggle("Удалить из «Скрытых» после переноса", isOn: $deleteAfter)
              .font(.subheadline)
              .padding(.horizontal, 20)
              .padding(.top, 10)
            Button {
              Task { await runImport() }
            } label: {
              Text(importing ? (store.progress ?? "Переношу…") : "Перенести в Hush (\(selected.count))")
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .disabled(selected.isEmpty || importing)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            }
            .background(.ultraThinMaterial)
          }
        }
    }
    .task { await load() }
    .interactiveDismissDisabled(importing)
    .alert(
      "Не удалось удалить из «Скрытых»",
      isPresented: Binding(get: { deleteError != nil }, set: { if !$0 { deleteError = nil } })
    ) {
      Button("OK", role: .cancel) {}
    } message: {
      Text((deleteError ?? "") + "\n\nФото уже в Hush. Удалите оригиналы вручную в «Фото».")
    }
    .alert("Почти готово", isPresented: $showNote) {
      Button("Понятно") { dismiss() }
    } message: {
      Text(GalleryView.recentlyDeletedNote)
    }
  }

  @ViewBuilder
  private var content: some View {
    if loading {
      ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
    } else if status != .authorized {
      VStack(spacing: 14) {
        Image(systemName: "eye.slash").font(.system(size: 44)).foregroundStyle(Theme.accent)
        Text("Нужен полный доступ к фото").font(.title3.weight(.bold))
        Text("Альбом «Скрытые» iOS показывает только приложениям с доступом ко всей медиатеке. Откройте настройки → Фото → «Все фото».")
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
        Button("Открыть настройки") {
          if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
        }
        .buttonStyle(.borderedProminent)
      }
      .padding(32)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else if assets.isEmpty {
      VStack(spacing: 10) {
        Image(systemName: "checkmark.circle").font(.system(size: 44)).foregroundStyle(Theme.accent)
        Text("В «Скрытых» ничего нет").font(.title3.weight(.bold))
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
      ScrollView {
        LazyVGrid(columns: columns, spacing: 2) {
          ForEach(assets, id: \.localIdentifier) { asset in
            AssetThumb(asset: asset, selected: selected.contains(asset.localIdentifier))
              .onTapGesture {
                let id = asset.localIdentifier
                if selected.contains(id) { selected.remove(id) } else { selected.insert(id) }
              }
          }
        }
      }
    }
  }

  private func load() async {
    let s = await Library.requestAccess()
    let found = s == .authorized ? Library.hiddenAssets() : []
    await MainActor.run {
      status = s
      assets = found
      loading = false
    }
  }

  private func runImport() async {
    let chosen = assets.filter { selected.contains($0.localIdentifier) }
    await MainActor.run { importing = true }
    let done = await store.importAssets(chosen)
    let doneIds = done.map(\.localIdentifier)
    await MainActor.run {
      let idSet = Set(doneIds)
      assets.removeAll { idSet.contains($0.localIdentifier) }
      selected.subtract(idSet)
    }
    if deleteAfter && !doneIds.isEmpty {
      // iOS asks the user to confirm deleting from the library.
      let result = await Library.delete(ids: doneIds)
      await MainActor.run {
        switch result {
        case .deleted: showNote = true
        case .cancelled: break
        case .failed(let message): deleteError = message
        }
      }
    }
    await MainActor.run { importing = false }
  }
}

struct AssetThumb: View {
  let asset: PHAsset
  let selected: Bool
  @State private var image: UIImage?

  var body: some View {
    Color.white.opacity(0.05)
      .aspectRatio(1, contentMode: .fit)
      .overlay {
        if let image {
          Image(uiImage: image).resizable().scaledToFill()
        }
      }
      .clipped()
      .overlay(alignment: .bottomLeading) {
        if asset.mediaType == .video {
          Image(systemName: "play.fill").font(.caption).foregroundStyle(.white).padding(6).shadow(radius: 3)
        }
      }
      .overlay(alignment: .topTrailing) {
        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
          .font(.title3)
          .foregroundStyle(selected ? Theme.accent : .white)
          .padding(6)
          .shadow(radius: 3)
      }
      .contentShape(Rectangle())
      .task(id: asset.localIdentifier) { image = await Library.thumbnail(asset) }
  }
}
