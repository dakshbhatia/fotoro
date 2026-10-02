import SwiftUI
import UIKit

#if !FOTORO_LOCAL_PREVIEW
final class FotoroApplicationDelegate: NSObject, UIApplicationDelegate {
  func application(_ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void)
  {
    BackgroundUploadTransport.shared.handleEvents(identifier: identifier, completion: completionHandler)
  }
}
#endif

@main struct FotoroApp: App {
#if !FOTORO_LOCAL_PREVIEW
  @UIApplicationDelegateAdaptor(FotoroApplicationDelegate.self) private var applicationDelegate
#endif
  var body: some Scene { WindowGroup { RecentPhotosView() } }
}
