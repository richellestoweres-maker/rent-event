"""Adds what the iPhone app needs for push alerts and Firebase.

Safe to run more than once.
"""
import plistlib
from pathlib import Path

APP = Path("ios/App/App")

# 1. Hand the phone's push registration to the Firebase plugin.
delegate = APP / "AppDelegate.swift"
code = delegate.read_text()
if "capacitorDidRegisterForRemoteNotifications" not in code:
    addition = '''
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ application: UIApplication,
                     didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        NotificationCenter.default.post(name: Notification.Name.init("didReceiveRemoteNotification"),
                                        object: completionHandler,
                                        userInfo: userInfo)
    }
'''
    cut = code.rstrip().rfind("}")
    code = code[:cut] + addition + "}\n"
    delegate.write_text(code)

# 2. Info.plist: background push, and plain-English permission text.
info_path = APP / "Info.plist"
with open(info_path, "rb") as f:
    info = plistlib.load(f)
modes = info.setdefault("UIBackgroundModes", [])
if "remote-notification" not in modes:
    modes.append("remote-notification")
info["ITSAppUsesNonExemptEncryption"] = False
info["CFBundleDisplayName"] = "RentEvent"
info["NSPhotoLibraryUsageDescription"] = "RentEvent uses your photos so you can add pictures to your listings and profile."
info["NSCameraUsageDescription"] = "RentEvent uses the camera so you can take photos for your listings and profile."
with open(info_path, "wb") as f:
    plistlib.dump(info, f)

# 3. Entitlements file turning on push.
entitlements = APP / "App.entitlements"
with open(entitlements, "wb") as f:
    plistlib.dump({"aps-environment": "production"}, f)

print("iPhone project patched.")
