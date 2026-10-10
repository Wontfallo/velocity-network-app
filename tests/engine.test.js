import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeedTestEngine, SPEED_ENDPOINT } from '../src/engine.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const testConfig = {
  idleProbeCount: 2, idleProbeGapMs: 0, durationScale: 0.01,
  requestTimeoutMs: 20, sampleIntervalMs: 5,
  initialDownloadBytes: 100, initialUploadBytes: 100,
  maxDownloadBytes: 100, maxUploadBytes: 100,
};
const testOptions = { streams: 1, duration: 5, budgetBytes: 1_000_000, probeIntervalMs: 5 };

function goodFetch(calls = [], delayMs = 2) {
  return async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, method: init.method, body: init.body, signal: init.signal });
    await wait(delayMs);
    if (init.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return new Response(init.method === 'POST' ? '{}' : new Uint8Array(Number(parsed.searchParams.get('bytes'))), {
      status: 200, headers: { 'Content-Type': init.method === 'POST' ? 'application/json' : 'application/octet-stream' },
    });
  };
}

test('default browser fetch keeps the global receiver through speed and monitor requests', async t => {
  const calls = [];
  const respond = goodFetch(calls, 1);
  // Native Window.fetch rejects an unrelated receiver. Arrow-function mocks
  // cannot reveal the bug caused by copying it onto the engine instance.
  t.mock.method(globalThis, 'fetch', function (url, init) {
    if (this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    return respond(url, init);
  });
  const engine = new SpeedTestEngine({ ...testConfig });
  const speed = await engine.run(testOptions);
  assert.equal(speed.status, 'completed');
  assert.ok(speed.download.bytes > 0);
  assert.ok(speed.upload.bytes > 0);
  assert.deepEqual(speed.errors, []);
  const monitor = await new SpeedTestEngine({ ...testConfig, durationScale: 0.0002 })
    .monitor({ ...testOptions, monitorMinutes: 5, probeIntervalMs: 3 });
  assert.equal(monitor.status, 'completed');
  assert.ok(monitor.latency.monitor.length > 0);
  assert.deepEqual(monitor.errors, []);
});

test('an explicitly supplied browser fetch also keeps its required global receiver', async () => {
  const respond = goodFetch([], 1);
  function browserFetch(url, init) {
    if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    return respond(url, init);
  }
  const result = await new SpeedTestEngine({ ...testConfig, fetchImpl: browserFetch }).run(testOptions);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.errors, []);
});

test('measures actual payload and chronological idle and loaded probes in both directions', async () => {
  const calls = [], events = [];
  const engine = new SpeedTestEngine({ ...testConfig, fetchImpl: goodFetch(calls), onEvent: event => events.push(event) });
  const result = await engine.run(testOptions);
  assert.equal(engine.isRunning, false);
  assert.equal(result.status, 'completed');
  assert.equal(result.settings.endpoint, SPEED_ENDPOINT);
  assert.ok(result.download.mbps > 0);
  assert.ok(result.upload.mbps > 0);
  assert.ok(result.download.bytes > 0);
  assert.ok(result.upload.bytes > 0);
  for (const phase of ['idle', 'download', 'upload']) {
    assert.ok(result.latency[phase].length > 0, phase);
    assert.ok(result.latency[phase].every(item => item.ms !== null));
    assert.deepEqual(result.latency[phase].map(item => item.t), result.latency[phase].map(item => item.t).sort((a, b) => a - b));
  }
  assert.ok(events.some(event => event.type === 'throughput' && event.phase === 'download'));
  assert.ok(events.some(event => event.type === 'throughput' && event.phase === 'upload'));
  assert.ok(calls.filter(call => call.method === 'POST').every(call => call.body instanceof Uint8Array));
  assert.ok(result.download.samples.length > 1);
});

