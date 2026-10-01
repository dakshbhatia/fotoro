import Foundation

struct BackgroundUploadFailure: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

struct BackgroundUploadIdentity: Codable, Equatable, Hashable, Sendable {
  var accountId: String
  var photoId: String
  var representationId: String
  var uploadId: String
  var attemptId = UUID().uuidString.lowercased()

  var valid: Bool {
    [accountId, photoId, representationId, uploadId, attemptId].allSatisfy {
      UUID(uuidString: $0) != nil
    }
  }
  var taskDescription: String {
    String(data: try! JSONEncoder().encode(self), encoding: .utf8)!
  }
  static func decode(_ description: String?) throws -> Self {
    guard let description, let bytes = description.data(using: .utf8), bytes.count < 2048,
      let identity = try? JSONDecoder().decode(Self.self, from: bytes), identity.valid
    else { throw BackgroundUploadFailure(message: "Background upload identity is invalid") }
    return identity
  }
}

enum BackgroundUploadPolicy {
  static let maximumTasks = 2
  static func validCapability(_ cap: String?) -> Bool {
    guard let cap, cap.utf8.count == 43 else { return false }
    return cap.utf8.allSatisfy {
      (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0)
        || $0 == 45 || $0 == 95
    }
  }

  static func origin(_ url: URL) -> String? {
    guard let c = URLComponents(url: url, resolvingAgainstBaseURL: true),
      let scheme = c.scheme?.lowercased(), let host = c.host?.lowercased(), !host.isEmpty,
      c.user == nil, c.password == nil,
      scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1"].contains(host))
    else { return nil }
    let port = c.port ?? (scheme == "https" ? 443 : 80)
    return "\(scheme)://\(host):\(port)"
  }

  static func permits(accountId: String?, fixture: Bool) -> Bool {
    guard !fixture, let accountId, UUID(uuidString: accountId) != nil else { return false }
    return !["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]
      .contains(accountId.lowercased())
  }

  static func request(stagingURL: String, baseURL: URL, uploadId: String, bytes: Int) throws
    -> URLRequest
  {
    guard UUID(uuidString: uploadId) != nil, bytes > 24, bytes <= 51 * 1024 * 1024,
      let expectedOrigin = origin(baseURL),
      let url = URL(string: stagingURL, relativeTo: baseURL)?.absoluteURL,
      origin(url) == expectedOrigin,
      var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      components.fragment == nil,
      components.percentEncodedPath == "/v1/uploads/\(uploadId)/staging",
      let query = components.queryItems, query.count == 1, query[0].name == "cap",
      validCapability(query[0].value)
    else { throw BackgroundUploadFailure(message: "Untrusted background upload URL") }
    components.path = "/v1/background/uploads/\(uploadId)/staging"
    guard let backgroundURL = components.url else {
      throw BackgroundUploadFailure(message: "Invalid background upload URL")
    }
    var request = URLRequest(url: backgroundURL)
    request.httpMethod = "PUT"
    request.httpShouldHandleCookies = false
    request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    request.setValue(String(bytes), forHTTPHeaderField: "Content-Length")
    // Only the scoped staging capability is supplied. No account credential is given to the daemon.
    return request
  }

  static func validTaskRequest(_ request: URLRequest?, identity: BackgroundUploadIdentity,
    authorizedOrigin: String?) -> Bool
  {
    guard let request, let url = request.url,
      origin(url) == authorizedOrigin,
      let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
      c.percentEncodedPath == "/v1/background/uploads/\(identity.uploadId)/staging",
      c.fragment == nil, let query = c.queryItems, query.count == 1,
      query[0].name == "cap", validCapability(query[0].value),
      request.httpMethod == "PUT", request.value(forHTTPHeaderField: "Authorization") == nil,
      request.value(forHTTPHeaderField: "Cookie") == nil
    else { return false }
    return true
  }
}

struct BackgroundUploadRecord: Codable, Sendable {
  enum State: String, Codable, Sendable { case transferring, uploaded, failed, cancelled }
  var identity: BackgroundUploadIdentity
  var origin: String
  var ciphertextBytes: Int
  var ciphertextSha256: String
  var state: State = .transferring
  var statusCode: Int?
  var message: String?
}

// This separate ledger contains identities and receipts, never manifests, keys, or plaintext.
// It stays available after first unlock so delegate delivery does not need the locked catalog.
final class BackgroundUploadLedger: @unchecked Sendable {
  private struct State: Codable {
    var accountId: String?
    var origin: String?
    var records: [String: BackgroundUploadRecord] = [:]
  }
  let root: URL
  private let lock = NSRecursiveLock()
  private var state: State
  private var file: URL { root.appendingPathComponent("receipts.json") }

  init(root: URL) throws {
    self.root = root
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: root.path)
    let file = root.appendingPathComponent("receipts.json")
    state = FileManager.default.fileExists(atPath: file.path)
      ? try JSONDecoder().decode(State.self, from: Data(contentsOf: file)) : State()
  }

