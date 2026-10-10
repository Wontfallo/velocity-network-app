/** Pure calculations and defensive, local-only result persistence. */
export const HISTORY_KEY = 'velocity.history.v1';
export const HISTORY_VERSION = 1;
export const MAX_HISTORY = 200;
export const MAX_SAMPLES = 1800;

const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const numberOrNull = value => isNumber(value) && value >= 0 ? value : null;
const text = (value, length = 240) => typeof value === 'string'
  ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, length)
  : '';
const percentile = (sorted, fraction) => {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * (index - lower);
};

/** count counts successful probes; failureRate is a fraction from zero to one.
 * Jitter is the mean absolute change between adjacent successful probes in
 * collection order. Failed probes break adjacency rather than joining gaps.
 */
export function summarizeLatency(samples = []) {
  const values = [];
  const changes = [];
  let failed = 0;
  let previous = null;
  for (const sample of Array.isArray(samples) ? samples : []) {
    const ms = sample?.error ? null : numberOrNull(sample?.ms);
    if (ms === null) {
      failed += 1;
      previous = null;
    } else {
      values.push(ms);
      if (previous !== null) changes.push(Math.abs(ms - previous));
      previous = ms;
    }
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    failed,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted.length ? sorted[0] : null,
    max: sorted.length ? sorted.at(-1) : null,
    jitter: changes.length ? changes.reduce((sum, n) => sum + n, 0) / changes.length : null,
    failureRate: values.length + failed ? failed / (values.length + failed) : null,
  };
}

const hasTransfer = transfer => numberOrNull(transfer?.mbps) !== null
  && transfer.mbps > 0
  && numberOrNull(transfer?.bytes) !== null
  && transfer.bytes > 0
  && !['failed', 'unavailable', 'unsupported', 'skipped', 'pending'].includes(transfer.status);

/** Loaded latency only describes a real transfer. A combined grade needs at
 * least three successful probes in idle and each loaded direction. Cancelled
 * and failed runs cannot receive a combined grade, even with partial evidence.
 * Grade thresholds describe added median HTTP latency, not ICMP latency.
 */
export function summarizeResult(result = {}) {
  const idle = summarizeLatency(result.latency?.idle);
  const downloadLoaded = summarizeLatency(result.latency?.download);
  const uploadLoaded = summarizeLatency(result.latency?.upload);
  const monitor = summarizeLatency(result.latency?.monitor);
  const canMeasure = result.kind === 'speed' && idle.median !== null;
  const downloadAdded = canMeasure && hasTransfer(result.download) && downloadLoaded.median !== null
    ? Math.max(0, downloadLoaded.median - idle.median) : null;
  const uploadAdded = canMeasure && hasTransfer(result.upload) && uploadLoaded.median !== null
    ? Math.max(0, uploadLoaded.median - idle.median) : null;
  const enoughEvidence = idle.count >= 3 && downloadLoaded.count >= 3 && uploadLoaded.count >= 3
    && ['completed', 'partial', 'budget'].includes(result.status);
  const worstAdded = enoughEvidence && downloadAdded !== null && uploadAdded !== null
    ? Math.max(downloadAdded, uploadAdded) : null;
  const bufferbloatGrade = worstAdded === null ? null : worstAdded <= 5 ? 'A+'
    : worstAdded <= 30 ? 'A' : worstAdded <= 60 ? 'B' : worstAdded <= 200 ? 'C' : 'D';
  return { idle, downloadLoaded, uploadLoaded, monitor, downloadAdded, uploadAdded, bufferbloatGrade };
}

/** b is the candidate and a the baseline. Missing values remain null; a zero
 * baseline has no percentage change. Incompatible run kinds return no rows.
 */
export function compareResults(a, b) {
  if (!a || !b || a.kind !== b.kind || !['speed', 'monitor'].includes(a.kind)) return [];
  const left = summarizeResult(a);
  const right = summarizeResult(b);
  const row = (metric, label, av, bv, unit, better) => {
    const aValue = numberOrNull(av);
    const bValue = numberOrNull(bv);
    const delta = aValue === null || bValue === null ? null : bValue - aValue;
    return {
      metric, label, a: aValue, b: bValue, delta,
      percent: delta === null || aValue === 0 ? null : delta / aValue * 100,
      unit, better, compatible: true,
    };
  };
  if (a.kind === 'monitor') {
    return [
      row('median', 'Median latency', left.monitor.median, right.monitor.median, 'ms', 'lower'),
      row('p95', '95th percentile latency', left.monitor.p95, right.monitor.p95, 'ms', 'lower'),
      row('jitter', 'Jitter', left.monitor.jitter, right.monitor.jitter, 'ms', 'lower'),
      row('failureRate', 'Failed HTTP probes', left.monitor.failureRate === null ? null : left.monitor.failureRate * 100,
        right.monitor.failureRate === null ? null : right.monitor.failureRate * 100, '%', 'lower'),
    ];
  }
  return [
    row('download', 'Download', hasTransfer(a.download) ? a.download.mbps : null,
      hasTransfer(b.download) ? b.download.mbps : null, 'Mbps', 'higher'),
    row('upload', 'Upload', hasTransfer(a.upload) ? a.upload.mbps : null,
      hasTransfer(b.upload) ? b.upload.mbps : null, 'Mbps', 'higher'),
    row('median', 'Idle median latency', left.idle.median, right.idle.median, 'ms', 'lower'),
    row('p95', 'Idle 95th percentile', left.idle.p95, right.idle.p95, 'ms', 'lower'),
    row('jitter', 'Idle jitter', left.idle.jitter, right.idle.jitter, 'ms', 'lower'),
    row('downloadAdded', 'Download added latency', left.downloadAdded, right.downloadAdded, 'ms', 'lower'),
    row('uploadAdded', 'Upload added latency', left.uploadAdded, right.uploadAdded, 'ms', 'lower'),
  ];
}

