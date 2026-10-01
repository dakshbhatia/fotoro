import Foundation

@MainActor final class APIClient {
  let session: AccountSession
  var baseURL: URL
  var origin: String {
    session.fixture || baseURL.host == "127.0.0.1" || baseURL.host == "localhost"
      ? "http://localhost:4310" : "https://fotoro.cloud"
  }
  var rpId: String { origin == "https://fotoro.cloud" ? "fotoro.cloud" : "localhost" }
  init(session: AccountSession, baseURL: URL) {
    self.session = session
    self.baseURL = baseURL
  }
  func request(_ path: String, method: String = "GET", body: Data? = nil) async throws -> Data {
    guard let url = URL(string: path, relativeTo: baseURL) else {
      throw FotoroError("Invalid API URL")
    }
    return try await perform(url, method: method, body: body)
  }
  private func perform(_ url: URL, method: String, body: Data?) async throws -> Data {
    var r = URLRequest(url: url)
    r.httpMethod = method
    r.httpBody = body
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
    let (data, response) = try await URLSession.shared.data(for: r)
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let code =
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["code"] as? String
      throw FotoroError(
        code ?? "Network request failed (\((response as? HTTPURLResponse)?.statusCode ?? 0))")
    }
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
