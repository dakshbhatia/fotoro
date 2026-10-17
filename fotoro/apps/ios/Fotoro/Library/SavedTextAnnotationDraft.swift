import Foundation

// Builds only a missing OCR edit. The ledger supplies its current decrypted
// value inside a transaction and wraps returned changes with the vault key.
enum SavedTextAnnotationDraft {
  static func fillingMissingOCR(_ result: SavedTextRecognition, current: PhotoAnnotationsV1,
    state: AnnotationState, editId: String,
    wrap: (PhotoAnnotationsV1) throws -> WrappedKeyV1) throws -> (value: PhotoAnnotationsV1, state: AnnotationState)? {
    guard current.ocr == nil else { return nil }
    var value = current, next = state
    value.ocr = PhotoAnnotationsV1.OCR(text: result.text, confidence: result.confidence, processor: "vision-text-v1")
    let encrypted = try wrap(value)
    if next.draft == nil { next.base = try wrap(current) }
    next.draft = encrypted
    next.editId = editId
    // pending and pendingEditId belong to the exact frozen publication attempt.
    // Its later acknowledgement must leave this newer OCR draft in place.
    return (value, next)
  }
}
