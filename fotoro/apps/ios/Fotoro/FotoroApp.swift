import SwiftUI
import UIKit

final class FotoroApplicationDelegate: NSObject, UIApplicationDelegate {
  func application(_ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void)
  {
    BackgroundUploadTransport.shared.handleEvents(identifier: identifier, completion: completionHandler)
  }
}

@main struct FotoroApp: App {
  @UIApplicationDelegateAdaptor(FotoroApplicationDelegate.self) private var applicationDelegate
  var body: some Scene { WindowGroup { RecentPhotosView() } }
}
