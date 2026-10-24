import Photos
import PhotosUI
// xtool (SwiftPM explicit modules) does not load the PhotosUI+SwiftUI cross-import overlay.
#if canImport(_PhotosUI_SwiftUI)
  import _PhotosUI_SwiftUI
#endif
import SwiftUI

struct ViewerTarget: Identifiable {
  let id = UUID()
  let index: Int
}

struct ShareFiles: Identifiable {
  let id = UUID()
  let urls: [URL]
}

struct GalleryView: View {
  @EnvironmentObject var store: VaultStore
  @State private var selecting = false
  @State private var selection = Set<UUID>()
  @State private var viewer: ViewerTarget?
  @State private var showHidden = false
  @State private var showPicker = false
  @State private var picked: [PhotosPickerItem] = []
  @State private var showSettings = false
  @State private var confirmDelete = false
  @State private var share: ShareFiles?
  @State private var pickedIds: [String] = []
  @State private var askDeleteOriginals = false
  @State private var showRecentlyDeletedNote = false

  private let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 3)

  var body: some View {
    NavigationStack {
      ScrollView {
        if store.items.isEmpty {
          emptyState
        } else {
          LazyVGrid(columns: columns, spacing: 2) {
            ForEach(Array(store.items.enumerated()), id: \.element.id) { index, item in
              Thumb(item: item, selecting: selecting, selected: selection.contains(item.id))
                .onTapGesture { tap(index: index, item: item) }
            }
          }
          Text("\(store.items.count) в Hush")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .padding(.vertical, 18)
        }
      }
      .background(Theme.bg)
      .navigationTitle("Hush")
      .toolbar { toolbar }
      .overlay(alignment: .bottom) {
        if let progress = store.progress {
          HStack(spacing: 10) {
            ProgressView()
            Text(progress).font(.subheadline.weight(.semibold))
          }
          .padding(.horizontal, 18)
          .padding(.vertical, 12)
          .background(.ultraThinMaterial, in: Capsule())
          .padding(.bottom, 16)
        }
      }
    }
    .fullScreenCover(item: $viewer) { target in
      ViewerView(start: target.index).environmentObject(store)
    }
    .sheet(isPresented: $showHidden) {
      HiddenImportView().environmentObject(store)
    }
    .sheet(isPresented: $showSettings) {
      SettingsView().environmentObject(store)
    }
    .sheet(item: $share, onDismiss: VaultStore.clearTemp) { files in
      ShareSheet(urls: files.urls)
    }
    .photosPicker(
      isPresented: $showPicker, selection: $picked, maxSelectionCount: nil,
      matching: .any(of: [.images, .videos]), photoLibrary: .shared()
    )
    .onChange(of: picked) { items in
      guard !items.isEmpty else { return }
      Task {
        let ids = await store.importPickerItems(items)
        await MainActor.run {
          picked = []
          pickedIds = ids
          if !ids.isEmpty { askDeleteOriginals = true }
        }
      }
    }
    .confirmationDialog(
      "Удалить оригиналы из галереи?", isPresented: $askDeleteOriginals, titleVisibility: .visible
    ) {
      Button("Удалить из галереи", role: .destructive) { deleteOriginals() }
      Button("Оставить", role: .cancel) {}
    } message: {
      Text("Фото уже зашифрованы в Hush. iOS попросит подтвердить удаление.")
    }
    .confirmationDialog(
      "Удалить \(selection.count) из Hush?", isPresented: $confirmDelete, titleVisibility: .visible
    ) {
      Button("Удалить навсегда", role: .destructive) {
        store.delete(selection)
        selection = []
        selecting = false
      }
    } message: {
      Text("Восстановить будет нельзя.")
    }
    .alert("Почти готово", isPresented: $showRecentlyDeletedNote) {
      Button("Понятно", role: .cancel) {}
    } message: {
      Text(Self.recentlyDeletedNote)
    }
  }

  static let recentlyDeletedNote =
    "iOS ещё 30 дней хранит удалённое в «Недавно удалённых». Откройте «Фото» → «Альбомы» → «Недавно удалённые» и очистите его, чтобы копий не осталось."

  @ToolbarContentBuilder
  private var toolbar: some ToolbarContent {
    ToolbarItem(placement: .navigationBarLeading) {
      if selecting {
        Button("Отмена") {
          selecting = false
          selection = []
        }
      } else {
        Button {
          showSettings = true
        } label: {
          Image(systemName: "gearshape")
        }
      }
    }
    ToolbarItemGroup(placement: .navigationBarTrailing) {
      if selecting {
        Button {
          shareSelected()
        } label: {
          Image(systemName: "square.and.arrow.up")
        }
        .disabled(selection.isEmpty)
        Button(role: .destructive) {
          confirmDelete = true
        } label: {
          Image(systemName: "trash")
        }
        .disabled(selection.isEmpty)
      } else {
        if !store.items.isEmpty {
          Button("Выбрать") { selecting = true }
        }
        Menu {
          Button {
            showHidden = true
          } label: {
            Label("Из «Скрытых»", systemImage: "eye.slash")
          }
          Button {
            showPicker = true
          } label: {
            Label("Из галереи", systemImage: "photo.on.rectangle")
          }
        } label: {
          Image(systemName: "plus.circle.fill").font(.title3)
        }
      }
    }
  }

  private var emptyState: some View {
    VStack(spacing: 14) {
      Image(systemName: "circle.hexagongrid")
        .font(.system(size: 52))
        .foregroundStyle(Theme.accent)
      Text("Здесь пока пусто").font(.title3.weight(.bold))
      Text("Нажмите «+», чтобы перенести фото и видео из «Скрытых» или из галереи. Они будут зашифрованы и видны только здесь.")
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
      Button {
        showHidden = true
      } label: {
        Label("Перенести из «Скрытых»", systemImage: "eye.slash")
          .padding(.horizontal, 8)
      }
      .buttonStyle(.borderedProminent)
      .padding(.top, 6)
    }
    .padding(32)
    .padding(.top, 80)
  }

  private func tap(index: Int, item: VaultItem) {
    if selecting {
      if selection.contains(item.id) { selection.remove(item.id) } else { selection.insert(item.id) }
    } else {
      viewer = ViewerTarget(index: index)
    }
  }

  private func shareSelected() {
    let chosen = store.items.filter { selection.contains($0.id) }
    Task {
      var urls: [URL] = []
      for item in chosen {
        if let url = await store.decryptToTemp(item) { urls.append(url) }
      }
      await MainActor.run { if !urls.isEmpty { share = ShareFiles(urls: urls) } }
    }
  }

  private func deleteOriginals() {
    let ids = pickedIds
    Task {
      _ = await Library.requestAccess()
      let ok = await Library.delete(Library.assets(withIds: ids))
      await MainActor.run { if ok { showRecentlyDeletedNote = true } }
    }
  }
}

