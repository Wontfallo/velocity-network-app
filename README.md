# Velocity Network Lab

A dependency-free browser network tester with real HTTP measurements, loaded
latency, stability monitoring, and local history. Evolved from the original
Velocity speed-test HTML. No measurements are simulated in production.

## Run

Use Node.js 20 or newer:

```sh
npm start
```

Open `http://127.0.0.1:4173`. No package installation is required. Alternatively,
open `dist/Velocity.html` in a modern browser. The standalone file includes all
styles and scripts; a browser that restricts network requests or local storage
for file URLs may require the local server or a static HTTPS host.

No network test begins until you press Start. The static UI does not require a
font provider, stylesheet CDN, account, API key, or backend.

### Open on Android through HTTPS

The repository root is ready for GitHub Pages: no build or backend is needed.
In the repository's **Settings → Pages**, select **Deploy from a branch**,
**main**, and **/(root)**, then save. GitHub will show the published URL when
deployment completes. This setting must be enabled by a repository owner;
pushing source alone does not enable hosting. Browser and WebView file viewers
can impose network restrictions even when JavaScript is enabled.

## Features

- Idle HTTP latency with chronological jitter, median, and 95th percentile.
- Separate real latency probes during downloading and uploading; measured
  added latency and an explicitly heuristic load-response grade.
- Lightweight 5-, 15-, and 30-minute stability sessions with failed requests,
  latency spikes, observation gaps, and a timestamped chart.
- Saved history, labels, full dates, metric trends, CSV export, and before/after
  comparisons with absolute and percentage changes.
- Automatic sequential single-stream versus 4- or 8-stream comparisons.
- Quick, standard, or extended 5/10/20-second transfer phases; selectable
  50 MB, 250 MB, 1 GB, 5 GB, 10 GB, custom MB, or no payload cap; and
  cancellation that aborts current network requests. The default is 1 GB,
  and your budget choice is remembered in this browser.
- Actual interval throughput charts. Download and upload overlay by seconds
  into each phase; latency uses seconds since the run began.
- Optional synthesized audio, bounded diagnostic logs, keyboard controls,
  mobile layouts, and reduced-motion styling.

## Measurement method and limits

The engine uses Cloudflare's documented purpose-built `__down?bytes=N` and
`__up` endpoints. Each latency probe requests zero response-body bytes from
the same endpoint. HTTP response errors, CORS errors, timeouts, unexpected
payloads, and unsupported measurements stay failed or unavailable. Random
payload generation is only for upload traffic, never for measurement values.

Latency is elapsed browser HTTP request time through response consumption,
including browser, connection, and server overhead. It is **not ICMP ping**.
Jitter is the mean absolute difference between adjacent successful samples
in chronological order; a failed sample breaks adjacency. Median and p95 use
linear interpolation. Connection setup is included; no warm-up is excluded.

Download rates use validated response payload and observed progress from
requests cut off at the phase deadline. Known compressed responses are rejected.
Download requests are capped at 8 MiB because live local-file tests received HTTP 403 for larger requests while 1, 4, and 8 MiB succeeded; this is an observed compatibility choice, not a documented universal endpoint limit.
Upload rates count payload only after a successful response. Fetch does not
provide upload-progress events, so upload intervals reflect acknowledged chunks,
not instantaneous socket traffic. Incomplete uploads receive no speed credit.

Rates are test throughput to this endpoint, not a promise of maximum line rate.
Each phase includes HTTP overhead and may end earlier because of its budget.
Multiple Fetch requests may share an HTTP/2 or HTTP/3 connection; “streams”
means concurrent requests, not a guarantee of independent transport sockets.

The data budget conservatively reserves each entire payload before dispatch,
including requests that fail or are cancelled. It is **not an ISP billing cap**:
headers, TLS, retransmissions, probe overhead, and upload response overhead are
excluded. With a finite cap, half is reserved for each transfer direction.
Automatic comparison splits the selected cap between its two runs, then splits
each run between download and upload. **No cap** removes these payload limits;
the selected duration and Stop still end the test. Uncapped runs retain actual
usage in history with a JSON-safe `null` limit. The visible usage meter is per run.

Loaded probes run during generated transfer traffic; this does not guarantee
that the connection is fully saturated. Negative loaded-minus-idle differences
are clamped to zero for added-latency reporting. A combined grade requires real
positive transfer evidence and at least three successful samples in each of
the idle/download-loaded/upload-loaded phases. Cancelled and failed runs have
no grade. Thresholds use the worse added median: A+ ≤5 ms, A ≤30 ms, B ≤60 ms,
C ≤200 ms, otherwise D. These are app heuristics, not an industry certification.
Use-case hints are likewise broad estimates, not guarantees for individual apps.

Monitoring reports failed **HTTP requests**, not packet loss or proof that the
whole Internet was down. A delay of more than three seconds between completed
observations is listed as an observation gap; slow probes and device scheduling
can cause gaps. Hiding the tab interrupts and saves the session as cancelled.
Keep the tab visible and the device awake. A cancelled, partial, or budget-limited
run is labeled; it is never silently presented as a completed test.

