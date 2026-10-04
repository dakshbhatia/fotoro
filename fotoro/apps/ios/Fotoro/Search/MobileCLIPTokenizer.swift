// CLIP byte-pair encoding adapted from Apple's MobileCLIP sample and
// Hugging Face swift-coreml-transformers (MIT). See MobileCLIP-LICENSE.txt.
// Copyright © 2024 Apple Inc.; © 2019–2023 Hugging Face.
import Foundation

struct MobileCLIPTokenizer {
  private struct Pair: Hashable { let a: String; let b: String }
  private let ranks: [Pair: Int]
  private let vocabulary: [String: Int]
  private let bytes: [UInt8: String]
  init(bundle: Bundle = .main) throws {
    guard let merges = bundle.url(forResource: "clip-merges", withExtension: "txt"),
      let vocab = bundle.url(forResource: "clip-vocab", withExtension: "json")
    else { throw FotoroError("Visual search resources are unavailable.") }
    vocabulary = try JSONDecoder().decode([String: Int].self, from: Data(contentsOf: vocab))
    var pairs: [Pair: Int] = [:]
    for (index, line) in try String(contentsOf: merges, encoding: .utf8).split(separator: "\n").dropFirst().prefix(48894).enumerated() {
      let parts = line.split(separator: " ").map(String.init)
      guard parts.count == 2 else { throw FotoroError("Visual search resources are invalid.") }
      pairs[Pair(a: parts[0], b: parts[1])] = index
    }
    ranks = pairs
    var values: [UInt8: String] = [:]
    let ordinary = Set(Array(33...126) + Array(161...172) + Array(174...255))
    var extra = 256
    for byte in 0...255 {
      let scalar = ordinary.contains(byte) ? byte : extra
      if !ordinary.contains(byte) { extra += 1 }
      values[UInt8(byte)] = String(UnicodeScalar(scalar)!)
    }
    bytes = values
  }
  func encode(_ text: String) throws -> [Int] {
    // CLIP uses lowercase, collapsed whitespace and a 77-token context with EOS.
    let clean = text.precomposedStringWithCanonicalMapping.lowercased()
      .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    let regex = try NSRegularExpression(pattern: "<\\|startoftext\\|>|<\\|endoftext\\|>|'s|'t|'re|'ve|'m|'ll|'d|[\\p{L}]+|[\\p{N}]|[^\\s\\p{L}\\p{N}]+")
    var tokens: [Int] = []
    for match in regex.matches(in: clean, range: NSRange(clean.startIndex..., in: clean)) {
      guard let range = Range(match.range, in: clean) else { continue }
      let encoded = String(clean[range]).utf8.compactMap { bytes[$0] }.joined()
      var word = encoded.map(String.init)
      guard !word.isEmpty else { continue }
      word[word.count - 1] += "</w>"
      while word.count > 1 {
        let candidates = (0..<(word.count - 1)).compactMap { index -> (Pair, Int)? in
          let pair = Pair(a: word[index], b: word[index + 1])
          return ranks[pair].map { (pair, $0) }
        }
        guard let best = candidates.min(by: { $0.1 < $1.1 })?.0 else { break }
        var merged: [String] = []; var index = 0
        while index < word.count {
          if index + 1 < word.count, word[index] == best.a, word[index + 1] == best.b {
            merged.append(best.a + best.b); index += 2
          } else { merged.append(word[index]); index += 1 }
        }
        word = merged
      }
      for part in word {
        guard let value = vocabulary[part] else { throw FotoroError("Visual search text could not be encoded.") }
        tokens.append(value)
      }
      if tokens.count >= 75 { break }
    }
    guard let start = vocabulary["<|startoftext|>"], let end = vocabulary["<|endoftext|>"] else {
      throw FotoroError("Visual search vocabulary is invalid.")
    }
    let result = [start] + Array(tokens.prefix(75)) + [end]
    return result + Array(repeating: 0, count: 77 - result.count)
  }
}
