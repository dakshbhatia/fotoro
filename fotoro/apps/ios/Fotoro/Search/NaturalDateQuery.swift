import Foundation

struct NaturalDateQuery: Sendable {
  var text: String
  var scope: SearchScope
  var datePhrase: String?

  // Deliberately small grammar: date constraints remove only their own words.
  // The remaining scene/person query still needs independent indexed evidence.
  static func parse(
    _ query: String, scope: SearchScope = SearchScope(), now: Date = Date(),
    calendar: Calendar = .current
  ) -> NaturalDateQuery {
    var gregorian = Calendar(identifier: .gregorian)
    gregorian.timeZone = calendar.timeZone
    gregorian.firstWeekday = calendar.firstWeekday
    gregorian.minimumDaysInFirstWeek = calendar.minimumDaysInFirstWeek
    let calendar = gregorian
    let text = SearchNormalization.text(query)
    var result = NaturalDateQuery(text: text, scope: scope)
    func apply(_ interval: DateInterval?, prefix: String, phrase: String) -> NaturalDateQuery? {
      guard let interval else { return nil }
      var value = result
      value.text = remaining(prefix)
      value.datePhrase = phrase
      value.scope.from = maxDate(scope.from, interval.start)
      value.scope.until = minDate(scope.until, interval.end)
      return value
    }
    let periods: [(String, Calendar.Component, Int)] = [
      ("today", .day, 0), ("yesterday", .day, -1),
      ("this week", .weekOfYear, 0), ("last week", .weekOfYear, -1),
      ("this month", .month, 0), ("last month", .month, -1),
      ("this year", .year, 0), ("last year", .year, -1),
    ]
    for (phrase, component, offset) in periods {
      if text == phrase || text.hasSuffix(" " + phrase) {
        let prefix = String(text.dropLast(phrase.count)).trimmingCharacters(in: .whitespaces)
        let date = calendar.date(byAdding: component, value: offset, to: now)
        if let value = apply(date.flatMap { calendar.dateInterval(of: component, for: $0) },
          prefix: prefix, phrase: phrase) { return value }
      }
      if text.hasPrefix(phrase + " ") {
        let rest = String(text.dropFirst(phrase.count)).trimmingCharacters(in: .whitespaces)
        let date = calendar.date(byAdding: component, value: offset, to: now)
        if let value = apply(date.flatMap { calendar.dateInterval(of: component, for: $0) },
          prefix: rest, phrase: phrase) { return value }
      }
    }
    let words = text.split(separator: " ").map(String.init)
    // ISO ranges are inclusive of the whole final date/month/year, with no
    // fabricated 23:59:59 boundary (which would drop subsecond capture dates).
    if words.count >= 4 {
      let end = words.count
      let range = Array(words[(end - 4)..<end])
      if range[0] == "from", ["to", "through"].contains(range[2]),
        let first = strictPeriod(range[1], calendar: calendar),
        let last = strictPeriod(range[3], calendar: calendar), first.start < last.end
      {
        return apply(DateInterval(start: first.start, end: last.end),
          prefix: words.dropLast(4).joined(separator: " "), phrase: range.joined(separator: " "))!
      }
    }
    // Explicit English month names have fixed meaning; ambiguous 10/2 dates
    // and incomplete/invalid dates remain ordinary evidence-based text.
    for count in [3, 2] where words.count >= count {
      let phrase = words.suffix(count).joined(separator: " ")
      if let interval = namedPeriod(phrase, calendar: calendar) {
        return apply(interval, prefix: words.dropLast(count).joined(separator: " "), phrase: phrase)!
      }
      if monthNames.contains(words[words.count - count]) { return result }
    }
    // An ISO date may stand alone or follow a scene term and date operator.
    if let last = words.last, let interval = strictPeriod(last, calendar: calendar) {
      let preceding = Array(words.dropLast())
      if let operation = preceding.last, ["before", "after", "since"].contains(operation) {
        result.text = remaining(preceding.dropLast().joined(separator: " "))
        result.datePhrase = operation + " " + last
        if operation == "before" { result.scope.until = minDate(scope.until, interval.start) }
        else {
          result.scope.from = maxDate(scope.from, operation == "after" ? interval.end : interval.start)
        }
        return result
      }
      return apply(interval, prefix: preceding.joined(separator: " "), phrase: last)!
    }
    return result
  }

  private static func remaining(_ value: String) -> String {
    var words = value.split(separator: " ").map(String.init)
    if let last = words.last, ["from", "in", "on", "during"].contains(last) { words.removeLast() }
    if let first = words.first, ["photo", "photos", "picture", "pictures"].contains(first) {
      words.removeFirst()
      if words.first == "of" { words.removeFirst() }
    }
    return words.joined(separator: " ")
  }
  private static func minDate(_ first: Date?, _ second: Date) -> Date {
    first.map { min($0, second) } ?? second
  }
  private static func maxDate(_ first: Date?, _ second: Date) -> Date {
    first.map { max($0, second) } ?? second
  }
  private static func strictPeriod(_ value: String, calendar: Calendar) -> DateInterval? {
    let parts = value.split(separator: "-", omittingEmptySubsequences: false)
    guard (1...3).contains(parts.count), parts[0].count == 4,
      parts.allSatisfy({ $0.allSatisfy(\.isNumber) }),
      let year = Int(parts[0]), (1900...2200).contains(year)
    else { return nil }
    if parts.count > 1, parts[1].count != 2 { return nil }
    if parts.count > 2, parts[2].count != 2 { return nil }
    let month = parts.count > 1 ? Int(parts[1]) : 1
    let day = parts.count > 2 ? Int(parts[2]) : 1
    guard let month, let day else { return nil }
    return period(year: year, month: month, day: day,
      component: parts.count == 1 ? .year : parts.count == 2 ? .month : .day, calendar: calendar)
  }
  private static func namedPeriod(_ value: String, calendar: Calendar) -> DateInterval? {
    let words = value.replacingOccurrences(of: ",", with: "").split(separator: " ").map(String.init)
    guard (2...3).contains(words.count), let monthIndex = monthNames.firstIndex(of: words[0]),
      let last = words.last, last.count == 4, let year = Int(last), (1900...2200).contains(year)
    else { return nil }
    let day = words.count == 3 ? Int(words[1]) : 1
    guard let day else { return nil }
    return period(year: year, month: monthIndex + 1, day: day,
      component: words.count == 3 ? .day : .month, calendar: calendar)
  }
  private static let monthNames = ["january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december"]
  private static func period(
    year: Int, month: Int, day: Int, component: Calendar.Component, calendar: Calendar
  ) -> DateInterval? {
    guard let date = calendar.date(from: DateComponents(year: year, month: month, day: day)),
      calendar.component(.year, from: date) == year,
      calendar.component(.month, from: date) == month,
      calendar.component(.day, from: date) == day
    else { return nil }
    return calendar.dateInterval(of: component, for: date)
  }
}
