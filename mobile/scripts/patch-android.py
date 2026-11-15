"""Adds the Android 13+ notification permission and the alert icon color.

Safe to run more than once.
"""
from pathlib import Path

manifest = Path("android/app/src/main/AndroidManifest.xml")
xml = manifest.read_text()

permission = '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />'
if "POST_NOTIFICATIONS" not in xml:
    xml = xml.replace("</manifest>", "    " + permission + "\n</manifest>")

color = '<meta-data android:name="com.google.firebase.messaging.default_notification_color" android:resource="@color/rentevent_alert" />'
if "default_notification_color" not in xml:
    xml = xml.replace("</application>", "        " + color + "\n    </application>")

manifest.write_text(xml)

colors = Path("android/app/src/main/res/values/rentevent_colors.xml")
colors.write_text('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="rentevent_alert">#FF5F67</color>\n</resources>\n')

print("Android project patched.")

# Release signing and build numbers, read from Codemagic's environment.
gradle = Path("android/app/build.gradle")
g = gradle.read_text()
if "CM_KEYSTORE_PATH" not in g:
    signing = '''
    signingConfigs {
        release {
            if (System.getenv("CM_KEYSTORE_PATH")) {
                storeFile file(System.getenv("CM_KEYSTORE_PATH"))
                storePassword System.getenv("CM_KEYSTORE_PASSWORD")
                keyAlias System.getenv("CM_KEY_ALIAS")
                keyPassword System.getenv("CM_KEY_PASSWORD")
            }
        }
    }
'''
    g = g.replace("    defaultConfig {", signing + "    defaultConfig {", 1)
    head, sep, tail = g.partition("buildTypes {")
    if sep:
        tail = tail.replace("release {", "release {\n            signingConfig signingConfigs.release", 1)
        g = head + sep + tail
    import re
    g = re.sub(r"versionCode\s+\d+",
               'versionCode((System.getenv("BUILD_NUMBER") ?: "1") as Integer)', g, count=1)
    gradle.write_text(g)
    print("Android signing added.")
