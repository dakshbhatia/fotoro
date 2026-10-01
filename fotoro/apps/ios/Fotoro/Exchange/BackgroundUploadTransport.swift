import CryptoKit
import Foundation
import Observation

@MainActor @Observable final class BackgroundUploadTransport: NSObject, URLSessionDelegate,
  URLSessionTaskDelegate
{
  static let sessionIdentifier = "cloud.fotoro.encrypted-uploads.v1"
  static let shared = BackgroundUploadTransport()
  private let ledger: BackgroundUploadLedger?
  private let root: URL
  private(set) var revision = 0
  private(set) var storageError: String?
  @ObservationIgnored private var backgroundCompletion: (() -> Void)?
  @ObservationIgnored private var reconnection: Task<Void, Never>?
  @ObservationIgnored private var waiters: [String: (BackgroundUploadIdentity, CheckedContinuation<Void, Error>)] = [:]
  @ObservationIgnored private lazy var urlSession: URLSession = {
    let configuration = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
    configuration.sessionSendsLaunchEvents = true
    configuration.isDiscretionary = false
    configuration.waitsForConnectivity = true
    configuration.httpMaximumConnectionsPerHost = BackgroundUploadPolicy.maximumTasks
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForResource = 60 * 60
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    return URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
  }()

  private override init() {
    root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("FotoroBackgroundUploads", isDirectory: true)
    do { ledger = try BackgroundUploadLedger(root: root) }
    catch { ledger = nil; storageError = "Background upload receipts are unavailable; open Fotoro to retry" }
    super.init()
    var directory = root
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? directory.setResourceValues(values)
  }

  func configure(accountId: String?, fixture: Bool, baseURL: URL) throws {
    guard let ledger else { throw BackgroundUploadFailure(message: storageError ?? "Upload receipts unavailable") }
    try ledger.authorize(accountId: accountId, fixture: fixture, baseURL: baseURL)
    storageError = nil
    interruptWaiters(where: { !ledger.accepts($0) })
    revision += 1
    reconnect()
  }

  // Recreate the same session before querying tasks: iOS delivers daemon-owned tasks and receipts.
  func reconnect() {
    guard reconnection == nil, let ledger else { return }
    reconnection = Task {
      let tasks = await urlSession.allTasks
      var live: Set<BackgroundUploadIdentity> = []
      for task in tasks {
        guard let identity = try? BackgroundUploadIdentity.decode(task.taskDescription),
          ledger.accepts(identity), let record = try? ledger.record(identity),
          record.state == .transferring,
          BackgroundUploadPolicy.validTaskRequest(
            task.originalRequest, identity: identity, authorizedOrigin: ledger.authorizedOrigin)
        else { task.cancel(); continue }
        live.insert(identity)
        if task.state == .suspended { task.resume() }
      }
      do { try ledger.reconcile(live: live) }
      catch { storageError = "Upload receipt could not be saved; unlock and resume to reconcile" }
      revision += 1
      resumeFinishedWaiters()
      reconnection = nil
    }
  }

  func handleEvents(identifier: String, completion: @escaping () -> Void) {
    guard identifier == Self.sessionIdentifier else { completion(); return }
    backgroundCompletion = completion
    if ledger == nil {
      // A damaged or inaccessible receipt ledger cannot authorize orphaned tasks. Reconnect
      // only to cancel and drain their delegate events before releasing the system callback.
      urlSession.getAllTasks { tasks in tasks.forEach { $0.cancel() } }
      return
    }
    reconnect()
  }

  func records(accountId: String?) -> [BackgroundUploadRecord] {
    _ = revision
    guard let accountId, let ledger else { return [] }
    return (try? ledger.records(accountId: accountId)) ?? []
  }

  func upload(file: URL, pendingDirectory: URL, representation: RepresentationV1,
    reservation: UploadReservationV1, accountId: String, baseURL: URL,
    stillAuthorized: @MainActor () -> Bool) async throws
  {
    guard let ledger else { throw BackgroundUploadFailure(message: storageError ?? "Upload receipts unavailable") }
    reconnect()
    await reconnection?.value
    let binding = representation.binding
    guard stillAuthorized() else { throw CancellationError() }
    guard reservation.version == 1, reservation.photoId == binding.photoId,
      reservation.representationId == binding.representationId
    else { throw BackgroundUploadFailure(message: "Upload reservation binding mismatch") }
    let request = try BackgroundUploadPolicy.request(
      stagingURL: reservation.stagingUrl, baseURL: baseURL, uploadId: reservation.uploadId,
      bytes: representation.ciphertextBytes)
    if let previous = try ledger.records(accountId: accountId).first(where: {
      $0.identity.photoId == binding.photoId && $0.identity.representationId == binding.representationId
        && $0.identity.uploadId == reservation.uploadId
        && $0.ciphertextSha256 == representation.ciphertextSha256
        && $0.ciphertextBytes == representation.ciphertextBytes
        && ($0.state == .uploaded || $0.state == .transferring)
    }) {
      try await wait(for: previous.identity)
      return
    }
    guard let expiry = Wire.parseDate(reservation.expiresAt), expiry > Date() else {
      throw BackgroundUploadFailure(message: "Upload permission expired; unlock Fotoro and resume")
    }
    let identity = BackgroundUploadIdentity(
      accountId: accountId, photoId: binding.photoId, representationId: binding.representationId,
      uploadId: reservation.uploadId)
    guard ledger.accepts(identity) else {
      throw BackgroundUploadFailure(message: "Sign in to the source account to resume uploads")
    }
    let destination = root.appendingPathComponent(identity.attemptId + ".bin")
    try await Task.detached(priority: .utility) {
      try BackgroundCiphertext.prepare(
        source: file, pendingDirectory: pendingDirectory, destination: destination,
        bytes: representation.ciphertextBytes, sha256: representation.ciphertextSha256,
        header: representation.header)
    }.value
    do {
      try Task.checkCancellation()
      guard ledger.accepts(identity), stillAuthorized() else { throw CancellationError() }
      try ledger.register(
        identity, ciphertextBytes: representation.ciphertextBytes,
        ciphertextSha256: representation.ciphertextSha256)
      let task = urlSession.uploadTask(with: request, fromFile: destination)
      task.taskDescription = identity.taskDescription
      task.countOfBytesClientExpectsToSend = Int64(representation.ciphertextBytes)
      task.countOfBytesClientExpectsToReceive = 1024
      task.resume()
      revision += 1
    } catch {
      try? FileManager.default.removeItem(at: destination)
      throw error
    }
    try await wait(for: identity)
  }

  private func wait(for identity: BackgroundUploadIdentity) async throws {
    let token = UUID().uuidString
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        if Task.isCancelled { continuation.resume(throwing: CancellationError()); return }
        waiters[token] = (identity, continuation)
        resumeFinishedWaiters()
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        self?.waiters.removeValue(forKey: token)?.1.resume(throwing: CancellationError())
      }
    }
  }
  private func resumeFinishedWaiters() {
    guard let ledger else { return }
    for (token, (identity, continuation)) in waiters {
      guard let record = try? ledger.record(identity) else {
        waiters.removeValue(forKey: token)
        continuation.resume(throwing: CancellationError())
        continue
      }
      guard record.state != .transferring else { continue }
      waiters.removeValue(forKey: token)
      if record.state == .uploaded { continuation.resume() }
      else if record.state == .cancelled { continuation.resume(throwing: CancellationError()) }
      else { continuation.resume(throwing: BackgroundUploadFailure(message: record.message ?? "Upload needs retry")) }
    }
  }
  private func interruptWaiters(where shouldInterrupt: (BackgroundUploadIdentity) -> Bool) {
    for (token, (identity, continuation)) in waiters where shouldInterrupt(identity) {
      waiters.removeValue(forKey: token)
      continuation.resume(throwing: CancellationError())
    }
  }
  func interruptWaiters(accountId: String?) {
    interruptWaiters(where: { accountId == nil || $0.accountId == accountId })
  }
  func cancel(accountId: String, photoId: String? = nil) throws {
    guard let ledger else { throw BackgroundUploadFailure(message: "Upload receipts unavailable") }
    try ledger.cancel(accountId: accountId, photoId: photoId)
    interruptWaiters(where: { $0.accountId == accountId && (photoId == nil || $0.photoId == photoId) })
    revision += 1
    urlSession.getAllTasks { tasks in
      for task in tasks {
        guard let id = try? BackgroundUploadIdentity.decode(task.taskDescription),
          id.accountId == accountId, photoId == nil || id.photoId == photoId else { continue }
        task.cancel()
      }
    }
  }
  func forget(accountId: String, photoId: String) throws {
    let records = records(accountId: accountId).filter { $0.identity.photoId == photoId }
    try ledger?.forget(accountId: accountId, photoId: photoId)
    for record in records {
      try? FileManager.default.removeItem(at: root.appendingPathComponent(record.identity.attemptId + ".bin"))
    }
    revision += 1
  }

  nonisolated func urlSession(_ session: URLSession, task: URLSessionTask,
    didCompleteWithError error: Error?)
  {
    guard let identity = try? BackgroundUploadIdentity.decode(task.taskDescription), let ledger else { return }
    let response = task.response as? HTTPURLResponse
    let validRequest = BackgroundUploadPolicy.validTaskRequest(
      task.originalRequest, identity: identity, authorizedOrigin: ledger.authorizedOrigin)
    // Apple follows background redirects without calling the redirect delegate. The dedicated
    // server route must never redirect; reject an unexpected final URL and do not promote it.
    let sameURL = response?.url == task.originalRequest?.url
    do {
      try ledger.complete(
        identity, statusCode: response?.statusCode, responseURL: response?.url,
        errorCode: validRequest && sameURL ? (error as NSError?)?.code : NSURLErrorHTTPTooManyRedirects)
      try? FileManager.default.removeItem(at: ledger.root.appendingPathComponent(identity.attemptId + ".bin"))
      Task { @MainActor [weak self] in
        self?.storageError = nil
        self?.revision += 1
        self?.resumeFinishedWaiters()
      }
    } catch {
      Task { @MainActor [weak self] in
        self?.storageError = "Upload receipt could not be saved; unlock and resume to reconcile"
        self?.interruptWaiters(accountId: identity.accountId)
      }
    }
  }

  nonisolated func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    // didComplete persists on the serial delegate queue before this callback is delivered.
    Task { @MainActor [weak self] in
      let completion = self?.backgroundCompletion
      self?.backgroundCompletion = nil
      completion?()
    }
  }

  nonisolated func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void)
  {
    completionHandler(nil)
  }
  nonisolated func urlSession(_ session: URLSession, task: URLSessionTask,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
  {
    let space = challenge.protectionSpace
    let target = URL(string: "\(space.protocol ?? "https")://\(space.host):\(space.port)")
    guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let target, BackgroundUploadPolicy.origin(target) == ledger?.authorizedOrigin
    else { completionHandler(.cancelAuthenticationChallenge, nil); return }
    completionHandler(.performDefaultHandling, nil)
  }
}

