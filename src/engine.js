/*
 * Browser HTTP measurements against Cloudflare's purpose-built speed endpoints.
 * No warm-up is excluded: connection setup and request overhead affect results.
 * Download progress counts response bytes; upload progress counts acknowledged
 * request bodies because Fetch exposes no upload-progress events. The payload
 * budget reserves entire requests before sending, even if they fail or abort.
 * It excludes headers, TLS, retransmissions, and zero-body latency requests.
 */
export const SPEED_ENDPOINT = 'https://speed.cloudflare.com';

class RequestError extends Error {
  constructor(message, code = 'network') {
    super(message);
    this.name = 'RequestError';
    this.code = code;
  }
}

const abortError = signal => new RequestError(
  signal.reason === 'timeout' ? 'Request timed out' : 'Request aborted',
  signal.reason === 'timeout' ? 'timeout' : 'aborted',
);

// Racing the signal also protects cleanup from a stalled stream implementation.
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(abortError(signal)); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

function scope(parentSignal, durationMs) {
  const controller = new AbortController();
  const relay = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) relay();
  else parentSignal.addEventListener('abort', relay, { once: true });
  const timer = Number.isFinite(durationMs)
    ? setTimeout(() => controller.abort('deadline'), Math.max(0, durationMs))
    : null;
  return {
    controller,
    signal: controller.signal,
    close() {
      if (timer !== null) clearTimeout(timer);
      parentSignal.removeEventListener('abort', relay);
      if (!controller.signal.aborted) controller.abort('phase-ended');
    },
  };
}

