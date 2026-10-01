import SwiftUI

@main struct FotoroApp: App {
  @State private var services = try! AppServices()
  var body: some Scene { WindowGroup { LibraryView(services: services) } }
}
