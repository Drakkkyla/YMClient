import AVKit
import SwiftUI

/// Full-screen pager over the vault: swipe between items, pinch / double-tap to zoom photos,
/// tap to hide the controls.
struct ViewerView: View {
  @EnvironmentObject var store: VaultStore
  @Environment(\.dismiss) private var dismiss
  @State private var index: Int
  @State private var chrome = true
  @State private var confirmDelete = false
  @State private var share: ShareFiles?

  init(start: Int) {
    _index = State(initialValue: start)
  }

  private var current: VaultItem? {
    store.items.indices.contains(index) ? store.items[index] : nil
  }

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      TabView(selection: $index) {
        ForEach(Array(store.items.enumerated()), id: \.element.id) { i, item in
          MediaPage(item: item, active: i == index).tag(i)
        }
      }
      .tabViewStyle(.page(indexDisplayMode: .never))
      .ignoresSafeArea()
      .onTapGesture { withAnimation(.easeInOut(duration: 0.2)) { chrome.toggle() } }

      if chrome { controls }
    }
    .statusBarHidden(!chrome)
    .sheet(item: $share, onDismiss: VaultStore.clearTemp) { files in
      ShareSheet(urls: files.urls)
    }
    .confirmationDialog("Удалить из Hush?", isPresented: $confirmDelete, titleVisibility: .visible) {
      Button("Удалить навсегда", role: .destructive) {
        if let item = current { store.delete([item.id]) }
      }
    }
    .onChange(of: store.items.count) { count in
      if count == 0 { dismiss() } else if index >= count { index = count - 1 }
    }
  }

  private var controls: some View {
    VStack {
      HStack {
        circleButton("xmark") { dismiss() }
        Spacer()
        if let item = current {
          Text(item.added.formatted(date: .abbreviated, time: .shortened))
            .font(.footnote.weight(.semibold))
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial, in: Capsule())
        }
        Spacer()
        circleButton("square.and.arrow.up") { shareCurrent() }
      }
      Spacer()
      HStack {
        Spacer()
        circleButton("trash") { confirmDelete = true }
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
    .transition(.opacity)
  }

  private func circleButton(_ icon: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: icon)
        .font(.system(size: 17, weight: .semibold))
        .frame(width: 44, height: 44)
        .background(.ultraThinMaterial, in: Circle())
    }
    .buttonStyle(.plain)
  }

  private func shareCurrent() {
    guard let item = current else { return }
    Task {
      if let url = await store.decryptToTemp(item) {
        await MainActor.run { share = ShareFiles(urls: [url]) }
      }
    }
  }
}

struct MediaPage: View {
  @EnvironmentObject var store: VaultStore
  let item: VaultItem
  let active: Bool
  @State private var image: UIImage?
  @State private var player: AVPlayer?
  @State private var videoURL: URL?

  var body: some View {
    Group {
      if item.kind == .video {
        if let player {
          VideoPlayer(player: player)
        } else {
          ProgressView()
        }
      } else if let image {
        ZoomableImage(image: image)
      } else {
        ProgressView()
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .task(id: item.id) { await load() }
    .onChange(of: active) { isActive in
      if !isActive { player?.pause() }
    }
    .onDisappear {
      player?.pause()
      if let url = videoURL { try? FileManager.default.removeItem(at: url) }
    }
  }

  private func load() async {
    if item.kind == .video {
      guard let url = await store.decryptToTemp(item) else { return }
      await MainActor.run {
        videoURL = url
        player = AVPlayer(url: url)
      }
    } else {
      let full = await store.fullImage(item)
      await MainActor.run { image = full }
    }
  }
}

/// UIScrollView-backed image: pinch to zoom, pan while zoomed, double-tap to zoom in/out.
struct ZoomableImage: UIViewRepresentable {
  let image: UIImage

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> UIScrollView {
    let scroll = UIScrollView()
    scroll.delegate = context.coordinator
    scroll.minimumZoomScale = 1
    scroll.maximumZoomScale = 5
    scroll.showsVerticalScrollIndicator = false
    scroll.showsHorizontalScrollIndicator = false
    scroll.backgroundColor = .clear
    scroll.contentInsetAdjustmentBehavior = .never

    let imageView = UIImageView(image: image)
    imageView.contentMode = .scaleAspectFit
    imageView.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(imageView)
    NSLayoutConstraint.activate([
      imageView.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
      imageView.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
      imageView.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
      imageView.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
      imageView.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
      imageView.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
    ])
    context.coordinator.imageView = imageView

    let doubleTap = UITapGestureRecognizer(
      target: context.coordinator, action: #selector(Coordinator.doubleTapped(_:)))
    doubleTap.numberOfTapsRequired = 2
    scroll.addGestureRecognizer(doubleTap)
    return scroll
  }

  func updateUIView(_ scroll: UIScrollView, context: Context) {
    context.coordinator.imageView?.image = image
  }

  final class Coordinator: NSObject, UIScrollViewDelegate {
    weak var imageView: UIImageView?

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

    @objc func doubleTapped(_ gesture: UITapGestureRecognizer) {
      guard let scroll = gesture.view as? UIScrollView else { return }
      if scroll.zoomScale > 1 {
        scroll.setZoomScale(1, animated: true)
        return
      }
      let point = gesture.location(in: imageView)
      let size = CGSize(width: scroll.bounds.width / 2.5, height: scroll.bounds.height / 2.5)
      scroll.zoom(
        to: CGRect(
          x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width,
          height: size.height), animated: true)
    }
  }
}
