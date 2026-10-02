import Foundation

struct FotoroError: LocalizedError, Equatable {
  var message: String
  let requestId: String?
  let retryable: Bool
  var errorDescription: String? {
    requestId.map { "\(message) (reference: \($0))" } ?? message
  }
  init(_ message: String, requestId: String? = nil, retryable: Bool = false) {
    self.message = message
    self.retryable = retryable
    if let requestId, let uuid = UUID(uuidString: requestId),
      requestId.caseInsensitiveCompare(uuid.uuidString) == .orderedSame
    {
      self.requestId = requestId
    } else {
      self.requestId = nil
    }
  }
}
