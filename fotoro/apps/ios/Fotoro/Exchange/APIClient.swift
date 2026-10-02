import Foundation
import OSLog
import AuthenticationServices

enum NativeDiagnosticPhase: String, Codable, Sendable { case app, api, auth, sync, share, consent, picks }
enum NativeDiagnosticOutcome: String, Codable, Sendable { case started, completed, failed, cancelled, changed }
enum NativeDiagnosticEndpoint: String, Codable, Sendable {
  case auth, account, catalog, upload, annotations, exchange, device, other
  init(path: String) {
    let parts = path.split(separator: "/")
    guard parts.first == "v1", parts.count > 1 else { self = .other; return }
    switch parts[1] {
    case "auth", "recovery", "sessions": self = .auth
    case "accounts", "vault": self = .account
    case "changes", "photos", "representations": self = .catalog
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
  let timestamp: Double
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
  let completed: Int?
  let pending: Int?
  let build: String
  init(phase: NativeDiagnosticPhase, outcome: NativeDiagnosticOutcome,
    endpoint: NativeDiagnosticEndpoint? = nil, method: String? = nil,
    elapsed: Double? = nil, status: Int? = nil, networkError: URLError? = nil,
    authorizationCode: ASAuthorizationError.Code? = nil, requestId: String? = nil,
    state: ConsumerSyncState? = nil, completed: Int? = nil, pending: Int? = nil) {
    timestamp = Date().timeIntervalSince1970
    self.phase = phase; self.outcome = outcome; self.endpoint = endpoint
    self.method = method.map(NativeDiagnosticMethod.init)
    elapsedMS = elapsed.map { Int(max(0, min($0.isFinite ? $0 * 1000 : 0, 3_600_000))) }
    self.status = status.flatMap { (100...599).contains($0) ? $0 : nil }
    networkCode = networkError?.code.rawValue
    self.authorizationCode = authorizationCode?.rawValue
    self.requestId = requestId.flatMap(UUID.init(uuidString:))
    self.state = state
    self.completed = completed.map { max(0, min($0, 1_000_000)) }
    self.pending = pending.map { max(0, min($0, 1_000_000)) }
    let value = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
    build = String(value.prefix(16).filter { $0.isNumber || $0 == "." })
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
    return try await perform(url, method: method, body: body)
  }
  private func recordInvalidURL(method: String) {
    diagnostics.record(NativeDiagnosticEvent(phase: .api, outcome: .started, endpoint: .other, method: method))
    diagnostics.record(NativeDiagnosticEvent(phase: .api, outcome: .failed, endpoint: .other, method: method))
  }
  private func perform(_ url: URL, method: String, body: Data?) async throws -> Data {
    let started = ProcessInfo.processInfo.systemUptime
    let endpoint = NativeDiagnosticEndpoint(path: url.path)
    diagnostics.record(NativeDiagnosticEvent(phase: .api, outcome: .started, endpoint: endpoint, method: method))
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
        outcome: error is CancellationError || (error as? URLError)?.code == .cancelled ? .cancelled : .failed,
        endpoint: endpoint, method: method, elapsed: ProcessInfo.processInfo.systemUptime - started,
        networkError: error as? URLError))
      throw error
    }
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let failure = try? JSONDecoder().decode(APIFailure.self, from: data)
      diagnostics.record(NativeDiagnosticEvent(phase: .api, outcome: .failed,
        endpoint: endpoint, method: method, elapsed: ProcessInfo.processInfo.systemUptime - started,
        status: (response as? HTTPURLResponse)?.statusCode, requestId: failure?.requestId))
      throw FotoroError(
        failure?.code ?? "Network request failed (\((response as? HTTPURLResponse)?.statusCode ?? 0))",
        requestId: failure?.requestId, retryable: failure?.retryable ?? false)
    }
    diagnostics.record(NativeDiagnosticEvent(phase: .api, outcome: .completed,
      endpoint: endpoint, method: method, elapsed: ProcessInfo.processInfo.systemUptime - started,
      status: (response as? HTTPURLResponse)?.statusCode,
      requestId: (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "x-request-id")))
    return data
  }
  func get<T: Decodable>(_ path: String) async throws -> T {
    try Wire.decode(T.self, await request(path))
  }
  func post<T: Decodable, U: Encodable>(_ path: String, _ body: U) async throws -> T {
    try Wire.decode(T.self, await request(path, method: "POST", body: Wire.encode(body)))
  }
  func commit(_ id: String) async throws -> UploadCommitV1 {
    try Wire.decode(UploadCommitV1.self, await request("/v1/uploads/\(id)/commit", method: "POST"))
  }
  func upload(_ bytes: Data, to location: String) async throws {
    guard let url = URL(string: location, relativeTo: baseURL) else {
      recordInvalidURL(method: "PUT")
      throw FotoroError("Invalid upload URL")
    }
    _ = try await perform(url, method: "PUT", body: bytes)
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
