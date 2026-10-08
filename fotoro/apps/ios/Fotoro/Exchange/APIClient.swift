import Foundation
import OSLog
import AuthenticationServices

enum NativeDiagnosticPhase: String, Codable, Sendable { case app, api, auth, sync, share, consent, picks, albums, search, metadata, people }
enum NativeDiagnosticOutcome: String, Codable, Sendable { case started, completed, failed, cancelled, changed }
enum NativeDiagnosticOperation: String, Codable, Sendable { case app, api, auth, sync, share, albums, search, metadata, people, consent, picks }
enum NativeDiagnosticStep: String, Codable, Sendable { case action, request, response, decode, credential, unlock, catalog, verify, persist, transfer, annotation, scan, analysis, export }
enum NativeDiagnosticReason: String, Codable, Sendable {
  case cancelled, contextChanged, network, http, decode, validation, unknown
  case signedOut, locked, permissionRequired, paused, offline, retryRequired, waiting, pendingTransfers, pendingAnnotations, sourceUnavailable, current
  static func failure(_ error: Error) -> Self {
    if error is CancellationError || (error as? URLError)?.code == .cancelled { return .cancelled }
    if error is DecodingError { return .decode }
    if error is URLError { return .network }
    return .unknown
  }
}
final class NativeDiagnosticTrace: @unchecked Sendable {
  @TaskLocal static var current: NativeDiagnosticTrace?
  let id = UUID()
  let operation: NativeDiagnosticOperation
  private let lock = NSLock()
  private var completedStep: NativeDiagnosticStep?
  init(_ operation: NativeDiagnosticOperation) { self.operation = operation }
  var lastCompletedStep: NativeDiagnosticStep? { lock.lock(); defer { lock.unlock() }; return completedStep }
  func completed(_ step: NativeDiagnosticStep) { lock.lock(); completedStep = step; lock.unlock() }
  @MainActor static func action<T>(_ operation: NativeDiagnosticOperation, diagnostics: NativeDiagnostics,
    _ body: @MainActor () async throws -> T) async throws -> T {
    // Nested work belongs to its initiating action; only that action owns the terminal event.
    if let current, current.operation != .app { return try await body() }
    let trace = NativeDiagnosticTrace(operation)
    return try await $current.withValue(trace) {
      let start = ProcessInfo.processInfo.systemUptime
      let phase = NativeDiagnosticPhase(rawValue: operation.rawValue) ?? .app
      diagnostics.record(NativeDiagnosticEvent(phase: phase, outcome: .started, step: .action))
      do {
        try Task.checkCancellation()
        let result = try await body()
        try Task.checkCancellation()
        diagnostics.record(NativeDiagnosticEvent(phase: phase, outcome: .completed,
          elapsed: ProcessInfo.processInfo.systemUptime - start, step: .action))
        return result
      } catch {
        diagnostics.record(NativeDiagnosticEvent(phase: phase,
          outcome: .failure(for: error, taskCancelled: Task.isCancelled),
          elapsed: ProcessInfo.processInfo.systemUptime - start,
          authorizationCode: (error as? NativePasskeyError)?.code,
          step: .action, reason: Task.isCancelled || (error as? NativePasskeyError)?.isCancelled == true ? .cancelled : .failure(error)))
        throw error
      }
    }
  }
}
enum NativeDiagnosticAccountState: String, Codable, Sendable {
  case signedOut, locked, recoveryRequired, unlocked, demo
}
enum NativeDiagnosticEndpoint: String, Codable, Sendable {
  case auth, account, catalog, upload, annotations, exchange, albums, device, other
  init(path: String) {
    let parts = path.split(separator: "/")
    guard parts.first == "v1", parts.count > 1 else { self = .other; return }
    switch parts[1] {
    case "auth", "recovery", "sessions": self = .auth
    case "accounts", "vault": self = .account
    case "changes", "photos", "representations", "objects": self = .catalog
    case "albums", "album-photo-facts": self = .albums
    case "uploads", "staging": self = .upload
    case "background": self = parts.count > 2 && parts[2] == "uploads" ? .upload : .other
    case "annotations": self = .annotations
    case "grants", "moments", "saves": self = .exchange
    case "devices": self = .device
    default: self = .other
    }
  }
}
enum NativeDiagnosticMethod: String, Codable, Sendable {
  case GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD, OTHER
  init(_ method: String) { self = Self(rawValue: method) ?? .OTHER }
}
struct NativeDiagnosticEvent: Codable, Sendable {
  private(set) var timestamp: Double
  let phase: NativeDiagnosticPhase
  let outcome: NativeDiagnosticOutcome
  let endpoint: NativeDiagnosticEndpoint?
  let method: NativeDiagnosticMethod?
  let elapsedMS: Int?
  let status: Int?
  let networkCode: Int?
  let authorizationCode: Int?
  let requestId: UUID?
  let state: ConsumerSyncState?
  let accountState: NativeDiagnosticAccountState?
  let completed: Int?
  let pending: Int?
  let attempted: Int?
  let traceId: UUID?
  let operation: NativeDiagnosticOperation?
  let step: NativeDiagnosticStep?
  let lastCompletedStep: NativeDiagnosticStep?
  let reason: NativeDiagnosticReason?
  private(set) var build: String
  init(phase: NativeDiagnosticPhase, outcome: NativeDiagnosticOutcome,
    endpoint: NativeDiagnosticEndpoint? = nil, method: String? = nil,
    elapsed: Double? = nil, status: Int? = nil, networkError: URLError? = nil,
    authorizationCode: ASAuthorizationError.Code? = nil, requestId: String? = nil,
    state: ConsumerSyncState? = nil, accountState: NativeDiagnosticAccountState? = nil,
    completed: Int? = nil, pending: Int? = nil, attempted: Int? = nil,
    trace: NativeDiagnosticTrace? = NativeDiagnosticTrace.current,
    step: NativeDiagnosticStep? = nil, reason: NativeDiagnosticReason? = nil) {
    timestamp = Date().timeIntervalSince1970
    self.phase = phase; self.outcome = outcome; self.endpoint = endpoint
    self.method = method.map(NativeDiagnosticMethod.init)
    elapsedMS = elapsed.map { Int(max(0, min($0.isFinite ? $0 * 1000 : 0, 3_600_000))) }
    self.status = status.flatMap { (100...599).contains($0) ? $0 : nil }
    networkCode = networkError?.code.rawValue
    self.authorizationCode = authorizationCode?.rawValue
    self.requestId = requestId.flatMap(UUID.init(uuidString:))
    self.state = state
    self.accountState = accountState
    self.completed = completed.map { max(0, min($0, 1_000_000)) }
    self.pending = pending.map { max(0, min($0, 1_000_000)) }
    self.attempted = attempted.map { max(0, min($0, 1_000_000)) }
    traceId = trace?.id; operation = trace?.operation; self.step = step
    lastCompletedStep = trace?.lastCompletedStep; self.reason = reason
    let value = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
    build = String(value.prefix(16).filter { $0.isNumber || $0 == "." })
  }
  func exportSafe() -> Self {
    var result = self
    result.build = String(build.prefix(16).filter { $0.isASCII && ($0.isNumber || $0 == ".") })
    if !result.timestamp.isFinite || result.timestamp < 0 { result.timestamp = 0 }
    return result
  }
}
final class NativeDiagnostics: @unchecked Sendable {
  static let shared = NativeDiagnostics()
  static let maximumBytes = 64 * 1024
  private let queue = DispatchQueue(label: "cloud.fotoro.runtime-diagnostics", qos: .utility)
  private let logger = Logger(subsystem: "cloud.fotoro.Fotoro", category: "runtime")
  private let fileURL: URL?
  private let emitSystemLog: Bool
  private var events: [NativeDiagnosticEvent] = []
  private var pendingFlush = false
  init(fileURL: URL? = NativeDiagnostics.defaultFileURL, emitSystemLog: Bool = true) {
    self.fileURL = fileURL; self.emitSystemLog = emitSystemLog
    if let fileURL, let size = try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize,
      size <= Self.maximumBytes, let data = try? Data(contentsOf: fileURL) {
      events = data.split(separator: 10).suffix(160).compactMap {
        try? JSONDecoder().decode(NativeDiagnosticEvent.self, from: Data($0))
      }
    }
  }
  private static var defaultFileURL: URL? {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
      .appendingPathComponent("FotoroDiagnostics/runtime.jsonl")
  }
  func record(_ event: NativeDiagnosticEvent) {
    queue.async {
      self.events.append(event)
      if self.events.count > 160 { self.events.removeFirst(self.events.count - 160) }
      if self.emitSystemLog, let data = try? JSONEncoder().encode(event),
        let line = String(data: data, encoding: .utf8) {
        if event.outcome == .failed { self.logger.error("\(line, privacy: .public)") }
        else { self.logger.info("\(line, privacy: .public)") }
      }
      guard !self.pendingFlush else { return }
      self.pendingFlush = true
      self.queue.asyncAfter(deadline: .now() + 0.25) {
        self.pendingFlush = false
        self.persist()
      }
    }
  }
  func flush() { queue.sync { persist() } }
  func exportJSON() -> Data {
    queue.sync {
      var safe = events.suffix(160).map { $0.exportSafe() }
      let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
      while let data = try? encoder.encode(safe) {
        if data.count <= Self.maximumBytes { return data }
        guard !safe.isEmpty else { break }; safe.removeFirst()
      }
      return Data("[]".utf8)
    }
  }
  private func persist() {
    guard let fileURL else { return }
    do {
      var directory = fileURL.deletingLastPathComponent()
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
      var resources = URLResourceValues(); resources.isExcludedFromBackup = true
      try directory.setResourceValues(resources)
      let encoder = JSONEncoder()
      var lines = try events.map { try encoder.encode($0) + Data([10]) }
      var size = lines.reduce(0) { $0 + $1.count }
      while size > Self.maximumBytes, !lines.isEmpty { size -= lines.removeFirst().count }
      try lines.reduce(Data(), +).write(to: fileURL,
        options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    } catch {
      if emitSystemLog { logger.error("runtime diagnostics persistence failed") }
    }
  }
}

private final class APIRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void)
  {
    completionHandler(nil)
  }
}

