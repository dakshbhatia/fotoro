import Photos
import XCTest

@testable import Fotoro

final class RecentPhotosTests: XCTestCase {
  func testOwnedShareCleanupRemovesOnlyTemporaryExports() throws {
    let temporary = FileManager.default.temporaryDirectory
    let export = temporary.appendingPathComponent("fotoro-share-" + Wire.id())
    let account = temporary.appendingPathComponent(Wire.id())
    let cache = account.appendingPathComponent("Media")
    let nested = account.appendingPathComponent("fotoro-share-" + Wire.id())
    defer {
      try? FileManager.default.removeItem(at: export)
      try? FileManager.default.removeItem(at: account)
    }
    let bytes = Data([1, 2, 3])
    for directory in [export, cache, nested] {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try bytes.write(to: directory.appendingPathComponent("original.jpg"))
    }
    ConsumerShareExports.remove([export, cache, nested].map { $0.appendingPathComponent("original.jpg") })
    XCTAssertFalse(FileManager.default.fileExists(atPath: export.path))
    XCTAssertEqual(try Data(contentsOf: cache.appendingPathComponent("original.jpg")), bytes)
    XCTAssertEqual(try Data(contentsOf: nested.appendingPathComponent("original.jpg")), bytes)
    ConsumerShareExports.remove([export.appendingPathComponent("original.jpg")])
  }
  func testSavedSearchRemainsVisibleWithoutPhotosPermission() {
    for permission in [PHAuthorizationStatus.notDetermined, .denied, .restricted, .limited, .authorized] {
      for opened in [false, true] {
        XCTAssertEqual(RecentPhotosContentMode.select(query: "cloud-only receipt", opened: opened, status: permission), .search)
      }
    }
    XCTAssertEqual(RecentPhotosContentMode.select(query: "", opened: false, status: .notDetermined), .openPhotos)
    XCTAssertEqual(RecentPhotosContentMode.select(query: "", opened: true, status: .denied), .accessOff)
    XCTAssertEqual(RecentPhotosContentMode.select(query: "", opened: true, status: .limited), .gallery)
  }
  @MainActor func testAccountCompletionRefreshesCatalogBeforeReturningWithoutStartingPhotosBackup() async throws {
    let savedCards = UserDefaults.standard.data(forKey: "fotoro.pinnedCards")
    var card = try fixture(FixtureAccounts.self, "accounts").accounts[0]
    card.accountId = Wire.id()
    defer {
      Keychain.remove(card.accountId)
      if let savedCards { UserDefaults.standard.set(savedCards, forKey: "fotoro.pinnedCards") }
      else { UserDefaults.standard.removeObject(forKey: "fotoro.pinnedCards") }
    }
    AccountCompletionProtocol.record.reset()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AccountCompletionProtocol.self]
    let services = try AppServices(root: FileManager.default.temporaryDirectory.appendingPathComponent(Wire.id()), networkConfiguration: configuration)
    services.api.baseURL = URL(string: "http://127.0.0.1:8788")!
    services.session.accountId = card.accountId
    services.session.fixture = false
    services.session.bearerToken = "controlled-ui-session"
    try services.session.pin(card)
    let secret = try fixture(FixtureAccounts.self, "accounts").testSecrets[0]
    try await services.vault.unlock(.recoveryEnvelope(secret: Data(b64: secret.recoverySecret), wrapper: secret.encryptedBundle))
    var returnedAfterCatalog = false
    let accountView = AccountView(services: services, onSignedIn: {
      returnedAfterCatalog = (try? services.store.cursor()) == "Y2F0YWxvZy1yZWFkeQ"
    })
    try await accountView.finishSignIn()
    XCTAssertTrue(returnedAfterCatalog)
    XCTAssertEqual(services.store.root.lastPathComponent, card.accountId)
    XCTAssertFalse(try services.store.syncEnabled())
    XCTAssertFalse(services.backup.isRunning)
    XCTAssertTrue(try services.journal.entries().isEmpty)
    XCTAssertEqual(AccountCompletionProtocol.record.paths, ["/v1/changes", "/v1/grants"])
    services.vault.lock()
  }
  func testLast10DaysDateBoundariesAndMissingDates() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    let now = Date(timeIntervalSince1970: 1_780_315_200)
    let cutoff = RecentPhotosPolicy.cutoff(now: now, calendar: calendar)
    XCTAssertEqual(cutoff, now.addingTimeInterval(-10 * 24 * 60 * 60))
    XCTAssertTrue(RecentPhotosPolicy.includes(cutoff, now: now, calendar: calendar))
    XCTAssertTrue(RecentPhotosPolicy.includes(now, now: now, calendar: calendar))
    XCTAssertFalse(
      RecentPhotosPolicy.includes(cutoff.addingTimeInterval(-1), now: now, calendar: calendar))
    XCTAssertFalse(
      RecentPhotosPolicy.includes(now.addingTimeInterval(1), now: now, calendar: calendar))
    XCTAssertFalse(RecentPhotosPolicy.includes(nil, now: now, calendar: calendar))
  }
  @MainActor func testRelaunchRestoresGrantedPhotosWithoutRequestingAccess() async {
    for permission in [PHAuthorizationStatus.authorized, .limited] {
      var requests = 0
      var reads = 0
      let store = RecentPhotosStore(authorization: { permission }, requestAccess: {
        requests += 1
        return permission
      }, readPhotos: { _ in reads += 1; return [] })
      store.restoreAccess()
      XCTAssertTrue(store.opened)
      XCTAssertEqual(store.status, permission)
      XCTAssertEqual(reads, 1)
      XCTAssertEqual(requests, 0)
    }
  }
  @MainActor func testFirstUseWaitsForOpenPhotosAndDeniedRestoreNeverReadsAssets() async {
    for permission in [PHAuthorizationStatus.notDetermined, .denied, .restricted] {
      var requests = 0
      var reads = 0
      let store = RecentPhotosStore(authorization: { permission }, requestAccess: {
        requests += 1
        return permission
      }, readPhotos: { _ in reads += 1; return [] })
      store.restoreAccess()
      XCTAssertEqual(store.opened, permission != .notDetermined)
      XCTAssertEqual(reads, 0)
      XCTAssertEqual(requests, 0)
      if permission == .notDetermined {
        await store.open()
        XCTAssertEqual(requests, 1)
      }
    }
  }
  func testViewerLoadsOnlyCurrentAndNeighboringPages() {
    XCTAssertTrue(RecentPhotosPolicy.shouldLoadPage(4, current: 5))
    XCTAssertTrue(RecentPhotosPolicy.shouldLoadPage(5, current: 5))
    XCTAssertTrue(RecentPhotosPolicy.shouldLoadPage(6, current: 5))
    XCTAssertFalse(RecentPhotosPolicy.shouldLoadPage(3, current: 5))
    XCTAssertFalse(RecentPhotosPolicy.shouldLoadPage(7, current: 5))
  }
  func testPermissionPolicyAllowsLimitedAndFullOnly() {
    XCTAssertTrue(RecentPhotosPolicy.canRead(.limited))
    XCTAssertTrue(RecentPhotosPolicy.canRead(.authorized))
    for status in [PHAuthorizationStatus.notDetermined, .denied, .restricted] {
      XCTAssertFalse(RecentPhotosPolicy.canRead(status))
    }
  }
  func testMetadataSearchUsesPhotoKitFactsWithoutInferredPeopleOrPlaces() {
    let facts = RecentPhotoFacts(
      capturedAt: Date(timeIntervalSince1970: 1_780_315_200), favorite: true, screenshot: true,
      livePhoto: false, location: "40.7128, -74.0060")
    XCTAssertTrue(facts.searchText.contains("favorite"))
    XCTAssertTrue(facts.searchText.contains("screenshot"))
    XCTAssertTrue(facts.searchText.contains("40.7128"))
    XCTAssertFalse(facts.searchText.contains("live photo"))
    XCTAssertFalse(facts.searchText.contains("New York"))
    XCTAssertEqual(
      RecentPhotoFacts(
        capturedAt: nil, favorite: false, screenshot: false, livePhoto: false, location: nil
      ).searchText, "")
  }
}

private final class AccountCompletionRequests: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String] = []
  var paths: [String] {
    lock.lock()
    defer { lock.unlock() }
    return values
  }
  func append(_ path: String) {
    lock.lock()
    defer { lock.unlock() }
    values.append(path)
  }
  func reset() {
    lock.lock()
    defer { lock.unlock() }
    values = []
  }
}

private final class AccountCompletionProtocol: URLProtocol, @unchecked Sendable {
  static let record = AccountCompletionRequests()
  override class func canInit(with request: URLRequest) -> Bool {
    request.url?.host == "127.0.0.1" && request.url?.port == 8788
  }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    let path = request.url!.path
    Self.record.append(path)
    let body: String
    switch (request.httpMethod, path) {
    case ("GET", "/v1/changes"):
      body = "{\"version\":1,\"changes\":[],\"nextCursor\":\"Y2F0YWxvZy1yZWFkeQ\",\"hasMore\":false}"
    case ("GET", "/v1/grants"):
      body = "{\"version\":1,\"grants\":[]}"
    default:
      client?.urlProtocol(self, didFailWithError: FotoroError("Sign-in attempted an unexpected write"))
      return
    }
    let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
  override func stopLoading() {}
}