function delay(ms, signal) {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function transferResult() {
  return { mbps: null, samples: [], bytes: 0, status: 'not-run', errors: [] };
}

function positiveNumber(value, fallback, name) {
  const number = value ?? fallback;
  if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${name} must be a positive finite number`);
  return number;
}

function validateOptions(options, kind) {
  const streams = options.streams ?? 4;
  const duration = options.duration ?? 10;
  const monitorMinutes = options.monitorMinutes ?? 5;
  if (![1, 4, 8].includes(streams)) throw new TypeError('streams must be 1, 4, or 8');
  if (![5, 10, 20].includes(duration)) throw new TypeError('duration must be 5, 10, or 20 seconds');
  if (![5, 15, 30].includes(monitorMinutes)) throw new TypeError('monitorMinutes must be 5, 15, or 30');
  const budgetBytes = positiveNumber(options.budgetBytes, 200 * 1024 * 1024, 'budgetBytes');
  if (!Number.isSafeInteger(budgetBytes)) throw new TypeError('budgetBytes must be a positive safe integer');
  const probeIntervalMs = positiveNumber(options.probeIntervalMs, 1000, 'probeIntervalMs');
  return {
    streams, duration, monitorMinutes, budgetBytes, probeIntervalMs,
    label: String(options.label ?? (kind === 'monitor' ? 'Stability monitor' : 'Speed test')).slice(0, 200),
  };
}

export class SpeedTestEngine {
  constructor({
    onEvent = () => {}, fetchImpl = globalThis.fetch,
    // Timing and chunk-size overrides are dependency injection for deterministic
    // tests, not user-facing test settings.
    now = () => performance.now(), durationScale = 1,
    idleProbeCount = 8, idleProbeGapMs = 150,
    requestTimeoutMs = 6000, latencyTimeoutMs = Math.min(2000, requestTimeoutMs), sampleIntervalMs = 250,
    initialDownloadBytes = 1024 * 1024, initialUploadBytes = 64 * 1024,
    maxDownloadBytes = 16 * 1024 * 1024, maxUploadBytes = 4 * 1024 * 1024,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('Fetch is unavailable in this browser');
    this.onEvent = onEvent;
    // Window.fetch requires its Window receiver. Copying it onto this instance
    // and calling this.fetch(...) otherwise throws "Illegal invocation".
    this.fetch = fetchImpl.bind(globalThis);
    this.now = now;
    this.config = {
      durationScale, idleProbeCount, idleProbeGapMs, requestTimeoutMs, latencyTimeoutMs,
      sampleIntervalMs, initialDownloadBytes, initialUploadBytes,
      maxDownloadBytes, maxUploadBytes,
    };
    this._active = null;
    this._sequence = 0;
  }

  get isRunning() { return this._active !== null; }

  stop(reason = 'user') {
    const context = this._active;
    if (!context || context.controller.signal.aborted) return;
    context.result.stopReason = String(reason);
    context.controller.abort('user');
    this._emit({ type: 'log', phase: context.phase, level: 'info', message: 'Stopping active requests.' });
  }

  _emit(event) {
    // An optional display callback must not leave a measurement running forever.
    try { this.onEvent(event); } catch { /* UI owns its callback errors. */ }
  }

  _start(options, kind) {
    if (this.isRunning) throw new Error('A measurement is already running');
    const settings = validateOptions(options, kind);
    const startedAt = new Date().toISOString();
    const result = {
      id: globalThis.crypto?.randomUUID?.() ?? `velocity-${Date.now()}-${++this._sequence}`,
      startedAt, kind, label: settings.label, status: 'failed', stopReason: null,
      settings: {
        streams: settings.streams, duration: settings.duration,
        budgetBytes: settings.budgetBytes, monitorMinutes: settings.monitorMinutes,
        endpoint: SPEED_ENDPOINT,
      },
      download: transferResult(), upload: transferResult(),
      latency: { idle: [], download: [], upload: [], monitor: [] },
      budget: { usedBytes: 0, limitBytes: settings.budgetBytes },
      errors: [], durationSeconds: 0,
    };
    const context = {
      result, options: settings, controller: new AbortController(),
      started: this.now(), phase: kind === 'monitor' ? 'monitor' : 'idle',
    };
    this._active = context;
    this._emit({ type: 'budget', phase: context.phase, ...result.budget });
    return context;
  }

  _recordError(context, phase, message) {
    if (context.result.errors.length < 100) context.result.errors.push(`${phase}: ${message}`);
    this._emit({ type: 'log', phase, level: 'error', message });
  }

  _phase(context, phase, elapsedSeconds = 0, durationSeconds = 0) {
    context.phase = phase;
    this._emit({
      type: 'phase', phase, elapsedSeconds, durationSeconds,
      progress: durationSeconds > 0 ? Math.min(1, elapsedSeconds / durationSeconds) : 0,
    });
  }

  _finish(context) {
    context.result.durationSeconds = Math.max(0, (this.now() - context.started) / 1000);
    if (context.controller.signal.aborted) context.result.status = 'cancelled';
    if (this._active === context) this._active = null;
    return context.result;
  }

  async run(options = {}) {
    const context = this._start(options, 'speed');
    const { result, controller } = context;
    try {
      this._phase(context, 'idle');
      let consecutiveFailures = 0;
      for (let index = 0; index < this.config.idleProbeCount && !controller.signal.aborted; index++) {
        await this._latency(context, 'idle', controller.signal);
        const latest = result.latency.idle.at(-1);
        consecutiveFailures = latest?.ms === null ? consecutiveFailures + 1 : 0;
        if (consecutiveFailures >= 3) break;
        if (index + 1 < this.config.idleProbeCount) await delay(this.config.idleProbeGapMs, controller.signal);
      }
      // Reserve an independent half for each direction, so a fast download does
      // not consume the entire upload allowance before upload even begins.
      const downloadAllowance = Math.floor(context.options.budgetBytes / 2);
      if (!controller.signal.aborted) await this._transfer(context, 'download', downloadAllowance);
      if (!controller.signal.aborted) await this._transfer(context, 'upload', context.options.budgetBytes - downloadAllowance);
      const phases = [result.download, result.upload];
      const measured = phases.some(phase => phase.mbps !== null);
      const latencyMeasured = result.latency.idle.some(sample => sample.ms !== null);
      if (!measured) result.status = latencyMeasured ? 'partial' : 'failed';
      else if (phases.some(phase => phase.status === 'failed' || phase.status === 'partial')) result.status = 'partial';
      else if (phases.some(phase => phase.status === 'budget')) {
        result.status = 'budget';
        result.stopReason = 'payload budget reached';
      } else if (result.errors.length) result.status = 'partial';
      else result.status = 'completed';
    } catch (error) {
      this._recordError(context, context.phase, `Measurement failed: ${error.message}`);
      result.status = 'failed';
    } finally {
      this._finish(context);
    }
    return result;
  }

  async monitor(options = {}) {
    const context = this._start(options, 'monitor');
    const durationMs = context.options.monitorMinutes * 60_000 * this.config.durationScale;
    const monitorScope = scope(context.controller.signal, durationMs);
    try {
      this._phase(context, 'monitor', 0, durationMs / 1000);
      this._emit({ type: 'log', phase: 'monitor', level: 'info', message: 'Monitoring zero-body HTTP requests while this page remains active.' });
      while (!monitorScope.signal.aborted) {
        const probeStarted = this.now();
        await this._latency(context, 'monitor', monitorScope.signal);
        this._phase(context, 'monitor', (this.now() - context.started) / 1000, durationMs / 1000);
        await delay(Math.max(0, context.options.probeIntervalMs - (this.now() - probeStarted)), monitorScope.signal);
      }
      const samples = context.result.latency.monitor;
      const successful = samples.filter(sample => sample.ms !== null).length;
      context.result.status = !successful ? 'failed' : successful === samples.length ? 'completed' : 'partial';
    } catch (error) {
      this._recordError(context, 'monitor', `Monitor failed: ${error.message}`);
    } finally {
      monitorScope.close();
      this._finish(context);
    }
    return context.result;
  }

  async _request(context, phase, { bytes, body, signal, onChunk = () => {}, timeoutMs = this.config.requestTimeoutMs }) {
    const requestScope = scope(signal);
    const timeout = setTimeout(() => requestScope.controller.abort('timeout'), timeoutMs);
    let reader;
    let fullyRead = false;
    try {
      const upload = body !== undefined;
      const path = upload ? '__up' : `__down?bytes=${bytes}`;
      const separator = upload ? '?' : '&';
      const url = `${SPEED_ENDPOINT}/${path}${separator}velocity=${Date.now()}-${++this._sequence}`;
      const response = await abortable(this.fetch(url, {
        method: upload ? 'POST' : 'GET', body,
        signal: requestScope.signal, mode: 'cors', credentials: 'omit',
        cache: 'no-store', redirect: 'error',
      }), requestScope.signal);
      if (!response.ok || response.type === 'opaque') {
        throw new RequestError(`HTTP ${response.status || 'unreadable response'}`, 'http');
      }
      const encoding = response.headers?.get('content-encoding');
      if (!upload && bytes > 0 && encoding && encoding.toLowerCase() !== 'identity') {
        throw new RequestError(`Compressed download (${encoding}); wire throughput cannot be verified`, 'encoding');
      }
      const contentType = response.headers?.get('content-type') ?? '';
      if (!upload && bytes > 0 && /text\/html|application\/json/i.test(contentType)) {
        throw new RequestError('Unexpected download response content type', 'body');
      }
      let received = 0;
      if (response.body?.getReader) {
        reader = response.body.getReader();
        while (true) {
          const { done, value } = await abortable(reader.read(), requestScope.signal);
          if (done) break;
          received += value.byteLength;
          // Protect latency probes and malformed endpoint responses from becoming
          // unbounded, unbudgeted downloads.
          if (!upload && received > bytes) throw new RequestError('Download exceeded requested payload size', 'body');
          onChunk(value.byteLength);
        }
      } else {
        const buffer = await abortable(response.arrayBuffer(), requestScope.signal);
        received = buffer.byteLength;
        if (!upload && received > bytes) throw new RequestError('Download exceeded requested payload size', 'body');
        onChunk(received);
      }
      fullyRead = true;
      if (!upload && received !== bytes) throw new RequestError(`Incomplete response: expected ${bytes} bytes, received ${received}`, 'body');
      return received;
    } catch (error) {
      if (requestScope.signal.aborted) throw abortError(requestScope.signal);
      if (error instanceof RequestError) throw error;
      if (/illegal invocation|incompatible receiver/i.test(error.message || '')) {
        throw new RequestError(`Browser API error: ${error.message}`, 'browser-api');
      }
      throw new RequestError(`Network/CORS error: ${error.message || 'request failed'}`);
    } finally {
      clearTimeout(timeout);
      if (reader && !fullyRead) {
        // Never wait on a broken reader's cancellation implementation.
        try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* already closed */ }
      }
      if (reader) { try { reader.releaseLock(); } catch { /* pending read aborted */ } }
      requestScope.close();
    }
  }

  async _latency(context, phase, signal) {
    if (signal.aborted) return;
    const started = this.now();
    let sample;
    try {
      await this._request(context, phase, { bytes: 0, signal, timeoutMs: this.config.latencyTimeoutMs });
      if (signal.aborted) return;
      sample = { t: (this.now() - context.started) / 1000, ms: Math.max(0, this.now() - started) };
    } catch (error) {
      if (signal.aborted) return;
      sample = { t: (this.now() - context.started) / 1000, ms: null, error: error.message };
      this._recordError(context, phase, error.message);
    }
    context.result.latency[phase].push(sample);
    this._emit({ type: 'latency', phase, ...sample });
  }

  _reserve(context, phase, requested, allowanceRemaining) {
    const budget = context.result.budget;
    const bytes = Math.max(0, Math.floor(Math.min(requested, allowanceRemaining, budget.limitBytes - budget.usedBytes)));
    if (bytes > 0) {
      budget.usedBytes += bytes;
      this._emit({ type: 'budget', phase, ...budget });
    }
    return bytes;
  }

  _uploadBody(bytes) {
    const body = new Uint8Array(bytes);
    if (globalThis.crypto?.getRandomValues) {
      for (let offset = 0; offset < bytes; offset += 65536) {
        globalThis.crypto.getRandomValues(body.subarray(offset, Math.min(bytes, offset + 65536)));
      }
    } else {
      // Non-secret pseudo-random payload fallback for old browsers; these bytes
      // are traffic only and never substitute for measured observations.
      let state = 0x6d2b79f5;
      for (let index = 0; index < bytes; index++) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
        body[index] = state & 255;
      }
    }
    return body;
  }

  async _transfer(context, phase, allowance) {
    const data = context.result[phase];
    const durationMs = context.options.duration * 1000 * this.config.durationScale;
    const phaseScope = scope(context.controller.signal, durationMs);
    const started = this.now();
    const upload = phase === 'upload';
    let reserved = 0;
    let budgetHit = false;
    let lastBytes = 0;
    let lastSample = started;
    const activeDownloads = new Set();
    this._phase(context, phase, 0, durationMs / 1000);
    const sample = () => {
      const timestamp = this.now();
      const elapsed = timestamp - lastSample;
      if (elapsed < 1) return;
      const mbps = (data.bytes - lastBytes) * 8 / (elapsed * 1000);
      const point = { t: (timestamp - started) / 1000, mbps };
      for (const request of activeDownloads) {
        const intervalBytes = request.bytes - request.sampledBytes;
        if (intervalBytes > 0) request.contributions.push({ point, bytes: intervalBytes, elapsed });
        request.sampledBytes = request.bytes;
      }
      data.samples.push(point);
      this._emit({ type: 'throughput', phase, ...point, bytes: data.bytes, progress: Math.min(1, (timestamp - started) / durationMs) });
      lastSample = timestamp;
      lastBytes = data.bytes;
    };
    const ticker = setInterval(sample, this.config.sampleIntervalMs);
    const probeLoop = async () => {
      while (!phaseScope.signal.aborted) {
        const probeStarted = this.now();
        await this._latency(context, phase, phaseScope.signal);
        await delay(Math.max(0, context.options.probeIntervalMs - (this.now() - probeStarted)), phaseScope.signal);
      }
    };
    const worker = async () => {
      let chunkSize = upload ? this.config.initialUploadBytes : this.config.initialDownloadBytes;
      let failures = 0;
      while (!phaseScope.signal.aborted && this.now() - started < durationMs) {
        const bytes = this._reserve(context, phase, chunkSize, allowance - reserved);
        if (!bytes) { budgetHit = true; return; }
        reserved += bytes;
        const requestStarted = this.now();
        const received = { bytes: 0, sampledBytes: 0, contributions: [] };
        if (!upload) activeDownloads.add(received);
        try {
          await this._request(context, phase, {
            bytes, body: upload ? this._uploadBody(bytes) : undefined,
            signal: phaseScope.signal,
            onChunk: size => {
              if (!upload) { data.bytes += size; received.bytes += size; }
            },
          });
          if (upload) data.bytes += bytes;
          failures = 0;
          const elapsed = Math.max(1, this.now() - requestStarted);
          const maxChunk = upload ? this.config.maxUploadBytes : this.config.maxDownloadBytes;
          chunkSize = Math.min(maxChunk, Math.max(64 * 1024, Math.round(bytes * 750 / elapsed)));
        } catch (error) {
          if (phaseScope.signal.aborted) break;
          // A malformed/truncated/failed response is not validated test traffic.
          // Remove its provisional live progress, including its contributions
          // to earlier intervals. Normal phase cutoff keeps genuinely received
          // download bytes; aborted POST requests are never acknowledged.
          if (!upload && received.bytes) {
            data.bytes -= received.bytes;
            lastBytes -= received.sampledBytes;
            for (const contribution of received.contributions) {
              contribution.point.mbps = Math.max(0, contribution.point.mbps - contribution.bytes * 8 / (contribution.elapsed * 1000));
            }
          }
          failures++;
          if (data.errors.length < 50) data.errors.push(error.message);
          this._recordError(context, phase, error.message);
          if (failures >= 3) return;
          await delay(150, phaseScope.signal);
        } finally {
          activeDownloads.delete(received);
        }
      }
    };
    const probes = probeLoop();
    try {
      await Promise.all(Array.from({ length: context.options.streams }, () => worker()));
    } finally {
      clearInterval(ticker);
      sample();
      phaseScope.close();
      await probes;
    }
    const elapsedMs = Math.max(1, this.now() - started);
    data.mbps = data.bytes > 0 ? data.bytes * 8 / (elapsedMs * 1000) : null;
    if (data.bytes === 0) data.samples = [];
    if (context.controller.signal.aborted) data.status = 'cancelled';
    else if (data.bytes === 0) data.status = budgetHit ? 'budget' : 'failed';
    else if (data.errors.length) data.status = 'partial';
    else if (budgetHit) data.status = 'budget';
    else data.status = 'completed';
    if (budgetHit) this._emit({ type: 'log', phase, level: 'info', message: `${phase} payload allowance reached; partial-duration result retained.` });
    this._phase(context, phase, elapsedMs / 1000, durationMs / 1000);
  }
}