test('failed requests never generate latency values or imaginary upload bytes', async () => {
  const engine = new SpeedTestEngine({
    ...testConfig, fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
  });
  const result = await engine.run({ ...testOptions, budgetBytes: 400 });
  assert.equal(result.status, 'failed');
  assert.equal(result.download.mbps, null);
  assert.equal(result.upload.mbps, null);
  assert.equal(result.download.bytes, 0);
  assert.equal(result.upload.bytes, 0);
  assert.ok(result.latency.idle.every(sample => sample.ms === null && sample.error.includes('Network/CORS')));
  assert.ok(result.budget.usedBytes > 0, 'failed attempts still consume reserved budget');
  assert.ok(result.errors.length > 0);
});

test('HTTP status errors do not count response or upload payload as measured transfer', async () => {
  const engine = new SpeedTestEngine({
    ...testConfig, fetchImpl: async () => new Response('blocked', { status: 503 }),
  });
  const result = await engine.run(testOptions);
  assert.equal(result.download.bytes, 0);
  assert.equal(result.upload.bytes, 0);
  assert.equal(result.download.mbps, null);
  assert.equal(result.upload.mbps, null);
  assert.match(result.errors[0], /HTTP 503/);
});

test('compressed downloads are rejected before counting decoded payload bytes', async () => {
  const engine = new SpeedTestEngine({
    ...testConfig,
    fetchImpl: async (url, init) => {
      const bytes = Number(new URL(url).searchParams.get('bytes'));
      if (init.method === 'POST') return new Response('{}');
      return new Response(new Uint8Array(bytes), { headers: bytes ? { 'Content-Encoding': 'gzip' } : {} });
    },
  });
  const result = await engine.run({ ...testOptions, budgetBytes: 200 });
  assert.equal(result.download.mbps, null);
  assert.equal(result.download.bytes, 0);
  assert.match(result.download.errors[0], /Compressed download/);
  assert.ok(result.upload.bytes > 0);
});

test('oversized and truncated responses never leave a fabricated download speed', async () => {
  for (const actualBytes of [5, 200]) {
    const engine = new SpeedTestEngine({
      ...testConfig,
      fetchImpl: async (url, init) => {
        const bytes = Number(new URL(url).searchParams.get('bytes'));
        if (init.method === 'POST') return new Response('{}');
        return new Response(new Uint8Array(bytes ? actualBytes : 0));
      },
    });
    const result = await engine.run({ ...testOptions, budgetBytes: 200 });
    assert.equal(result.download.mbps, null);
    assert.equal(result.download.bytes, 0);
    assert.deepEqual(result.download.samples, []);
    assert.ok(result.download.errors.length > 0);
  }
});

test('reservations cap concurrent payload attempts and leave an upload allowance', async () => {
  const calls = [];
  const engine = new SpeedTestEngine({ ...testConfig, fetchImpl: goodFetch(calls) });
  const result = await engine.run({ ...testOptions, streams: 8, budgetBytes: 1001 });
  const downloadRequested = calls.reduce((total, call) => total + (call.method === 'GET' ? Number(call.url.searchParams.get('bytes')) : 0), 0);
  const uploadRequested = calls.reduce((total, call) => total + (call.method === 'POST' ? call.body.byteLength : 0), 0);
  assert.equal(downloadRequested, 500);
  assert.equal(uploadRequested, 501);
  assert.equal(result.budget.usedBytes, 1001);
  assert.equal(result.download.bytes, 500);
  assert.equal(result.upload.bytes, 501);
  assert.equal(result.status, 'budget');
  assert.equal(result.stopReason, 'payload budget reached');
});

test('a payload cap does not hide an earlier failed probe behind budget status', async () => {
  let requests = 0;
  const successfulFetch = goodFetch();
  const engine = new SpeedTestEngine({
    ...testConfig,
    fetchImpl: (url, init) => {
      if (++requests === 1) throw new TypeError('connection interrupted');
      return successfulFetch(url, init);
    },
  });
  const result = await engine.run({ ...testOptions, budgetBytes: 200 });
  assert.equal(result.download.status, 'budget');
  assert.equal(result.upload.status, 'budget');
  assert.equal(result.download.bytes, 100);
  assert.equal(result.upload.bytes, 100);
  assert.equal(result.status, 'partial');
  assert.equal(result.stopReason, 'payload budget reached');
  assert.ok(result.errors.some(error => error.startsWith('idle:')));
  assert.equal(result.latency.idle[0].ms, null);
});