const errorList = errors => (Array.isArray(errors) ? errors : []).slice(-30)
  .map(error => text(typeof error === 'string' ? error : error?.message)).filter(Boolean);

function cleanSamples(samples, valueKey) {
  return (Array.isArray(samples) ? samples : []).slice(-MAX_SAMPLES).map(sample => {
    const clean = { t: numberOrNull(sample?.t), [valueKey]: numberOrNull(sample?.[valueKey]) };
    if (sample?.error) clean.error = text(sample.error) || 'Probe failed';
    return clean;
  });
}

function cleanTransfer(transfer = {}) {
  return {
    mbps: numberOrNull(transfer?.mbps),
    bytes: numberOrNull(transfer?.bytes) ?? 0,
    status: text(transfer?.status, 30) || 'unavailable',
    samples: cleanSamples(transfer?.samples, 'mbps'),
    errors: errorList(transfer?.errors),
  };
}

function cleanResult(result) {
  if (!result || typeof result !== 'object' || !['speed', 'monitor'].includes(result.kind)) return null;
  if (typeof result.id !== 'string' || !result.id.trim()) return null;
  const date = typeof result.startedAt === 'string' ? new Date(result.startedAt) : null;
  if (!date || !Number.isFinite(date.getTime())) return null;
  return {
    id: text(result.id, 128),
    startedAt: date.toISOString(),
    kind: result.kind,
    label: text(result.label, 120).trim(),
    status: ['completed', 'partial', 'failed', 'cancelled', 'budget'].includes(result.status) ? result.status : 'partial',
    stopReason: text(result.stopReason),
    settings: {
      streams: numberOrNull(result.settings?.streams),
      duration: numberOrNull(result.settings?.duration),
      budgetBytes: numberOrNull(result.settings?.budgetBytes),
      monitorMinutes: numberOrNull(result.settings?.monitorMinutes),
      endpoint: text(result.settings?.endpoint, 500),
    },
    download: cleanTransfer(result.download),
    upload: cleanTransfer(result.upload),
    latency: Object.fromEntries(['idle', 'download', 'upload', 'monitor']
      .map(key => [key, cleanSamples(result.latency?.[key], 'ms')])),
    budget: {
      usedBytes: numberOrNull(result.budget?.usedBytes) ?? 0,
      limitBytes: numberOrNull(result.budget?.limitBytes),
    },
    errors: errorList(result.errors),
    durationSeconds: numberOrNull(result.durationSeconds),
  };
}

function cleanRecords(records) {
  const seen = new Set();
  return records.map(cleanResult).filter(Boolean)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .filter(record => {
      if (seen.has(record.id)) return false;
      seen.add(record.id);
      return true;
    }).slice(0, MAX_HISTORY);
}

/** All methods return records, newest first. Storage failures retain an
 * in-memory session copy and set warning rather than hiding failed saves.
 * Data contains plain JSON only; render labels and errors with textContent.
 */
export class HistoryStore {
  constructor(storage) {
    this.warning = null;
    this.records = [];
    this.loaded = false;
    this.persistenceFailed = false;
    try {
      this.storage = storage === undefined ? globalThis.localStorage : storage;
      if (!this.storage || typeof this.storage.getItem !== 'function' || typeof this.storage.setItem !== 'function') {
        this.storage = null;
        this.warning = 'Browser storage is unavailable. History is kept only for this session.';
      }
    } catch {
      this.storage = null;
      this.warning = 'Browser storage access was blocked. History is kept only for this session.';
    }
  }

