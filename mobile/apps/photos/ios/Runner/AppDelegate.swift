import AVFoundation
import Flutter
import UIKit
import UserNotifications
import app_links
import ente_background_manager
import receive_sharing_intent
import workmanager_apple

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private static let workmanagerDebugThreadIdentifier =
    "io.ente.frame.workmanager.debug"

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    configureWorkmanagerDebugHandler()

    // Prevent interrupting background audio from other apps on launch
    do {
      try AVAudioSession.sharedInstance().setCategory(
        .ambient,
        mode: .default,
        options: [.mixWithOthers]
      )
    } catch {
      print("Failed to configure initial audio session: \(error)")
    }

    if #available(iOS 10.0, *) {
      UNUserNotificationCenter.current().delegate = self as UNUserNotificationCenterDelegate
    }

    BackgroundManagerPlugin.install(
      isEnabled: { Self.shouldUseNativeBackgroundManager() },
      registrant: { registry in GeneratedPluginRegistrant.register(with: registry) }
    )
    BackgroundManagerPlugin.registerTask(
      identifier: "io.ente.photos.nativeBackgroundRefresh", processing: false)
    BackgroundManagerPlugin.registerTask(
      identifier: "io.ente.photos.nativeBackgroundProcessing", processing: true)
    WorkmanagerPlugin.setPluginRegistrantCallback { registry in
      GeneratedPluginRegistrant.register(with: registry)
    }
    let freqInMinutes = 30 * 60
    WorkmanagerPlugin.registerPeriodicTask(
      withIdentifier: "io.ente.frame.iOSBackgroundAppRefresh",
      frequency: NSNumber(value: freqInMinutes))
    WorkmanagerPlugin.registerBGProcessingTask(
      withIdentifier: "io.ente.frame.iOSBackgroundProcessing")

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
  }

  private func configureWorkmanagerDebugHandler() {
    guard shouldEnableWorkmanagerDebugNotifications() else {
      return
    }

    WorkmanagerDebug.setCurrent(
      NotificationDebugHandler(threadIdentifier: Self.workmanagerDebugThreadIdentifier)
    )
  }

  private static func shouldUseNativeBackgroundManager() -> Bool {
    let defaults = UserDefaults.standard
    guard !defaults.bool(forKey: "flutter.ls.internal_user_disabled") else {
      return false
    }
    guard let remoteFlags = defaults.string(forKey: "flutter.remote_flags"),
      let data = remoteFlags.data(using: .utf8),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      return false
    }
    return json["internalUser"] as? Bool ?? false
  }

  private func shouldEnableWorkmanagerDebugNotifications() -> Bool {
    let defaults = UserDefaults.standard
    if defaults.bool(forKey: "flutter.ls.internal_user_disabled") {
      return false
    }
    if !defaults.bool(forKey: "flutter.ls.bg_debug_notifications_enabled") &&
        defaults.object(forKey: "flutter.ls.bg_debug_notifications_enabled") != nil {
      return false
    }

    guard let remoteFlags = defaults.string(forKey: "flutter.remote_flags"),
          let data = remoteFlags.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
      return false
    }

    return json["internalUser"] as? Bool ?? false
  }

  override func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let content = notification.request.content
    // iOS suppresses foreground notification presentation unless the delegate
    // opts in. Workmanager debug notifications are silent (banner only); all
    // other notifications get the standard banner + sound + badge.
    if content.threadIdentifier == Self.workmanagerDebugThreadIdentifier {
      if #available(iOS 14.0, *) {
        completionHandler([.list, .banner])
      } else {
        completionHandler([.alert])
      }
      return
    }

    if #available(iOS 14.0, *) {
      completionHandler([.list, .banner, .sound, .badge])
    } else {
      completionHandler([.alert, .sound, .badge])
    }
  }
}

// Keep this in the existing Runner source so every build configuration includes it.
class SceneDelegate: FlutterSceneDelegate {
  private let foregroundHeartbeat = ForegroundHeartbeat()

  override func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    super.scene(scene, willConnectTo: session, options: connectionOptions)
    // app_links currently registers application callbacks, not scene callbacks.
    // Capture the initial link before Dart subscribes, preserving the widget filter.
    for context in connectionOptions.urlContexts {
      _ = SwiftReceiveSharingIntentPlugin.instance.application(
        UIApplication.shared,
        didFinishLaunchingWithOptions: [UIApplication.LaunchOptionsKey.url: context.url])
      if !context.url.absoluteString.contains("homeWidget") {
        AppLinks.shared.handleLink(url: context.url)
      }
    }
    for activity in connectionOptions.userActivities {
      _ = SwiftReceiveSharingIntentPlugin.instance.application(
        UIApplication.shared, continue: activity, restorationHandler: { _ in })
      if let url = activity.webpageURL {
        AppLinks.shared.handleLink(url: url)
      }
    }
  }

  override func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    super.scene(scene, openURLContexts: URLContexts)
    // Bridge only the URL plugins that still lack scene callbacks.
    // home_widget 0.10 handles its own scene events through super.
    for context in URLContexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [
        .openInPlace: context.options.openInPlace
      ]
      if let source = context.options.sourceApplication { options[.sourceApplication] = source }
      if let annotation = context.options.annotation { options[.annotation] = annotation }
      _ = SwiftReceiveSharingIntentPlugin.instance.application(
        UIApplication.shared, open: context.url, options: options)
      if !context.url.absoluteString.contains("homeWidget") {
        AppLinks.shared.handleLink(url: context.url)
      }
    }
  }

  override func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    super.scene(scene, continue: userActivity)
    _ = SwiftReceiveSharingIntentPlugin.instance.application(
      UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
    if let url = userActivity.webpageURL { AppLinks.shared.handleLink(url: url) }
  }

  override func sceneDidBecomeActive(_ scene: UIScene) {
    super.sceneDidBecomeActive(scene)
    foregroundHeartbeat.start()
    signal(SIGPIPE, SIG_IGN)
  }

  override func sceneWillEnterForeground(_ scene: UIScene) {
    super.sceneWillEnterForeground(scene)
    foregroundHeartbeat.start()
    signal(SIGPIPE, SIG_IGN)
  }

  override func sceneDidEnterBackground(_ scene: UIScene) {
    foregroundHeartbeat.stop()
    super.sceneDidEnterBackground(scene)
  }

  override func sceneDidDisconnect(_ scene: UIScene) {
    foregroundHeartbeat.stop()
    super.sceneDidDisconnect(scene)
  }
}
