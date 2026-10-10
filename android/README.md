# Actual Android WebView verification

The `Android WebView` workflow builds a small native Android test host and runs
it on the Android 16/API 36 emulator. This is Android System WebView, not a
desktop browser with a mobile user agent. The host adds JavaScript and DOM
storage support, keeping file-origin and mixed-content security restrictions
enabled. It is test infrastructure, not a distributed Android app.

The test runs three independent cases:

1. Native Android HTTP + cross-origin fixture: real received/acknowledged payloads,
   idle and loaded latency, a completed speed run, Stop, monitor cancellation,
   and two-run stream comparison. Only the endpoint origin is changed.
2. Unmodified `dist/Velocity.html` loaded over HTTP and using the real Cloudflare
   HTTPS endpoint. It requires positive upload/download and all latency metrics.
   A reached 50 MB payload cap is explicitly reported as budget-limited.
3. Unmodified standalone HTML from an Android `file://` URL. This is diagnostic:
   Android WebView may block Fetch from opaque local origins even with JavaScript
   enabled. A blocked run is reported as blocked, never a completed test.

JSON reports include the real Android API/device, WebView package/version,
user agent, visible measurements, run status, app version and browser errors.
Each case also saves a screenshot and logcat output as a workflow artifact.

This does not prove compatibility with a physical Samsung device, Brave, or an
arbitrary third-party file viewer. It does verify the app in an actual Android
runtime and exposes local-file restrictions that desktop tests do not reproduce.

To run with an existing Android emulator and Android SDK/Java17/Gradle8.13:

```
npm run build
gradle -p android :app:assembleDebug
node android/run.mjs
```

Build compatibility: [Android Gradle Plugin 8.11](https://developer.android.com/build/releases/agp-8-11-0-release-notes).
Emulator runner: [maintainer instructions](https://github.com/ReactiveCircus/android-emulator-runner).
Local origins: [Android local WebView content guidance](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content).
