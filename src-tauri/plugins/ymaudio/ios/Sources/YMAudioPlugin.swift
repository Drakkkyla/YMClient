// YMClient's native audio engine for iOS (driven from src/lib/player.js).
//
// Graph:  deck0.player → deck0.mixer ┐
//         deck1.player → deck1.mixer ┴→ sum → eq (10 bands) → mainMixer → output
//
// Two decks let tracks overlap for crossfades; each deck's mixer volume carries loudness
// normalization and fades. Tracks are downloaded to the caches folder first (AVAudioPlayerNode
// plays files, not HTTP streams).
//
// Native owns the "what plays next" decision: iOS freezes the WKWebView's JavaScript ~30 s
// after the app is backgrounded, so JS hands us the next few tracks (`setQueue`) and we advance
// on our own — at the crossfade point or gaplessly at the end — and handle lock-screen
// controls natively. JS catches up from the `advanced` events whenever it runs again.
//
// Events to JS (addPluginListener("ymaudio", …)):
//   state    { deck, token, position, duration, playing }   ~4×/s while playing, and on changes
//   advanced { deck, token, key }   native moved on to the next queued track
//   ended    { deck, token }        current track finished and nothing was queued
//   remote   { command: next|prev|slept } lock-screen skips native couldn't serve; sleep timer fired
//   spectrum { bins: [Int] }        128 analyser-style bins (0…255), ~20×/s while app is visible

import AVFoundation
import Accelerate
import MediaPlayer
import Tauri
import UIKit
import WebKit

struct DeckArgs: Decodable { let deck: Int }
struct LoadArgs: Decodable {
  let deck: Int
  let token: Int
  let key: String
  let url: String
}
struct PreloadArgs: Decodable {
  let key: String
  let url: String
}
struct SeekArgs: Decodable {
  let deck: Int
  let position: Double
}
struct GainArgs: Decodable {
  let deck: Int
  let value: Float
  let seconds: Double?
}
struct EqArgs: Decodable {
  let enabled: Bool
  let gains: [Float]
  let preamp: Float
}
struct NowPlayingArgs: Decodable {
  let title: String
  let artist: String
  let album: String?
  let artwork: String?
  let duration: Double?
}
struct QueueItem: Decodable {
  let token: Int
  let key: String
  let url: String
  let gain: Float
  /// Position (s) in this track where the transition to the following one should begin.
  let fadeAt: Double?
  let title: String
  let artist: String
  let album: String?
  let artwork: String?
  let duration: Double?
}
struct SleepArgs: Decodable { let seconds: Double? }
struct HapticArgs: Decodable { let style: String? }
struct QueueArgs: Decodable {
  let items: [QueueItem]
  let crossfade: Double
  let currentFadeAt: Double?
}

final class Deck {
  let index: Int
  let player = AVAudioPlayerNode()
  let mixer = AVAudioMixerNode()
  var file: AVAudioFile?
  var format: AVAudioFormat?
  var token = 0
  /// Frame the current schedule started from (player time counts from there).
  var offset: AVAudioFramePosition = 0
  var pausedAt: Double = 0
  /// Bumped on every stop/seek/hand-off so completion callbacks of old schedules are ignored.
  var generation = 0
  var rampTimer: Timer?

  init(index: Int) { self.index = index }

  var sampleRate: Double { file?.processingFormat.sampleRate ?? 44100 }
  var duration: Double {
    guard let f = file else { return 0 }
    return Double(f.length) / f.processingFormat.sampleRate
  }
  var position: Double {
    guard file != nil else { return 0 }
    if player.isPlaying, let nodeTime = player.lastRenderTime,
      let t = player.playerTime(forNodeTime: nodeTime)
    {
      return max(0, min(duration, Double(offset + t.sampleTime) / sampleRate))
    }
    return pausedAt
  }
}

class YMAudioPlugin: Plugin {
  private let engine = AVAudioEngine()
  private let sum = AVAudioMixerNode()
  private let eq = AVAudioUnitEQ(numberOfBands: 10)
  private let decks = [Deck(index: 0), Deck(index: 1)]
  private var current = 0
  private var stateTimer: Timer?
  private var nowPlayingInfo: [String: Any] = [:]
  private var appActive = true
  private var resumeAfterInterruption = false

  // queue handed over by JS
  private var upcoming: [QueueItem] = []
  private var crossfadeSeconds: Double = 0
  private var currentFadeAt: Double?
  private var advancing = false
  private var sleepWork: DispatchWorkItem?