  private func read<T>(_ body: (State) throws -> T) rethrows -> T {
    lock.lock()
    defer { lock.unlock() }
    return try body(state)
  }
  private func update<T>(_ body: (inout State) throws -> T) throws -> T {
    lock.lock()
    defer { lock.unlock() }
    var next = state
    let result = try body(&next)
    try JSONEncoder().encode(next).write(
      to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    state = next
    return result
  }

  var authorizedOrigin: String? { read { $0.origin } }
  func authorize(accountId: String?, fixture: Bool, baseURL: URL) throws {
    let account = BackgroundUploadPolicy.permits(accountId: accountId, fixture: fixture) ? accountId : nil
    let origin = BackgroundUploadPolicy.origin(baseURL)
    try update { state in
      for key in state.records.keys {
        guard let record = state.records[key] else { continue }
        if record.origin != origin || (record.state == .transferring && record.identity.accountId != account) {
          state.records[key]?.state = .cancelled
          state.records[key]?.message = "Account or server changed; resume after signing in"
        }
      }
      state.accountId = origin == nil ? nil : account
      state.origin = origin
    }
  }
  func accepts(_ identity: BackgroundUploadIdentity) -> Bool {
    read { identity.valid && $0.accountId == identity.accountId && $0.origin != nil }
  }
  func register(_ identity: BackgroundUploadIdentity, ciphertextBytes: Int,
    ciphertextSha256: String) throws
  {
    try update { state in
      guard identity.valid, identity.accountId == state.accountId, let origin = state.origin else {
        throw BackgroundUploadFailure(message: "Sign in to the source account to resume uploads")
      }
      guard !state.records.values.contains(where: {
        $0.state == .transferring && $0.identity.accountId == identity.accountId
          && $0.identity.representationId == identity.representationId
      }) else {
        throw BackgroundUploadFailure(message: "This encrypted representation is already scheduled")
      }
      guard state.records.values.filter({ $0.state == .transferring }).count < BackgroundUploadPolicy.maximumTasks else {
        throw BackgroundUploadFailure(message: "Two encrypted uploads are already scheduled; resume when they finish")
      }
      // Superseded attempts are removed; late callbacks still cannot match the new attempt identity.
      state.records = state.records.filter {
        $0.value.identity.accountId != identity.accountId
          || $0.value.identity.representationId != identity.representationId
          || $0.value.state == .transferring
      }
      state.records[identity.attemptId] = BackgroundUploadRecord(
        identity: identity, origin: origin, ciphertextBytes: ciphertextBytes, ciphertextSha256: ciphertextSha256)
    }
  }
  func records(accountId: String) throws -> [BackgroundUploadRecord] {
    read { $0.records.values.filter { $0.identity.accountId == accountId } }
  }
  func record(_ identity: BackgroundUploadIdentity) throws -> BackgroundUploadRecord? {
    read { state in
      guard let record = state.records[identity.attemptId], record.identity == identity else { return nil }
      return record
    }
  }
  func needsUpload(_ identity: BackgroundUploadIdentity) throws -> Bool {
    try record(identity)?.state != .uploaded
  }
  @discardableResult func complete(_ identity: BackgroundUploadIdentity, statusCode: Int?,
    responseURL: URL?, errorCode: Int?) throws -> Bool
  {
    try update { state in
      guard var record = state.records[identity.attemptId], record.identity == identity,
        record.state != .cancelled, state.accountId == identity.accountId, record.origin == state.origin
      else { return false }
      if record.state == .uploaded { return true }
      record.statusCode = statusCode
      if errorCode == nil, let statusCode, (200..<300).contains(statusCode),
        let responseURL, BackgroundUploadPolicy.origin(responseURL) == state.origin
      {
        record.state = .uploaded
        record.message = nil
      } else {
        record.state = .failed
        record.message = errorCode == NSURLErrorCancelled
          ? "Upload was interrupted; open Fotoro and resume"
          : statusCode == 403 || statusCode == 401
            ? "Upload permission expired; unlock Fotoro and resume"
            : "Encrypted upload needs a foreground retry (\(statusCode ?? errorCode ?? 0))"
      }
      state.records[identity.attemptId] = record
      return true
    }
  }
  func cancel(accountId: String, photoId: String? = nil) throws {
    try update { state in
      for key in state.records.keys {
        guard let record = state.records[key], record.identity.accountId == accountId,
          photoId == nil || record.identity.photoId == photoId else { continue }
        state.records[key]?.state = .cancelled
        state.records[key]?.message = "Upload paused; unlock Fotoro and resume"
      }
    }
  }
  func reconcile(live: Set<BackgroundUploadIdentity>) throws {
    try update { state in
      for key in state.records.keys {
        guard let record = state.records[key], record.state == .transferring,
          !live.contains(record.identity) else { continue }
        state.records[key]?.state = .failed
        state.records[key]?.message = "Upload was interrupted; unlock Fotoro and resume"
      }
    }
  }
  func forget(accountId: String, photoId: String) throws {
    try update { state in
      state.records = state.records.filter {
        $0.value.identity.accountId != accountId || $0.value.identity.photoId != photoId
      }
    }
  }
}
