import SwiftUI

struct NativeAlbumFamilyFilters: View {
  @Binding var filter: NativeAlbumSearchFilter
  @Binding var groupDuplicates: Bool
  let choices: [NativeAlbumPersonChoice]
  var sourceChoices: [NativeAlbumPersonChoice] = []
  var links: [TripPersonLinkV1] = []
  var review: PeopleLinksReview?
  var pendingLinks = false
  var linksBusy = false
  var linksMessage: String?
  var createLink: ((Set<String>, String) throws -> Void)?
  var removeLink: ((TripPersonLinkV1) throws -> Void)?
  var resolveLinks: ((PeopleLinksReview, Bool) throws -> Void)?
  var retryLinks: (() -> Void)?
  @State private var linking = false
  @State private var linkedSources = Set<String>()
  @State private var linkedName = ""
  @State private var linkError: String?
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
  private func reviewDetails(_ book: AccountPeopleLinksV1, title: String) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(title).font(.headline)
      if book.links.isEmpty { Text("No links.").font(.caption) }
      ForEach(book.links) { link in
        VStack(alignment: .leading, spacing: 4) {
          Text(link.name + (link.deleted ? " · Removed" : " · Linked")).font(.subheadline)
          Text("Link " + link.id).font(.caption.monospaced()).textSelection(.enabled)
          Text("Trip " + link.albumId + " · " + link.origin).font(.caption).textSelection(.enabled)
          Text("Owner " + memberName(link.ownerCard.accountId) + " · " + link.ownerCard.accountId).font(.caption)
          Text("Owner signing identity " + link.ownerCard.signingPublicKey).font(.caption.monospaced()).textSelection(.enabled)
          Text("Owner encryption identity " + link.ownerCard.boxPublicKey).font(.caption.monospaced()).textSelection(.enabled)
          ForEach(Array(link.aliases.enumerated()), id: \.offset) { _, alias in
            VStack(alignment: .leading, spacing: 2) {
              Text(alias.name + " · " + memberName(alias.card.accountId)).font(.caption)
              Text(alias.card.accountId).font(.caption.monospaced()).textSelection(.enabled)
              Text("Signing identity " + alias.card.signingPublicKey).font(.caption.monospaced()).textSelection(.enabled)
              Text("Encryption identity " + alias.card.boxPublicKey).font(.caption.monospaced()).textSelection(.enabled)
            }
          }
        }.accessibilityElement(children: .contain)
      }
    }
  }
  var body: some View {
    NavigationStack {
      Form {
        Section("People") {
          Picker("Match", selection: $filter.match) {
            ForEach(PeopleSearchMatch.allCases) { Text($0.title).tag($0) }
          }
          Text("Everyone must match one photo. Linked names use only details shared by each contributor.")
            .font(.footnote).foregroundStyle(.secondary)
          ForEach(choices) { choice in
            Toggle(choice.linkedID == nil ? choice.name + " · " + memberName(choice.contributor) : choice.name, isOn: Binding(get: { filter.people.contains(choice.id) }, set: { selected in
              if selected { filter.people.insert(choice.id) } else { filter.people.remove(choice.id) }
            }))
          }
          if sourceChoices.count >= 2, createLink != nil {
            Button("Link names") { linkedSources = []; linkedName = ""; linkError = nil; linking = true }
          }
          ForEach(links) { link in
            HStack {
              VStack(alignment: .leading) {
                Text(link.name)
                Text(link.aliases.map { $0.name + " · " + memberName($0.card.accountId) }.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
              }
              Spacer()
              Button("Remove link", role: .destructive) {
                do { try removeLink?(link); filter.people.remove("linked:" + link.id) }
                catch { linkError = error.localizedDescription }
              }
            }
          }
          if let review {
            Text("People links changed on another device. Choose which version to keep.")
            DisclosureGroup("Review changes") {
              reviewDetails(review.local, title: "Mine")
              reviewDetails(review.synced, title: "Synced")
            }
            Button("Keep mine") { do { try resolveLinks?(review, true) } catch { linkError = error.localizedDescription } }
            Button("Use synced") { do { try resolveLinks?(review, false) } catch { linkError = error.localizedDescription } }
          } else if pendingLinks { Text("People links waiting to sync.").font(.caption).foregroundStyle(.secondary) }
          if let linksMessage {
            Text(linksMessage).font(.caption).foregroundStyle(.secondary)
            if let retryLinks { Button("Retry People links", action: retryLinks).disabled(linksBusy) }
          }
          if let linkError { Text(linkError).font(.caption).foregroundStyle(.secondary) }
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
        .sheet(isPresented: $linking) {
          NavigationStack {
            Form {
              Section("Same person") {
                ForEach(sourceChoices) { choice in
                  Toggle(choice.name + " · " + memberName(choice.contributor), isOn: Binding(get: { linkedSources.contains(choice.id) }, set: { selected in
                    if selected { linkedSources.insert(choice.id); if linkedName.isEmpty { linkedName = choice.name } }
                    else { linkedSources.remove(choice.id) }
                  }))
                }
                TextField("Family name", text: $linkedName)
                Text("Confirm that these shared names refer to the same person.").font(.footnote).foregroundStyle(.secondary)
                if let linkError { Text(linkError).font(.caption).foregroundStyle(.secondary) }
              }
            }.navigationTitle("Link names").navigationBarTitleDisplayMode(.inline)
              .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { linking = false } }
                ToolbarItem(placement: .confirmationAction) {
                  Button("Confirm link") {
                    do { try createLink?(linkedSources, linkedName); filter.people.subtract(linkedSources); linking = false }
                    catch { linkError = error.localizedDescription }
                  }.disabled(linkedSources.count < 2 || !PeopleLinksCrypto.validName(linkedName))
                }
              }
          }
        }
    }
  }
}