History is versioned localStorage JSON, capped at 200 runs and 1,800 samples per
series. Storage failures retain an in-session copy and show a warning. Moving
the app to another URL/browser/device does not migrate its history. CSV export
contains summary measurements and settings, not every raw sample. Failed and
cancelled runs are omitted from trend lines; valid partial/budget data is shown.
Labels are rendered as text and neutralized against spreadsheet formulas in CSV.

The app uploads no saved history and collects no IP/ISP metadata. Starting a
test contacts Cloudflare; that provider necessarily receives the test requests
and your public IP. Endpoint availability, policy, or CORS support can change.

## Develop and verify

```sh
npm run check
npm test
npm run build
npm run test:browser # requires Chrome/Chromium; CHROME_BIN may name its executable
```

Source is in `src/`; `scripts/build.mjs` creates `dist/Velocity.html` without
third-party tooling. Preserve the generated bundle when distributing only one
file. Tests exercise statistics, persistence, failures, byte budgets, streaming,
timeouts, cancellation, and UI workflows. Test network responses and UI fixtures
are deterministic and do not replace the real production engine.

For final real-browser validation, serve the app and check:

1. Run a quick speed test and inspect both transfer directions and loaded probes.
2. Compare single/multiple streams with a shared budget; reload to confirm history.
3. Start a monitor, briefly disconnect/reconnect the network, and inspect failures.
4. Stop during idle, download, upload, and monitoring; no later phases should start.
5. Check mobile layout, keyboard focus, labels, CSV, and denied storage/network.

GitHub Actions also runs a dependency-free real Chrome regression check. It
exercises native `Window.fetch` with its required global receiver, then runs the
standalone UI through idle, download, and upload from HTTP and local-file pages,
using same-origin and cross-origin controlled HTTP responses. The local-file
check also uses a narrow viewport and confirms the visible build version.
Only the test fixture replaces the endpoint origin; production uses Cloudflare.
These controlled checks exercise browser behavior, not Internet speed accuracy.
Separate live Chrome and Android workflows verify the actual external endpoint.

Version 3.0.1 fixes a browser-only `Illegal invocation` error caused by calling
an unbound native `fetch` as an engine method. Both source and standalone builds
now bind it to the browser global; receiver-sensitive and real Chrome tests
cover the regression.

Version 3.0.2 makes the loaded build visible next to the endpoint and includes
the build, page protocol, embedding context, and browser user agent in local
diagnostic logs. Browser API receiver errors are distinguished from network/CORS
failures. This follows a delivery error: the original saved HTML attachment
still contained the unbound fetch after the repository was fixed. A new GitHub
commit cannot update a previously downloaded file. Check the visible version in the
app itself when replacing an older copy. JavaScript is already enabled if the
app can display a run error; changing that setting does not fix this bug.

Version 3.0.3 fixes confirmed slow-link and error-display defects. Download
requests time out on inactivity instead of discarding continuously arriving
bytes after six seconds. Uploads start smaller and reduce request size after a
timeout, counting only acknowledged bodies. A completed speed run must have a
successful idle probe and a probe under each transfer direction; missing
latency keeps the run partial. Failed UI executions stay visibly failed, with
the original error available through Logs → Copy report or Save report.
Cold latency probes receive the same six-second timeout as other requests;
their full connection time remains in the measured result. A payload limit
cannot hide an earlier request failure behind a budget-only status.

`scripts/live-smoke.mjs` checks the exact shipped artifact against Cloudflare,
with native desktop Chrome network diagnostics and screenshots. HTTP and local-file
cases require positive measurements in both directions and error-free requests.
Full-duration verification additionally requires at least three successful latency
probes per phase and final throughput samples reaching each requested five-second
phase (within 50 ms of timestamp/scheduling tolerance).

A fast connection can exhaust the 250 MB test budget before three loaded probes
finish. Such a run can pass a separate **budget-handling check** when it has at
least one real probe in every phase, labels the result incomplete, and withholds
the grade if any phase has fewer than three probes. Reports explicitly mark
`fullMeasurementVerified: false`; this does not establish full-duration or
complete loaded-latency verification. Both app runs together reserve at most
500 MB of payload. `SIZE_PROBE=1` adds a separate observational 1/4/8/16 MiB
HTTP/file endpoint matrix, capped at another 58 MiB; its responses are not
speed measurements and all failures remain in the diagnostics.

The separate Android workflow runs installed Android Chrome and a native
WebView host on an Android 16 emulator. Chrome tests **No cap** and requires
both full transfer durations; WebView also tests the standalone local file.
See `android/README.md` for its criteria and results.
The byte-identical original Gemini file is also run, with passive native network
observations kept separate from its displayed values. Consult each workflow's actual
result: adding a test does not establish that it passed. Emulator coverage
does not establish compatibility with every physical phone or WebView host.

## References

- [Cloudflare speed-test endpoint and measurement documentation](https://github.com/cloudflare/speedtest)
- [Cloudflare's measurement methodology](https://blog.cloudflare.com/how-does-cloudflares-speed-test-really-work/)

Velocity is an independent interface and is not affiliated with Cloudflare.
