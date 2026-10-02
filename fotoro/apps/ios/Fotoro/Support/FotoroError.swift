import Foundation

struct FotoroError: LocalizedError, Equatable {
  var message: String
  var errorDescription: String? { message }
  init(_ message: String) { self.message = message }
}