  // download cache: key (track id) → local file
  private var cached: [String: URL] = [:]
  private var cacheOrder: [String] = []
  private var pending: [String: [(Result<URL, Error>) -> Void]] = [:]

  // spectrum
  private let fftSize = 1024
  private lazy var fftSetup = vDSP_create_fftsetup(vDSP_Length(10), FFTRadix(kFFTRadix2))
  private lazy var window: [Float] = {
    var w = [Float](repeating: 0, count: fftSize)
    vDSP_hann_window(&w, vDSP_Length(fftSize), Int32(vDSP_HANN_NORM))
    return w
  }()
  private var smoothed = [Float](repeating: 0, count: 128)
  private var lastSpectrum = Date.distantPast

  // MARK: - lifecycle

  @objc public override func load(webview: WKWebView) {
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playback, mode: .default, options: [])
    try? session.setActive(true)

    engine.attach(sum)
    engine.attach(eq)
    for d in decks {
      engine.attach(d.player)
      engine.attach(d.mixer)
      engine.connect(d.player, to: d.mixer, format: nil)
      engine.connect(d.mixer, to: sum, fromBus: 0, toBus: d.index, format: nil)
      d.mixer.outputVolume = 1
    }
    engine.connect(sum, to: eq, format: nil)
    engine.connect(eq, to: engine.mainMixerNode, format: nil)
    configureEq()
    // Build the FFT state now: the tap closure runs on the audio thread and must not race a lazy init.
    _ = fftSetup
    _ = window
    installSpectrumTap()
    engine.prepare()

    setupRemoteCommands()
    let nc = NotificationCenter.default
    nc.addObserver(
      self, selector: #selector(onInterruption(_:)),
      name: AVAudioSession.interruptionNotification, object: session)
    nc.addObserver(
      self, selector: #selector(onRouteChange(_:)),
      name: AVAudioSession.routeChangeNotification, object: session)
    nc.addObserver(
      self, selector: #selector(onEngineConfigChange(_:)),
      name: .AVAudioEngineConfigurationChange, object: engine)
    nc.addObserver(
      self, selector: #selector(onActive), name: UIApplication.didBecomeActiveNotification,
      object: nil)
    nc.addObserver(
      self, selector: #selector(onInactive), name: UIApplication.willResignActiveNotification,
      object: nil)

    stateTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      self?.tick()
    }
  }

  private func startEngine() {
    if !engine.isRunning {
      try? AVAudioSession.sharedInstance().setActive(true)
      try? engine.start()
    }
  }

  // MARK: - commands

  /// Load a track into a deck and make it the current one (manual play / skip from JS).
  @objc public func load(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(LoadArgs.self)
    guard deck(args.deck) != nil, let url = URL(string: args.url) else {
      invoke.reject("bad arguments")
      return
    }
    // A manual load supersedes whatever was playing or fading on either deck.
    decks.forEach { stopDeck($0) }
    current = args.deck
    currentFadeAt = nil
    advancing = false
    fetch(key: args.key, url: url) { [weak self] result in
      DispatchQueue.main.async {
        guard let self = self else { return }
        switch result {
        case .failure(let error):
          invoke.reject("download failed: \(error.localizedDescription)")
        case .success(let local):
          do {
            let d = self.decks[args.deck]
            let file = try AVAudioFile(forReading: local)
            self.stopDeck(d)
            self.connect(d, for: file)
            d.file = file
            d.token = args.token
            d.pausedAt = 0
            self.schedule(d, from: 0)
            self.startEngine()
            invoke.resolve(["duration": d.duration])
          } catch {
            invoke.reject("cannot open audio: \(error.localizedDescription)")
          }
        }
      }
    }
  }

  @objc public func preload(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PreloadArgs.self)
    if let url = URL(string: args.url) { fetch(key: args.key, url: url) { _ in } }
    invoke.resolve()
  }

  /// The next few tracks, in order. Replaces the previous queue; downloads them ahead.
  @objc public func setQueue(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(QueueArgs.self)
    upcoming = args.items
    crossfadeSeconds = max(0, args.crossfade)
    currentFadeAt = args.currentFadeAt
    for item in upcoming {
      if let url = URL(string: item.url) { fetch(key: item.key, url: url) { _ in } }
    }
    invoke.resolve()
  }

  @objc public func play(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(DeckArgs.self)
    guard let d = deck(args.deck), d.file != nil else {
      invoke.reject("nothing loaded")
      return
    }
    resume(d)
    invoke.resolve()
  }

  @objc public func pause(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(DeckArgs.self)
    if let d = deck(args.deck) { pause(d) }
    invoke.resolve()
  }

  @objc public func seek(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SeekArgs.self)
    if let d = deck(args.deck) { seek(d, to: args.position) }
    invoke.resolve()
  }

  @objc public func stop(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(DeckArgs.self)
    if let d = deck(args.deck) {
      stopDeck(d)
      d.file = nil
      d.pausedAt = 0
    }
    invoke.resolve()
  }

  /// Deck volume (normalization × fade). `seconds` > 0 ramps linearly.
  @objc public func gain(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(GainArgs.self)
    if let d = deck(args.deck) {
      ramp(d, to: max(0, min(4, args.value)), seconds: args.seconds ?? 0)
    }
    invoke.resolve()
  }

  @objc public func setEq(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(EqArgs.self)
    eq.bypass = !args.enabled
    eq.globalGain = args.enabled ? max(-12, min(12, args.preamp)) : 0
    for (i, band) in eq.bands.enumerated() where i < args.gains.count {
      band.gain = max(-12, min(12, args.gains[i]))
    }
    invoke.resolve()
  }

  /// Sleep timer: fade out and pause after `seconds` (nil/0 cancels). Native because JS is
  /// frozen while the screen is locked — exactly when a sleep timer matters.
  @objc public func sleep(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(SleepArgs.self)
    sleepWork?.cancel()
    sleepWork = nil
    if let s = args.seconds, s > 0 {
      let work = DispatchWorkItem { [weak self] in self?.fallAsleep() }
      sleepWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: work)
    }
    invoke.resolve()
  }

  private func fallAsleep() {
    sleepWork = nil
    let d = decks[current]
    guard d.player.isPlaying else { return }
    let restore = d.mixer.outputVolume
    let token = d.token
    ramp(d, to: 0, seconds: 8)
    DispatchQueue.main.asyncAfter(deadline: .now() + 8.2) { [weak self] in
      guard let self = self else { return }
      if d.token == token { self.pause(d) }
      d.mixer.outputVolume = restore
      let data: JSObject = ["command": "slept"]
      self.trigger("remote", data: data)
    }
  }

  /// Taptic feedback for UI taps (the webview has no vibration API on iOS).
  @objc public func haptic(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(HapticArgs.self)
    DispatchQueue.main.async {
      switch args.style ?? "light" {
      case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      case "rigid": UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
      case "selection": UISelectionFeedbackGenerator().selectionChanged()
      case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
      default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
      }
    }
    invoke.resolve()
  }

  @objc public func nowPlaying(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(NowPlayingArgs.self)
    setNowPlaying(
      title: args.title, artist: args.artist, album: args.album, artwork: args.artwork,
      duration: args.duration)
    invoke.resolve()
  }

  // MARK: - playback internals

  private func deck(_ i: Int) -> Deck? { i >= 0 && i < decks.count ? decks[i] : nil }

  private func stopDeck(_ d: Deck) {
    d.generation += 1
    d.rampTimer?.invalidate()
    d.rampTimer = nil
    d.player.stop()
  }

  private func resume(_ d: Deck) {
    guard d.file != nil else { return }
    startEngine()
    d.player.play()
    updateNowPlayingTime()
    emitState(d)
  }

  private func pause(_ d: Deck) {
    d.pausedAt = d.position
    d.player.pause()
    updateNowPlayingTime()
    emitState(d)
  }

  private func seek(_ d: Deck, to position: Double) {
    guard let file = d.file else { return }
    let wasPlaying = d.player.isPlaying
    stopDeck(d)
    let frame = min(file.length, AVAudioFramePosition(max(0, min(position, d.duration)) * d.sampleRate))
    schedule(d, from: frame)
    d.pausedAt = Double(frame) / d.sampleRate
    if wasPlaying {
      startEngine()
      d.player.play()
    }
    updateNowPlayingTime()
    emitState(d)
  }

  /// Reconnect the player when a file's format differs (mono, 48 kHz…). Rare: most are 44.1k stereo.
  private func connect(_ d: Deck, for file: AVAudioFile) {
    let fmt = file.processingFormat
    if let cur = d.format, cur.sampleRate == fmt.sampleRate, cur.channelCount == fmt.channelCount {
      return
    }
    engine.disconnectNodeOutput(d.player)
    engine.connect(d.player, to: d.mixer, format: fmt)
    d.format = fmt
  }

  private func schedule(_ d: Deck, from frame: AVAudioFramePosition) {
    guard let file = d.file else { return }
    d.generation += 1
    let gen = d.generation
    d.offset = frame
    let remaining = file.length - frame
    guard remaining > 0 else { return }
    d.player.scheduleSegment(
      file, startingFrame: frame, frameCount: AVAudioFrameCount(remaining), at: nil,
      completionCallbackType: .dataPlayedBack
    ) { [weak self] _ in
      DispatchQueue.main.async {
        guard let self = self, d.generation == gen else { return }
        self.finished(d)
      }
    }
  }

  /// A deck played to its end.
  private func finished(_ d: Deck) {
    d.pausedAt = d.duration
    guard d.index == current else { return }
    if !upcoming.isEmpty {
      advance(fade: 0)
    } else {
      emitState(d)
      let data: JSObject = ["deck": d.index, "token": d.token]
      trigger("ended", data: data)
    }
  }

  /// Start the first queued track on the other deck (crossfading over `fade` seconds).
  private func advance(fade: Double) {
    guard !advancing, !upcoming.isEmpty else { return }
    let item = upcoming.removeFirst()
    guard let url = URL(string: item.url) else {
      advance(fade: 0)
      return
    }
    advancing = true
    let old = decks[current]
    let next = decks[1 - current]
    let oldToken = old.token
    fetch(key: item.key, url: url) { [weak self] result in
      DispatchQueue.main.async {
        guard let self = self else { return }
        self.advancing = false
        // A manual load from JS may have taken over while we were downloading.
        guard self.current == old.index, old.token == oldToken else { return }
        guard case .success(let local) = result, let file = try? AVAudioFile(forReading: local)
        else {
          // Unplayable: try the one after it.
          if !self.upcoming.isEmpty { self.advance(fade: 0) }
          return
        }
        self.stopDeck(next)
        self.connect(next, for: file)
        next.file = file
        next.token = item.token
        next.pausedAt = 0
        self.schedule(next, from: 0)
        next.mixer.outputVolume = fade > 0 ? 0 : item.gain
        self.startEngine()
        next.player.play()

        old.generation += 1  // its end no longer means anything
        if fade > 0 {
          self.ramp(next, to: item.gain, seconds: fade)
          self.ramp(old, to: 0, seconds: fade)
          DispatchQueue.main.asyncAfter(deadline: .now() + fade + 0.1) { [weak self] in
            guard let self = self, old.token == oldToken, self.current != old.index else { return }
            self.stopDeck(old)
            old.file = nil
          }
        } else {
          self.stopDeck(old)
          old.file = nil
        }

        self.current = next.index
        self.currentFadeAt = item.fadeAt
        self.setNowPlaying(
          title: item.title, artist: item.artist, album: item.album, artwork: item.artwork,
          duration: item.duration)
        let data: JSObject = ["deck": next.index, "token": item.token, "key": item.key]
        self.trigger("advanced", data: data)
        self.emitState(next)
      }
    }
  }

  private func ramp(_ d: Deck, to target: Float, seconds: Double) {
    d.rampTimer?.invalidate()
    d.rampTimer = nil
    guard seconds > 0 else {
      d.mixer.outputVolume = target
      return
    }
    let start = d.mixer.outputVolume
    let began = Date()
    d.rampTimer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { timer in
      let t = min(1, Date().timeIntervalSince(began) / seconds)
      d.mixer.outputVolume = start + (target - start) * Float(t)
      if t >= 1 {
        timer.invalidate()
        if d.rampTimer === timer { d.rampTimer = nil }
      }
    }
  }

  private func configureEq() {
    let freqs: [Float] = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
    for (i, band) in eq.bands.enumerated() {
      band.frequency = freqs[i]
      band.filterType = i == 0 ? .lowShelf : (i == freqs.count - 1 ? .highShelf : .parametric)
      band.bandwidth = 1.0
      band.gain = 0
      band.bypass = false
    }
    eq.bypass = true
  }

  // MARK: - timer: state events + crossfade point

  private func tick() {
    for d in decks where d.file != nil && d.player.isPlaying {
      emitState(d)
    }
    let d = decks[current]
    guard crossfadeSeconds > 0, !advancing, !upcoming.isEmpty, d.player.isPlaying, d.file != nil
    else { return }
    let dur = d.duration
    var at = currentFadeAt ?? (dur - crossfadeSeconds)
    if at < 0 || at > dur - 0.5 { at = dur - crossfadeSeconds }
    at = max(at, dur * 0.5)
    let left = dur - d.position
    if d.position >= at && left > 0.5 {
      advance(fade: min(crossfadeSeconds, left))
    }
  }

  private func emitState(_ d: Deck) {
    let data: JSObject = [
      "deck": d.index,
      "token": d.token,
      "position": d.position,
      "duration": d.duration,
      "playing": d.player.isPlaying,
    ]
    trigger("state", data: data)
  }

  // MARK: - Now Playing / lock screen

  private func setNowPlaying(
    title: String, artist: String, album: String?, artwork: String?, duration: Double?
  ) {
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: title,
      MPMediaItemPropertyArtist: artist,
    ]
    if let album = album { info[MPMediaItemPropertyAlbumTitle] = album }
    if let duration = duration, duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
    nowPlayingInfo = info
    updateNowPlayingTime()

    guard let s = artwork, let url = URL(string: s) else { return }
    URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
      guard let data = data, let image = UIImage(data: data) else { return }
      DispatchQueue.main.async {
        guard let self = self, self.nowPlayingInfo[MPMediaItemPropertyTitle] as? String == title
        else { return }
        self.nowPlayingInfo[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(
          boundsSize: image.size
        ) { _ in image }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = self.nowPlayingInfo
      }
    }.resume()
  }

  private func updateNowPlayingTime() {
    guard !nowPlayingInfo.isEmpty else { return }
    let d = decks[current]
    nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = d.position
    nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = d.player.isPlaying ? 1.0 : 0.0
    if d.duration > 0 { nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = d.duration }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
  }

  /// Lock-screen controls are served natively: JS may be frozen while the screen is locked.
  private func setupRemoteCommands() {
    let cc = MPRemoteCommandCenter.shared()
    cc.playCommand.addTarget { [weak self] _ in
      guard let self = self else { return .commandFailed }
      self.resume(self.decks[self.current])
      return .success
    }
    cc.pauseCommand.addTarget { [weak self] _ in
      guard let self = self else { return .commandFailed }
      self.pause(self.decks[self.current])
      return .success
    }
    cc.togglePlayPauseCommand.addTarget { [weak self] _ in
      guard let self = self else { return .commandFailed }
      let d = self.decks[self.current]
      if d.player.isPlaying { self.pause(d) } else { self.resume(d) }
      return .success
    }
    cc.nextTrackCommand.addTarget { [weak self] _ in
      guard let self = self else { return .commandFailed }
      if !self.upcoming.isEmpty {
        self.advance(fade: 0)
      } else {
        let data: JSObject = ["command": "next"]
        self.trigger("remote", data: data)
      }
      return .success
    }
    cc.previousTrackCommand.addTarget { [weak self] _ in
      guard let self = self else { return .commandFailed }
      let d = self.decks[self.current]
      if d.position > 3 {
        self.seek(d, to: 0)
      } else {
        let data: JSObject = ["command": "prev"]
        self.trigger("remote", data: data)
      }
      return .success
    }
    cc.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard let self = self, let e = event as? MPChangePlaybackPositionCommandEvent else {
        return .commandFailed
      }
      self.seek(self.decks[self.current], to: e.positionTime)
      return .success
    }
  }

  @objc private func onInterruption(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: raw)
    else { return }
    DispatchQueue.main.async {
      let d = self.decks[self.current]
      if type == .began {
        self.resumeAfterInterruption = d.player.isPlaying
        self.pause(d)
      } else if let optRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt,
        AVAudioSession.InterruptionOptions(rawValue: optRaw).contains(.shouldResume),
        self.resumeAfterInterruption
      {
        self.resumeAfterInterruption = false
        self.resume(d)
      }
    }
  }

  @objc private func onRouteChange(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
      AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable
    else { return }
    // Headphones unplugged: pause like every iOS player does.
    DispatchQueue.main.async { self.pause(self.decks[self.current]) }
  }

  @objc private func onEngineConfigChange(_ note: Notification) {
    DispatchQueue.main.async {
      let playing = self.decks.filter { $0.player.isPlaying }
      self.startEngine()
      for d in playing { d.player.play() }
    }
  }

  @objc private func onActive() { appActive = true }
  @objc private func onInactive() { appActive = false }

  // MARK: - downloads

  private func cacheDir() -> URL {
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("ymaudio", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  /// Downloads a track once; concurrent requests for the same key share the download.
  private func fetch(key: String, url: URL, done: @escaping (Result<URL, Error>) -> Void) {
    DispatchQueue.main.async {
      if let local = self.cached[key], FileManager.default.fileExists(atPath: local.path) {
        done(.success(local))
        return
      }
      if self.pending[key] != nil {
        self.pending[key]!.append(done)
        return
      }
      self.pending[key] = [done]
      let safe = key.replacingOccurrences(
        of: "[^A-Za-z0-9_-]", with: "_", options: .regularExpression)
      let dest = self.cacheDir().appendingPathComponent("\(safe).mp3")
      URLSession.shared.downloadTask(with: url) { tmp, response, error in
        var result: Result<URL, Error>
        let status = (response as? HTTPURLResponse)?.statusCode ?? 200
        if let tmp = tmp, error == nil, (200..<300).contains(status) {
          do {
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: tmp, to: dest)
            result = .success(dest)
          } catch {
            result = .failure(error)
          }
        } else {
          result = .failure(
            error
              ?? NSError(
                domain: "ymaudio", code: status,
                userInfo: [NSLocalizedDescriptionKey: "HTTP \(status)"]))
        }
        DispatchQueue.main.async {
          if case .success(let local) = result { self.remember(key: key, file: local) }
          let callbacks = self.pending.removeValue(forKey: key) ?? []
          callbacks.forEach { $0(result) }
        }
      }.resume()
    }
  }

  /// Keep the last few tracks on disk; never evict a file a deck is playing.
  private func remember(key: String, file: URL) {
    cached[key] = file
    cacheOrder.removeAll { $0 == key }
    cacheOrder.append(key)
    let inUse = Set(decks.compactMap { $0.file?.url })
    var checked = 0
    while cacheOrder.count > 8 && checked < cacheOrder.count {
      let old = cacheOrder.removeFirst()
      checked += 1
      if let f = cached[old], !inUse.contains(f) {
        try? FileManager.default.removeItem(at: f)
        cached.removeValue(forKey: old)
      } else {
        cacheOrder.append(old)
      }
    }
  }

  // MARK: - spectrum (feeds the same visualizer as Web Audio's AnalyserNode on desktop)

  private func installSpectrumTap() {
    engine.mainMixerNode.installTap(onBus: 0, bufferSize: AVAudioFrameCount(fftSize), format: nil) {
      [weak self] buffer, _ in
      self?.analyse(buffer)
    }
  }

  private func analyse(_ buffer: AVAudioPCMBuffer) {
    guard appActive, let setup = fftSetup, let channel = buffer.floatChannelData?[0],
      Int(buffer.frameLength) >= fftSize
    else { return }
    let now = Date()
    guard now.timeIntervalSince(lastSpectrum) >= 0.05 else { return }
    lastSpectrum = now

    let n = fftSize
    var samples = [Float](repeating: 0, count: n)
    vDSP_vmul(channel, 1, window, 1, &samples, 1, vDSP_Length(n))
    var real = [Float](repeating: 0, count: n / 2)
    var imag = [Float](repeating: 0, count: n / 2)
    var mags = [Float](repeating: 0, count: n / 2)
    real.withUnsafeMutableBufferPointer { rp in
      imag.withUnsafeMutableBufferPointer { ip in
        var split = DSPSplitComplex(realp: rp.baseAddress!, imagp: ip.baseAddress!)
        samples.withUnsafeBufferPointer { sp in
          sp.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: n / 2) {
            vDSP_ctoz($0, 2, &split, 1, vDSP_Length(n / 2))
          }
        }
        vDSP_fft_zrip(setup, &split, 1, vDSP_Length(10), FFTDirection(FFT_FORWARD))
        vDSP_zvabs(&split, 1, &mags, 1, vDSP_Length(n / 2))
      }
    }

    // Pairs of 1024-point bins ≈ the desktop analyser's 512-point bins; same dB → byte scale
    // (minDecibels -100, maxDecibels -30) and 0.8 smoothing.
    var bins = [Int](repeating: 0, count: 128)
    for i in 0..<128 {
      let m = (mags[2 * i] + mags[2 * i + 1]) / Float(n)
      let db = 20 * log10(max(m, 1e-9))
      let v = max(0, min(255, (db + 100) / 70 * 255))
      smoothed[i] = smoothed[i] * 0.8 + v * 0.2
      bins[i] = Int(smoothed[i])
    }
    DispatchQueue.main.async {
      let data: JSObject = ["bins": bins]
      self.trigger("spectrum", data: data)
    }
  }
}

@_cdecl("init_plugin_ymaudio")
func initPlugin() -> Plugin {
  return YMAudioPlugin()
}