  load() {
    if (!this.storage || this.persistenceFailed) {
      this.loaded = true;
      return this.records;
    }
    try {
      const raw = this.storage.getItem(HISTORY_KEY);
      if (!raw) {
        this.records = [];
        this.warning = null;
      } else {
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== HISTORY_VERSION || !Array.isArray(parsed.records)) {
          throw new Error('Unrecognized history format');
        }
        this.records = cleanRecords(parsed.records);
        this.warning = this.records.length < Math.min(MAX_HISTORY, parsed.records.length)
          ? 'Some saved history records were invalid or duplicated and were skipped.' : null;
      }
    } catch {
      this.warning = 'Saved history could not be read. Existing session results are still available.';
    }
    this.loaded = true;
    return this.records;
  }

  save() {
    if (!this.storage) return this.records;
    try {
      this.storage.setItem(HISTORY_KEY, JSON.stringify({ version: HISTORY_VERSION, records: this.records }));
      this.warning = null;
      this.persistenceFailed = false;
    } catch {
      this.persistenceFailed = true;
      this.warning = 'History could not be saved; browser storage may be full or blocked. New results are kept only for this session. Export CSV to keep a copy.';
    }
    return this.records;
  }

  add(result) {
    if (!this.loaded) this.load();
    const clean = cleanResult(result);
    if (!clean) {
      this.warning = 'This result could not be saved because its ID, date, or test type is invalid.';
      return this.records;
    }
    this.records = cleanRecords([clean, ...this.records.filter(record => record.id !== clean.id)]);
    return this.save();
  }

  clear() {
    this.records = [];
    this.loaded = true;
    return this.save();
  }

  rename(id, label) {
    if (!this.loaded) this.load();
    this.records = this.records.map(record => record.id === id
      ? { ...record, label: text(label, 120).trim() } : record);
    return this.save();
  }
}

// Quoting alone does not stop spreadsheet formula execution. Prefix text whose
// first non-whitespace character is a formula operator with an apostrophe.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let valueText = typeof value === 'number' ? (isNumber(value) ? String(value) : '') : String(value);
  if (typeof value !== 'number' && (/^[\s\uFEFF]*[=+@-]/u.test(valueText) || /^[\t\r\n]/u.test(valueText))) {
    valueText = `'${valueText}`;
  }
  return `"${valueText.replace(/"/g, '""')}"`;
}

/** One row per run; unavailable/unsupported metrics are empty, never zero. */
export function toCSV(records = []) {
  const headers = [
    'ID', 'Started at (UTC ISO 8601)', 'Label', 'Test type', 'Status', 'Stop reason',
    'Streams', 'Transfer duration (s)', 'Monitor duration (min)', 'Data limit (bytes)', 'Endpoint',
    'Actual duration (s)', 'Data used (bytes)',
    'Download (Mbps)', 'Download status', 'Download bytes', 'Upload (Mbps)', 'Upload status', 'Upload bytes',
    'Idle median (ms)', 'Idle p95 (ms)', 'Idle jitter (ms)', 'Idle successful probes', 'Idle failed probes',
    'Download loaded median (ms)', 'Download loaded p95 (ms)', 'Download added latency (ms)',
    'Upload loaded median (ms)', 'Upload loaded p95 (ms)', 'Upload added latency (ms)', 'Bufferbloat grade',
    'Monitor median (ms)', 'Monitor p95 (ms)', 'Monitor jitter (ms)', 'Monitor minimum (ms)', 'Monitor maximum (ms)',
    'Monitor successful probes', 'Monitor failed probes', 'Monitor failed HTTP probes (%)', 'Errors',
  ];
  const rows = [headers];
  for (const input of Array.isArray(records) ? records : []) {
    const result = cleanResult(input);
    if (!result) continue;
    const summary = summarizeResult(result);
    const isSpeed = result.kind === 'speed';
    const monitor = !isSpeed ? summary.monitor : null;
    rows.push([
      result.id, result.startedAt, result.label, result.kind, result.status, result.stopReason,
      isSpeed ? result.settings.streams : null, isSpeed ? result.settings.duration : null,
      !isSpeed ? result.settings.monitorMinutes : null, result.settings.budgetBytes, result.settings.endpoint,
      result.durationSeconds, result.budget.usedBytes,
      isSpeed && hasTransfer(result.download) ? result.download.mbps : null,
      isSpeed ? result.download.status : null, isSpeed ? result.download.bytes : null,
      isSpeed && hasTransfer(result.upload) ? result.upload.mbps : null,
      isSpeed ? result.upload.status : null, isSpeed ? result.upload.bytes : null,
      isSpeed ? summary.idle.median : null, isSpeed ? summary.idle.p95 : null, isSpeed ? summary.idle.jitter : null,
      isSpeed ? summary.idle.count : null, isSpeed ? summary.idle.failed : null,
      summary.downloadAdded !== null ? summary.downloadLoaded.median : null,
      summary.downloadAdded !== null ? summary.downloadLoaded.p95 : null, summary.downloadAdded,
      summary.uploadAdded !== null ? summary.uploadLoaded.median : null,
      summary.uploadAdded !== null ? summary.uploadLoaded.p95 : null, summary.uploadAdded, summary.bufferbloatGrade,
      monitor?.median, monitor?.p95, monitor?.jitter, monitor?.min, monitor?.max, monitor?.count, monitor?.failed,
      monitor?.failureRate === null || !monitor ? null : monitor.failureRate * 100,
      [...result.errors, ...result.download.errors, ...result.upload.errors].join('; '),
    ]);
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
