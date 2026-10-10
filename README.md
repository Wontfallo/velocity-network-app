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

## Features

- Idle HTTP latency with chronological jitter, median, and 95th percentile.
- Separate real latency probes during downloading and uploading; measured
  added latency and an explicitly heuristic load-response grade.
- Lightweight 5-, 15-, and 30-minute stability sessions with failed requests,
  latency spikes, observation gaps, and a timestamped chart.
- Saved history, labels, full dates, metric trends, CSV export, and before/after
  comparisons with absolute and percentage changes.
- Automatic sequential single-stream versus 4- or 8-stream comparisons.
- Quick, standard, or extended 5/10/20-second transfer phases, a shared payload
  budget, and cancellation that aborts current network requests.
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
excluded. Half the budget is reserved for each transfer direction. Automatic
comparison splits the total selected budget between its two runs, then splits
each run between download and upload. The visible budget meter is per run.

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
standalone UI through idle, download, and upload against controlled local HTTP
responses. Only the test fixture replaces the endpoint origin; production uses
Cloudflare. These checks exercise browser behavior, not Internet speed accuracy.
The restricted development environment cannot verify the live external endpoint.

Version 3.0.1 fixes a browser-only `Illegal invocation` error caused by calling
an unbound native `fetch` as an engine method. Both source and standalone builds
now bind it to the browser global; receiver-sensitive and real Chrome tests
cover the regression.

## References

- [Cloudflare speed-test endpoint and measurement documentation](https://github.com/cloudflare/speedtest)
- [Cloudflare's measurement methodology](https://blog.cloudflare.com/how-does-cloudflares-speed-test-really-work/)

Velocity is an independent interface and is not affiliated with Cloudflare.
