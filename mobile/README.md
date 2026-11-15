# RentEvent app (iPhone and Android)

This folder is the RentEvent app. It opens rentevent-app.com inside a real native app and adds the things a website can't do on its own:

* Real push alerts on iPhone and Android, with taps opening the right page
* Verified subscriptions open in the phone's browser, as the app stores require
* App icon, launch screen, and a friendly offline screen

Site updates show up in the app right away. You only rebuild the app when something in this folder changes.

The apps are built in the cloud by Codemagic, so no Mac is needed.

## One time setup

### 1. Firebase (about 10 minutes)

In the Firebase console for rent-event-f7abd, open Project settings, then Your apps.

* Add an iOS app with bundle ID `com.rentevent.app`. Download **GoogleService-Info.plist**.
* Add an Android app with package name `com.rentevent.app`. Download **google-services.json**.

### 2. Apple push key

In developer.apple.com, open Certificates, IDs and Profiles, then Keys. Create a key with **Apple Push Notifications service** checked and download the .p8 file. Note the Key ID and your Team ID.

Back in Firebase, open Project settings, then Cloud Messaging, then your iOS app. Upload the .p8 file under APNs Authentication Key.

### 3. App Store Connect

* Create the app: My Apps, then New App, bundle ID `com.rentevent.app`, name RentEvent.
* Create an API key: Users and Access, then Integrations, then App Store Connect API. Give it App Manager access and download the .p8 file.

### 4. Codemagic

Sign in at codemagic.io with GitHub and add the `rent-event` repository.

* **Team settings, Integrations, Developer Portal:** add the App Store Connect API key. Name it exactly `RentEvent App Store key`.
* **App settings, Environment variables:** make a group named `firebase` with two secret variables:
  * `GOOGLE_SERVICE_INFO_PLIST` set to the base64 text of GoogleService-Info.plist
  * `GOOGLE_SERVICES_JSON` set to the base64 text of google-services.json
* **Team settings, Code signing identities, Android keystores:** generate a new keystore and name it `rentevent_upload_key`. Download a backup and keep it safe. Google Play needs this same key for every future update.

### 5. Build

In Codemagic, start **RentEvent iPhone app**. It goes to TestFlight automatically. Start **RentEvent Android app** and upload the .aab file it makes to Google Play Console.