enum BackgroundCiphertext {
  static func prepare(source: URL, pendingDirectory: URL, destination: URL,
    bytes: Int, sha256: String, header: String) throws
  {
    guard source.isFileURL, source.pathExtension == "bin",
      source.resolvingSymlinksInPath().deletingLastPathComponent()
        == pendingDirectory.resolvingSymlinksInPath(), bytes > 24,
      let expectedHeader = try? Data(b64: header), expectedHeader.count == 24
    else { throw BackgroundUploadFailure(message: "Only staged encrypted photo files can be uploaded") }
    do {
      try FileManager.default.copyItem(at: source, to: destination)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
      let handle = try FileHandle(forReadingFrom: destination)
      defer { try? handle.close() }
      var hash = SHA256()
      var count = 0
      var first = Data()
      while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
        if first.isEmpty { first = chunk.prefix(24) }
        count += chunk.count
        guard count <= bytes else { throw BackgroundUploadFailure(message: "Staged ciphertext changed") }
        hash.update(data: chunk)
      }
      guard count == bytes, first == expectedHeader, Data(hash.finalize()).b64 == sha256 else {
        throw BackgroundUploadFailure(message: "Staged ciphertext changed")
      }
    } catch {
      try? FileManager.default.removeItem(at: destination)
      throw error
    }
  }
}
