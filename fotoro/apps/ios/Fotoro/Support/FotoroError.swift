import Foundation

struct FotoroError: LocalizedError, Equatable {
  var message: String
  let requestId: String?
  let retryable: Bool
  var errorDescription: String? {
    let detail = switch message {
    case "STORAGE_QUOTA_EXCEEDED": "Fotoro storage is full. Pause sync or contact support."
    case "AUTH_RATE_LIMITED": "Too many attempts. Wait a minute and try again."
    default: message
    }
    return requestId.map { "\(detail) (reference: \($0))" } ?? detail
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
