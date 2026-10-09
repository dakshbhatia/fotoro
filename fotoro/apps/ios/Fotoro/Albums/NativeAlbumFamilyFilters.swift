import SwiftUI

struct NativeAlbumFamilyFilters: View {
  @Binding var filter: NativeAlbumSearchFilter
  let choices: [NativeAlbumPersonChoice]
  var loadingChoices = false
  var searchError: String?
  var retrySearch: (() -> Void)?
  let memberName: (String) -> String
  @Environment(\.dismiss) private var dismiss
  private var dateRange: Binding<Bool> {
    Binding(get: { filter.from != nil || filter.until != nil }, set: { enabled in
      if enabled {
        filter.from = Calendar.current.startOfDay(for: Date().addingTimeInterval(-30 * 86400))
        filter.until = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: Date()))
      } else { filter.from = nil; filter.until = nil }
    })
  }
  var body: some View {
    NavigationStack {
      Form {
        Section("Shared names") {
          Picker("People match", selection: $filter.match) {
            ForEach(PeopleSearchMatch.allCases) { Text($0.title).tag($0) }
          }
          Text("Everyone must be labeled in the same contributing photo. Matching names from different contributors remain separate; this does not establish who visited a place.")
            .font(.footnote).foregroundStyle(.secondary)
          ForEach(choices) { choice in
            Toggle(choice.name + " · " + memberName(choice.contributor), isOn: Binding(get: { filter.people.contains(choice.id) }, set: { selected in
              if selected { filter.people.insert(choice.id) } else { filter.people.remove(choice.id) }
            }))
          }
          if let searchError {
            Text("Search is incomplete. " + searchError).foregroundStyle(.secondary)
            if let retrySearch { Button("Retry trip search", action: retrySearch) }
          } else if loadingChoices { Text("Loading shared names across the trip…").foregroundStyle(.secondary) }
          else if choices.isEmpty { Text("No shared names in this trip.").foregroundStyle(.secondary) }
        }
        Section("Shared location") { TextField("Place name or coordinates", text: $filter.place) }
        Section("Capture dates") {
          Toggle("Date range", isOn: dateRange)
          if dateRange.wrappedValue {
            DatePicker("From", selection: Binding(get: { filter.from ?? Date() }, set: { filter.from = Calendar.current.startOfDay(for: $0) }), displayedComponents: .date)
            DatePicker("Through", selection: Binding(get: {
              Calendar.current.date(byAdding: .day, value: -1, to: filter.until ?? Date()) ?? Date()
            }, set: { filter.until = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: $0)) }), displayedComponents: .date)
          }
          Text("Only recorded Photos or original capture dates match. Import dates are excluded.").font(.footnote).foregroundStyle(.secondary)
        }
        Button("Clear filters") { filter = NativeAlbumSearchFilter() }
      }.navigationTitle("Filter trip").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
  }
}