test('cold connection latency above two seconds is retained as a real measurement', async () => {
  let requests = 0;
  const successfulFetch = goodFetch();
  const engine = new SpeedTestEngine({
    ...testConfig, requestTimeoutMs: 6000,
    fetchImpl: async (url, init) => {
      // Cold DNS/TLS or mobile scheduling can exceed the old 2s probe timeout.
      if (++requests === 1) await wait(2100);
      return successfulFetch(url, init);
    },
  });
  const result = await engine.run(testOptions);
  assert.equal(result.status, 'completed');
  assert.equal(result.latency.idle.length, testConfig.idleProbeCount);
  assert.ok(result.latency.idle[0].ms >= 2000, 'the cold request is measured, not discarded as warm-up');
  assert.ok(result.latency.idle[0].ms < 6000);
  assert.deepEqual(result.errors, []);
});

test('stop during an idle request cancels promptly even if a fetch promise never settles', async () => {
  const engine = new SpeedTestEngine({ ...testConfig, requestTimeoutMs: 10_000, fetchImpl: () => new Promise(() => {}) });
  const pending = engine.run(testOptions);
  assert.equal(engine.isRunning, true);
  engine.stop();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stopReason, 'user');
  assert.equal(result.latency.idle.length, 0, 'user cancellations are not failed probes');
  assert.equal(result.download.status, 'not-run');
  assert.equal(engine.isRunning, false);
});

test('stop during a streaming download cancels its reader and prevents upload', async () => {
  let readerCancelled = false, uploads = 0;
  let engine;
  engine = new SpeedTestEngine({
    ...testConfig, requestTimeoutMs: 10_000,
    fetchImpl: async (url, init) => {
      if (init.method === 'POST') { uploads++; return new Response('{}'); }
      if (Number(new URL(url).searchParams.get('bytes')) === 0) return new Response(new Uint8Array());
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(20)); },
        cancel() { readerCancelled = true; },
      }));
    },
    onEvent: event => { if (event.type === 'throughput' && event.phase === 'download') engine.stop('test stop'); },
  });
  const result = await engine.run(testOptions);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stopReason, 'test stop');
  assert.equal(uploads, 0);
  assert.equal(readerCancelled, true);
  assert.equal(engine.isRunning, false);
});

test('deadline aborts unfinished uploads without crediting their requested bytes', async () => {
  const engine = new SpeedTestEngine({
    ...testConfig, requestTimeoutMs: 10_000,
    fetchImpl: async (url, init) => {
      if (init.method === 'POST') return new Promise(() => {});
      return new Response(new Uint8Array(Number(new URL(url).searchParams.get('bytes'))));
    },
  });
  const result = await engine.run({ ...testOptions, budgetBytes: 400 });
  assert.equal(result.upload.bytes, 0);
  assert.equal(result.upload.mbps, null);
  assert.ok(result.budget.usedBytes >= 300, 'unfinished upload still reserves its full requested body');
  assert.equal(result.status, 'partial');
});

test('successful transfers with no completed loaded probes remain an incomplete test', async () => {
  let latencyCalls = 0;
  const engine = new SpeedTestEngine({
    ...testConfig, requestTimeoutMs: 500, latencyTimeoutMs: 500,
    fetchImpl: async (url, init) => {
      const bytes = Number(new URL(url).searchParams.get('bytes'));
      if (init.method !== 'POST' && bytes === 0) {
        // Idle succeeds; loaded probes settle only after their transfer phase.
        if (++latencyCalls > testConfig.idleProbeCount) await wait(100);
        return new Response();
      }
      await wait(2);
      return new Response(init.method === 'POST' ? '{}' : new Uint8Array(bytes));
    },
  });
  const result = await engine.run(testOptions);
  assert.equal(result.download.status, 'completed');
  assert.equal(result.upload.status, 'completed');
  assert.ok(result.download.mbps > 0 && result.upload.mbps > 0);
  assert.deepEqual(result.latency.download, []);
  assert.deepEqual(result.latency.upload, []);
  assert.equal(result.status, 'partial');
  assert.ok(result.errors.includes('download: No completed latency probes during this phase'));
  assert.ok(result.errors.includes('upload: No completed latency probes during this phase'));
});

