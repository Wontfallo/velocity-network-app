# Actual Android browser verification

The `Android browsers` workflow runs preinstalled Android Chrome and a small
native WebView test host on the Android 16/API 36 emulator. These are actual
Android runtimes, not a desktop browser with a mobile user agent. Chrome's
ordinary browser security stays enabled. The WebView host enables JavaScript
and DOM storage, retaining file-origin and mixed-content security restrictions.
It is test infrastructure, not a distributed Android app. An unavailable Chrome
installation is reported explicitly; it is never replaced by a claimed WebView
or desktop Chrome result.

The test runs five independent cases:

1. Native Android HTTP + cross-origin fixture: real received/acknowledged payloads,
   idle and loaded latency, a completed speed run, Stop, monitor cancellation,
   and two-run stream comparison. Only the endpoint origin is changed.
2. Unmodified `dist/Velocity.html` loaded over HTTP in **Android Chrome**, using
   the real Cloudflare HTTPS endpoint. It requires positive upload/download and
   all latency metrics.
   This one case selects **No cap**, with five seconds per transfer phase. It
   must complete both requested durations, retain a null payload limit, and
   record finite actual payload usage. This removes the payload cap, not the
   time limit. Every transfer direction must have actual bytes and no errors;
   idle/download-loaded/upload-loaded phases must each have at least three
   successful probes and no failed probes.
3. Unmodified standalone HTML from an Android `file://` URL with the same strict
   measurement assertions and a 250 MB cap. The fixture also stays at 250 MB.
   A reached cap is explicitly budget-limited, with
   `fullDurationCompleted: false`. Android WebView may restrict local origins,
   so a blocked run fails this test rather than being called a passed network run.
4. The user's exact original HTML loaded over HTTP, and
5. The same original loaded from an Android `file://` URL. These comparison
   cases record visible results alongside passive native DevTools network
   events. Original fetch is never wrapped. The uploaded baseline hash is
   checked before the run; original displayed success is distinguished from
   acknowledged network transfers because the original has synthetic fallbacks.

JSON reports include the real Android API/device, browser package/version,
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
