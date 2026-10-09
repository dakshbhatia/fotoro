import SwiftUI

struct NativeAlbumFamilyFilters: View {
  @Binding var filter: NativeAlbumSearchFilter
  @Binding var groupDuplicates: Bool
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
        Section("People") {
          Picker("Match", selection: $filter.match) {
            ForEach(PeopleSearchMatch.allCases) { Text($0.title).tag($0) }
          }
          Text("Names are separate for each contributor. Everyone must match one photo. Names do not confirm visits.")
            .font(.footnote).foregroundStyle(.secondary)
          ForEach(choices) { choice in
            Toggle(choice.name + " · " + memberName(choice.contributor), isOn: Binding(get: { filter.people.contains(choice.id) }, set: { selected in
              if selected { filter.people.insert(choice.id) } else { filter.people.remove(choice.id) }
            }))
          }
          if let searchError {
            DisclosureGroup("Search incomplete") { Text(searchError).textSelection(.enabled) }.foregroundStyle(.secondary)
            if let retrySearch { Button("Retry", action: retrySearch).accessibilityLabel("Retry trip search") }
          } else if loadingChoices { Text("Loading names…").foregroundStyle(.secondary) }
          else if choices.isEmpty { Text("No shared names.").foregroundStyle(.secondary) }
        }
        Section("Place") { TextField("Place or coordinates", text: $filter.place) }
        Section("Dates") {
          Toggle("Date range", isOn: dateRange)
          if dateRange.wrappedValue {
            DatePicker("From", selection: Binding(get: { filter.from ?? Date() }, set: { filter.from = Calendar.current.startOfDay(for: $0) }), displayedComponents: .date)
            DatePicker("Through", selection: Binding(get: {
              Calendar.current.date(byAdding: .day, value: -1, to: filter.until ?? Date()) ?? Date()
            }, set: { filter.until = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: $0)) }), displayedComponents: .date)
          }
          Text("Capture dates only; import dates are excluded.").font(.footnote).foregroundStyle(.secondary)
        }
        Section {
          Toggle("Group exact copies", isOn: $groupDuplicates)
          if filter.hasFilters || !groupDuplicates {
            Button("Clear filters") { filter = NativeAlbumSearchFilter(); groupDuplicates = true }
          }
        }
      }.navigationTitle("Filters").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
  }
}
