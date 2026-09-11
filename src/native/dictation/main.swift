import AVFoundation
import Foundation
import Speech

// maestro-dictation — on-device speech-to-text helper for macOS.
//
// Uses SFSpeechRecognizer + AVAudioEngine to transcribe the microphone entirely
// on-device (no API keys, no audio leaving the machine when the locale has an
// on-device model). The parent Electron process spawns one instance per
// dictation session and talks to it over stdio.
//
// stdout — line-delimited JSON, one object per line:
//   {"type":"capability","supported":Bool,"available":Bool,"onDevice":Bool,"authStatus":String}
//   {"type":"ready"}                         // mic is live, listening
//   {"type":"partial","text":String}         // running transcript (interim)
//   {"type":"final","text":String}           // last transcript; process then exits
//   {"type":"error","message":String}        // fatal; process then exits
// stdin — line-delimited commands: "stop" (also: EOF or SIGTERM) → finalize.
//
// Invoked with `--check` it prints one capability line and exits without
// touching the mic or prompting for permissions. `--lang=xx-YY` picks the
// recognition locale (defaults to en-US).

let emitLock = NSLock()
let stdoutHandle = FileHandle.standardOutput

func emit(_ obj: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(obj),
    var data = try? JSONSerialization.data(withJSONObject: obj)
  else { return }
  data.append(0x0A)  // newline
  emitLock.lock()
  stdoutHandle.write(data)
  emitLock.unlock()
}

func authString(_ s: SFSpeechRecognizerAuthorizationStatus) -> String {
  switch s {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "notDetermined"
  @unknown default: return "unknown"
  }
}

final class Dictation {
  private let locale: Locale
  private let recognizer: SFSpeechRecognizer?
  private let onDevice: Bool
  private let audioEngine = AVAudioEngine()

  // `request` is swapped on the recognition thread but appended to on the
  // realtime audio thread, so its pointer is guarded by a dedicated short-held
  // lock. Session state has its own lock, never held during the audio tap.
  private let reqLock = NSLock()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?

  private let stateLock = NSLock()
  private var committed = ""  // finalized text, accumulated across rotated requests
  private var running = false
  private var stopping = false
  private var finished = false

  init(langCode: String) {
    let loc = Locale(identifier: langCode)
    self.locale = loc
    let rec = SFSpeechRecognizer(locale: loc) ?? SFSpeechRecognizer()
    self.recognizer = rec
    if #available(macOS 13, *) {
      self.onDevice = rec?.supportsOnDeviceRecognition ?? false
    } else {
      self.onDevice = false
    }
  }

  func capability() -> [String: Any] {
    return [
      "type": "capability",
      "supported": recognizer != nil,
      "available": recognizer?.isAvailable ?? false,
      "onDevice": onDevice,
      "authStatus": authString(SFSpeechRecognizer.authorizationStatus()),
    ]
  }

  func start() {
    guard let recognizer = recognizer else {
      fail("Speech recognition isn’t available for this language.")
      return
    }
    // Speech-recognition authorization first (NSSpeechRecognitionUsageDescription),
    // then microphone (NSMicrophoneUsageDescription). Both prompt once, on first use.
    SFSpeechRecognizer.requestAuthorization { [weak self] status in
      guard let self = self else { return }
      guard status == .authorized else {
        self.fail(
          "Speech recognition permission was denied — enable it in System Settings › Privacy & Security › Speech Recognition."
        )
        return
      }
      AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
        guard let self = self else { return }
        guard granted else {
          self.fail(
            "Microphone access was denied — allow it in System Settings › Privacy & Security › Microphone."
          )
          return
        }
        self.beginAudio(recognizer)
      }
    }
  }

  private func beginAudio(_ recognizer: SFSpeechRecognizer) {
    let input = audioEngine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      guard let self = self else { return }
      self.reqLock.lock()
      let req = self.request
      self.reqLock.unlock()
      req?.append(buffer)
    }
    audioEngine.prepare()
    do {
      try audioEngine.start()
    } catch {
      fail("Couldn’t start the microphone: \(error.localizedDescription)")
      return
    }
    stateLock.lock()
    running = true
    stateLock.unlock()
    startRequest(recognizer)
    emit(["type": "ready"])
  }

  private func startRequest(_ recognizer: SFSpeechRecognizer) {
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    if #available(macOS 13, *) { req.requiresOnDeviceRecognition = onDevice }
    reqLock.lock()
    self.request = req
    reqLock.unlock()

    // One-shot guard so a request rotates/finishes exactly once, whether it ends
    // via a final result or an error.
    var settled = false
    let settle: () -> Void = { [weak self] in
      guard let self = self, !settled else { return }
      settled = true
      self.stateLock.lock()
      let stopping = self.stopping
      let running = self.running
      self.stateLock.unlock()
      if stopping {
        self.finishNow()
      } else if running {
        // Rotate to a fresh request so dictation continues past this utterance
        // (on-device has no server time cap, but the recognizer still finalizes
        // on natural pauses).
        self.startRequest(recognizer)
      }
    }

    task = recognizer.recognitionTask(with: req) { [weak self] result, error in
      guard let self = self else { return }
      if let result = result {
        let seg = result.bestTranscription.formattedString
        self.stateLock.lock()
        let base = self.committed
        let full = base.isEmpty ? seg : (seg.isEmpty ? base : base + " " + seg)
        if result.isFinal && !seg.isEmpty { self.committed = full }
        self.stateLock.unlock()
        if result.isFinal {
          settle()
          return
        }
        emit(["type": "partial", "text": full])
      }
      if error != nil { settle() }
    }
  }

  func stop() {
    stateLock.lock()
    let go = running && !stopping
    if go { stopping = true }
    stateLock.unlock()
    guard go else { return }
    audioEngine.stop()
    audioEngine.inputNode.removeTap(onBus: 0)
    reqLock.lock()
    let req = self.request
    reqLock.unlock()
    req?.endAudio()
    // If the recognizer doesn't deliver a final result promptly, finish anyway.
    DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) { [weak self] in
      self?.finishNow()
    }
  }

  private func fail(_ message: String) {
    emit(["type": "error", "message": message])
    exit(0)
  }

  private func finishNow() {
    stateLock.lock()
    if finished {
      stateLock.unlock()
      return
    }
    finished = true
    running = false
    let text = committed
    stateLock.unlock()
    task?.cancel()
    emit(["type": "final", "text": text])
    exit(0)
  }
}

// ---- entry point ----

var checkOnly = false
var langCode = "en-US"
for arg in CommandLine.arguments.dropFirst() {
  if arg == "--check" {
    checkOnly = true
  } else if arg.hasPrefix("--lang=") {
    langCode = String(arg.dropFirst("--lang=".count))
  }
}

let dictation = Dictation(langCode: langCode)

if checkOnly {
  emit(dictation.capability())
  exit(0)
}

// A "stop" line, or stdin EOF, ends the session gracefully; SIGTERM/SIGINT are
// the parent's hard fallback.
DispatchQueue.global().async {
  while let line = readLine(strippingNewline: true) {
    if line == "stop" { break }
  }
  dictation.stop()
}
signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

dictation.start()
dispatchMain()