private struct APIFailure: Decodable {
  let code: String?
  let requestId: String?
  let retryable: Bool
  private enum CodingKeys: String, CodingKey { case code, requestId, retryable }
  init(from decoder: Decoder) throws {
    let fields = try decoder.container(keyedBy: CodingKeys.self)
    code = try? fields.decode(String.self, forKey: .code)
    requestId = try? fields.decode(String.self, forKey: .requestId)
    // JSONDecoder's Bool decoding rejects JSON numbers rather than bridging 1.
    retryable = (try? fields.decode(Bool.self, forKey: .retryable)) ?? false
  }
}

enum APIURLPolicy {
  static let canonical = URL(string: "https://fotoro.cloud")!
  static var developmentBuild: Bool {
    #if DEBUG
      true
    #else
      false
    #endif
  }
  static func restored(_ saved: String?, development: Bool) -> URL {
    guard development, let saved, let url = configured(saved, development: true) else {
      return canonical
    }
    return url
  }
  static func configured(_ value: String, development: Bool) -> URL? {
    guard var components = URLComponents(string: value),
      let scheme = components.scheme?.lowercased(), let host = components.host?.lowercased(),
      !host.isEmpty, components.user == nil, components.password == nil,
      components.query == nil, components.fragment == nil,
      ["", "/"].contains(components.percentEncodedPath),
      components.port.map({ (1...65535).contains($0) }) ?? true,
      scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1"].contains(host))
    else { return nil }
    components.scheme = scheme; components.host = host; components.path = ""
    guard let url = components.url else { return nil }
    if development { return url }
    return BackgroundUploadPolicy.origin(url) == BackgroundUploadPolicy.origin(canonical) ? canonical : nil
  }
}