test('request timeouts are recorded honestly and cannot leave a run active', async () => {
  const engine = new SpeedTestEngine({ ...testConfig, fetchImpl: () => new Promise(() => {}), requestTimeoutMs: 3 });
  const result = await engine.run(testOptions);
  assert.ok(result.latency.idle.every(sample => sample.ms === null && /timed out/.test(sample.error)));
  assert.equal(result.status, 'failed');
  assert.equal(engine.isRunning, false);
});

test('a continuously progressing slow download outlives the inactivity timeout', async () => {
  let timer;
  const engine = new SpeedTestEngine({
    requestTimeoutMs: 80,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        let chunks = 0;
        timer = setInterval(() => {
          controller.enqueue(new Uint8Array(10));
          if (++chunks === 10) { clearInterval(timer); controller.close(); }
        }, 20);
      },
      cancel() { clearInterval(timer); },
    })),
  });
  const sizes = [];
  const received = await engine._request({}, 'download', {
    bytes: 100, signal: new AbortController().signal, onChunk: size => sizes.push(size),
  });
  assert.equal(received, 100, 'all real payload bytes arrive over a 200ms request');
  assert.equal(sizes.reduce((total, size) => total + size, 0), 100);
});

test('a stalled download still times out and cancels its reader after initial progress', async () => {
  let cancelled = false;
  const engine = new SpeedTestEngine({
    requestTimeoutMs: 20,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(10)); },
      cancel() { cancelled = true; },
    })),
  });
  await assert.rejects(engine._request({}, 'download', {
    bytes: 100, signal: new AbortController().signal,
  }), /Request timed out/);
  assert.equal(cancelled, true);
});

test('continuous download progress cannot extend the hard phase deadline', async () => {
  let cancelled = false;
  let timer;
  const engine = new SpeedTestEngine({
    ...testConfig, requestTimeoutMs: 30,
    fetchImpl: async (url, init) => {
      if (init.method === 'POST') return new Response('{}');
      if (Number(new URL(url).searchParams.get('bytes')) === 0) return new Response();
      return new Response(new ReadableStream({
        start(controller) { timer = setInterval(() => controller.enqueue(new Uint8Array(1)), 5); },
        cancel() { clearInterval(timer); cancelled = true; },
      }));
    },
  });
  const result = await engine.run({ ...testOptions, budgetBytes: 1_000 });
  assert.equal(cancelled, true, 'the phase cutoff cancels a stream that still produces bytes');
  assert.equal(engine.isRunning, false);
  assert.ok(result.download.bytes > 0 && result.download.bytes < 100);
  assert.ok(result.download.mbps > 0);
  assert.deepEqual(result.download.errors, []);
});