struct Thumb: View {
  @EnvironmentObject var store: VaultStore
  let item: VaultItem
  let selecting: Bool
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
        if item.kind == .video {
          Image(systemName: "play.fill")
            .font(.caption)
            .foregroundStyle(.white)
            .padding(6)
            .shadow(radius: 3)
        }
      }
      .overlay(alignment: .topTrailing) {
        if selecting {
          Image(systemName: selected ? "checkmark.circle.fill" : "circle")
            .font(.title3)
            .foregroundStyle(selected ? Theme.accent : .white)
            .padding(6)
            .shadow(radius: 3)
        }
      }
      .opacity(selecting && !selected ? 0.75 : 1)
      .contentShape(Rectangle())
      .task(id: item.id) { image = await store.thumbnail(item) }
  }
}

struct SettingsView: View {
  @EnvironmentObject var store: VaultStore
  @Environment(\.dismiss) private var dismiss
  @AppStorage("useBiometrics") private var useBiometrics = true
  @State private var changePin = false
  @State private var confirmWipe = false

  var body: some View {
    NavigationStack {
      Form {
        Section {
          if Biometrics.available {
            Toggle(isOn: $useBiometrics) {
              Label(Biometrics.iconName == "touchid" ? "Вход по Touch ID" : "Вход по Face ID", systemImage: Biometrics.iconName)
            }
          }
          Button {
            changePin = true
          } label: {
            Label("Сменить PIN", systemImage: "lock.rotation")
          }
        } header: {
          Text("Защита")
        }

        Section {
          Label("\(store.items.count) файлов, зашифровано AES-256", systemImage: "lock.shield")
          Label("Не попадает в резервные копии iCloud", systemImage: "icloud.slash")
        } header: {
          Text("Хранилище")
        } footer: {
          Text("Если удалить приложение Hush, его содержимое удалится вместе с ним. Перед удалением сохраните нужное через «Выбрать» → «Поделиться».")
        }

        Section {
          Button(role: .destructive) {
            confirmWipe = true
          } label: {
            Label("Удалить всё из Hush", systemImage: "trash")
          }
          .disabled(store.items.isEmpty)
        }
      }
      .scrollContentBackground(.hidden)
      .background(Theme.bg)
      .navigationTitle("Настройки")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Готово") { dismiss() } }
      }
      .fullScreenCover(isPresented: $changePin) { ChangePinView() }
      .confirmationDialog("Удалить всё содержимое Hush?", isPresented: $confirmWipe, titleVisibility: .visible) {
        Button("Удалить всё навсегда", role: .destructive) { store.deleteEverything() }
      } message: {
        Text("Восстановить будет нельзя.")
      }
    }
  }
}

struct ShareSheet: UIViewControllerRepresentable {
  let urls: [URL]
  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: urls, applicationActivities: nil)
  }
  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