@MainActor final class APIClient {
  let session: AccountSession
  var baseURL: URL
  var origin: String {
    session.fixture || baseURL.host == "127.0.0.1" || baseURL.host == "localhost"
      ? "http://localhost:4310" : "https://fotoro.cloud"
  }
  var rpId: String { origin == "https://fotoro.cloud" ? "fotoro.cloud" : "localhost" }
  private let network: URLSession
  private let diagnostics: NativeDiagnostics
  init(session: AccountSession, baseURL: URL, networkConfiguration: URLSessionConfiguration = .ephemeral,
    diagnostics: NativeDiagnostics = .shared) {
    self.session = session
    self.baseURL = baseURL
    self.diagnostics = diagnostics
    network = URLSession(
      configuration: networkConfiguration, delegate: APIRedirectPolicy(), delegateQueue: nil)
  }
  func request(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
    guard let url = URL(string: path, relativeTo: baseURL) else {
      recordInvalidURL(method: method)
      throw FotoroError("Invalid API URL")
    }
    return try await perform(url, method: method, body: body, step: .response) { $0 }
  }
  private func recordInvalidURL(method: String) {
    let trace = NativeDiagnosticTrace.current ?? NativeDiagnosticTrace(.api)
    diagnostics.record(NativeDiagnosticEvent(phase: .api, outcome: .started, endpoint: .other, method: method, trace: trace, step: .request))
    diagnostics.record(NativeDiagnosticEvent(phase: .api, outcome: .failed, endpoint: .other, method: method, trace: trace, step: .request, reason: .validation))
  }
  private static func supportReference(_ value: String?) -> String? {
    guard let value, let uuid = UUID(uuidString: value),
      value.caseInsensitiveCompare(uuid.uuidString) == .orderedSame else { return nil }
    return uuid.uuidString.lowercased()
  }
  private func perform<T>(_ url: URL, method: String, body: Data?, step: NativeDiagnosticStep,
    transform: (Data) throws -> T) async throws -> T {
    let trace = NativeDiagnosticTrace.current ?? NativeDiagnosticTrace(.api)
    return try await NativeDiagnosticTrace.$current.withValue(trace) {
      try await performTraced(url, method: method, body: body, step: step, transform: transform)
    }
  }
  private func performTraced<T>(_ url: URL, method: String, body: Data?, step: NativeDiagnosticStep,
    transform: (Data) throws -> T) async throws -> T {
    let started = ProcessInfo.processInfo.systemUptime
    let endpoint = NativeDiagnosticEndpoint(path: url.path)
    diagnostics.record(NativeDiagnosticEvent(phase: .api, outcome: .started, endpoint: endpoint, method: method, step: .request))
    let data: Data
    let response: URLResponse
    do {
      guard let expected = BackgroundUploadPolicy.origin(baseURL),
        BackgroundUploadPolicy.origin(url) == expected,
        URLComponents(url: url, resolvingAgainstBaseURL: true)?.fragment == nil
      else { throw FotoroError("Untrusted API URL") }
      var r = URLRequest(url: url)
      r.httpMethod = method
      r.httpBody = body
      if endpoint == .auth { r.timeoutInterval = 20 }
      r.setValue("application/json", forHTTPHeaderField: "Content-Type")
      r.setValue(origin, forHTTPHeaderField: "Origin")
      r.setValue(NativeDiagnosticTrace.current?.id.uuidString.lowercased(), forHTTPHeaderField: "X-Fotoro-Trace-Id")
      if endpoint != .auth, let account = session.accountId {
        r.setValue(account, forHTTPHeaderField: "X-Fotoro-Account-Id")
      }
      if session.fixture {
        guard ["127.0.0.1", "localhost"].contains(baseURL.host ?? ""),
          ["127.0.0.1", "localhost"].contains(url.host ?? "")
        else { throw FotoroError("Fixture secrets cannot leave loopback") }
        r.setValue(session.accountId, forHTTPHeaderField: "x-fotoro-fixture-account")
      } else if url.scheme == baseURL.scheme, url.host == baseURL.host, url.port == baseURL.port,
        let token = session.bearerToken
      {
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      }
      (data, response) = try await network.data(for: r)
    }
    catch {
      diagnostics.record(NativeDiagnosticEvent(phase: .api,
        outcome: .failure(for: error, taskCancelled: Task.isCancelled),
        endpoint: endpoint, method: method, elapsed: ProcessInfo.processInfo.systemUptime - started,
        networkError: error as? URLError, step: .request, reason: Task.isCancelled ? .cancelled : .failure(error)))
      throw error
    }
    let responseRequestId = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "x-request-id")
    let requestId = Self.supportReference(responseRequestId)
    if Task.isCancelled {
      diagnostics.record(NativeDiagnosticEvent(phase: .api, outcome: .cancelled,
        endpoint: endpoint, method: method, elapsed: ProcessInfo.processInfo.systemUptime - started,
        status: (response as? HTTPURLResponse)?.statusCode, requestId: requestId,
        step: .response, reason: .cancelled))
      throw CancellationError()
    }
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let failure = try? JSONDecoder().decode(APIFailure.self, from: data)
      let failureRequestId = requestId ?? Self.supportReference(failure?.requestId)
      diagnostics.record(NativeDiagnosticEvent(phase: .api, outcome: .failed,
        endpoint: endpoint, method: method, elapsed: ProcessInfo.processInfo.systemUptime - started,
        status: (response as? HTTPURLResponse)?.statusCode,
        requestId: failureRequestId,
        step: .response, reason: .http))
      throw FotoroError(
        failure?.code ?? "Network request failed (\((response as? HTTPURLResponse)?.statusCode ?? 0))",
        requestId: failureRequestId,
        retryable: failure?.retryable ?? false,
        statusCode: (response as? HTTPURLResponse)?.statusCode)
    }
    NativeDiagnosticTrace.current?.completed(.response)
    let value: T
    do {
      try Task.checkCancellation()
      value = try transform(data)
      try Task.checkCancellation()
    } catch {
      diagnostics.record(NativeDiagnosticEvent(phase: .api,
        outcome: error is CancellationError || Task.isCancelled ? .cancelled : .failed,
        endpoint: endpoint, method: method, elapsed: ProcessInfo.processInfo.systemUptime - started,
        status: http.statusCode, requestId: http.value(forHTTPHeaderField: "x-request-id"),
        step: step, reason: error is CancellationError || Task.isCancelled ? .cancelled : .decode))
      throw error
    }
    NativeDiagnosticTrace.current?.completed(step)
    diagnostics.record(NativeDiagnosticEvent(phase: .api, outcome: .completed,
      endpoint: endpoint, method: method, elapsed: ProcessInfo.processInfo.systemUptime - started,
      status: (response as? HTTPURLResponse)?.statusCode,
      requestId: (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "x-request-id"), step: step))
    return value
  }
  private func decoded<T: Decodable>(_ path: String, method: String = "GET", body: Data? = nil) async throws -> T {
    guard let url = URL(string: path, relativeTo: baseURL) else {
      recordInvalidURL(method: method); throw FotoroError("Invalid API URL")
    }
    return try await perform(url, method: method, body: body, step: .decode) { try Wire.decode(T.self, $0) }
  }
  func get<T: Decodable>(_ path: String) async throws -> T {
    try await decoded(path)
  }
  func post<T: Decodable, U: Encodable>(_ path: String, _ body: U) async throws -> T {
    try await decoded(path, method: "POST", body: Wire.encode(body))
  }
  func commit(_ id: String) async throws -> UploadCommitV1 {
    try await decoded("/v1/uploads/\(id)/commit", method: "POST")
  }
  func upload(_ bytes: Data, to location: String) async throws {
    guard let url = URL(string: location, relativeTo: baseURL) else {
      recordInvalidURL(method: "PUT")
      throw FotoroError("Invalid upload URL")
    }
    _ = try await perform(url, method: "PUT", body: bytes, step: .response) { $0 }
  }
  func save(_ input: SavedPhotoV1, expectedGrantVersion: Int) async throws -> SavedPhotoV1 {
    try await post(
      "/v1/saves", SaveRequestV1(expectedGrantVersion: expectedGrantVersion, save: input))
  }
  func save(_ input: SavedPhotoV1) async throws -> SavedPhotoV1 {
    let detail: GrantDetailV1 = try await get("/v1/grants/\(input.sourceGrantId)")
    return try await save(input, expectedGrantVersion: detail.grant.version)
  }
}