test('slow upload acknowledgements reduce request size without crediting timed-out bodies', async () => {
  const attempts = [];
  let acknowledged = 0;
  const engine = new SpeedTestEngine({
    ...testConfig, durationScale: 0.1, requestTimeoutMs: 70,
    initialUploadBytes: undefined, maxUploadBytes: 16 * 1024,
    fetchImpl: async (url, init) => {
      if (init.method !== 'POST') {
        await wait(2);
        return new Response(new Uint8Array(Number(new URL(url).searchParams.get('bytes'))));
      }
      const bytes = init.body.byteLength;
      attempts.push(bytes);
      return new Promise((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        // This simulated uplink needs 128ms for 16KiB, but only 32ms for 4KiB.
        const timer = setTimeout(() => {
          init.signal.removeEventListener('abort', abort);
          acknowledged += bytes;
          resolve(new Response('{}'));
        }, bytes / 128);
        init.signal.addEventListener('abort', abort, { once: true });
      });
    },
  });
  const result = await engine.run(testOptions);
  assert.ok(acknowledged > 0, 'the slower link produces actual successful acknowledgements');
  assert.equal(attempts[0], 16 * 1024, 'the initial upload is small enough for mobile uplinks');
  assert.ok(attempts.includes(4 * 1024), 'a timed-out upload retries with a smaller body');
  assert.equal(result.upload.bytes, acknowledged);
  assert.ok(result.upload.mbps > 0);
  assert.equal(result.status, 'partial', 'the timeout remains visible rather than being hidden');
  assert.ok(result.upload.errors.some(error => error.includes('timed out')));
});

test('invalid browser API receivers are not mislabeled as network or CORS failures', async () => {
  const engine = new SpeedTestEngine({ ...testConfig, fetchImpl() {
    throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
  } });
  const result = await engine.run(testOptions);
  assert.equal(result.status, 'failed');
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.every(error => error.includes('Browser API error:')));
  assert.ok(result.errors.every(error => !error.includes('Network/CORS')));
  assert.equal(result.download.bytes, 0);
  assert.equal(result.upload.bytes, 0);
});

test('monitor sends only zero-byte probes and preserves HTTP failures as missing samples', async () => {
  let requests = 0;
  const calls = [];
  const success = goodFetch(calls, 1);
  const engine = new SpeedTestEngine({
    ...testConfig, durationScale: 0.0001,
    fetchImpl: async (url, init) => {
      requests++;
      if (requests === 2) throw new TypeError('temporary outage');
      return success(url, init);
    },
  });
  const result = await engine.monitor({ ...testOptions, monitorMinutes: 5, probeIntervalMs: 3 });
  assert.equal(result.kind, 'monitor');
  assert.equal(result.status, 'partial');
  assert.equal(result.budget.usedBytes, 0);
  assert.ok(result.latency.monitor.some(sample => sample.ms === null));
  assert.ok(result.latency.monitor.some(sample => sample.ms !== null));
  assert.ok(calls.every(call => call.method === 'GET' && call.url.searchParams.get('bytes') === '0'));
  assert.equal(engine.isRunning, false);
});

test('concurrent runs and invalid inputs reject without interrupting a current run', async () => {
  const engine = new SpeedTestEngine({ ...testConfig, fetchImpl: () => new Promise(() => {}), requestTimeoutMs: 10_000 });
  await assert.rejects(engine.run({ streams: 3 }), /streams/);
  await assert.rejects(engine.run({ budgetBytes: Infinity }), /budgetBytes/);
  assert.equal(engine.isRunning, false);
  const first = engine.run(testOptions);
  await assert.rejects(engine.run(testOptions), /already running/);
  await assert.rejects(engine.monitor(testOptions), /already running/);
  engine.stop();
  await first;
  assert.equal(engine.isRunning, false);
});

test('throughput samples report each interval rather than a cumulative average', async () => {
  let engine;
  const engineEvents = [];
  engine = new SpeedTestEngine({
    ...testConfig, initialDownloadBytes: 100, sampleIntervalMs: 5,
    fetchImpl: async (url, init) => {
      if (init.method === 'POST') return new Response('{}');
      const bytes = Number(new URL(url).searchParams.get('bytes'));
      if (!bytes) return new Response(new Uint8Array());
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(20)); },
      }));
    },
    onEvent: event => {
      if (event.type === 'throughput' && event.phase === 'download') {
        engineEvents.push(event);
        if (engineEvents.length === 3) engine.stop();
      }
    },
  });
  await engine.run(testOptions);
  assert.ok(engineEvents[0].mbps > 0);
  assert.equal(engineEvents[1].mbps, 0, 'no bytes in the second interval means zero interval throughput');
});
