import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeLatency, summarizeResult, compareResults, HistoryStore, HISTORY_KEY,
  MAX_HISTORY, MAX_SAMPLES, toCSV,
} from '../src/data.js';

const samples = values => values.map((ms, index) => ({ t: index * 1000, ms }));
const result = (id = 'run-1', overrides = {}) => ({
  id, startedAt: '2026-10-10T00:51:20.123Z', kind: 'speed', label: 'Ethernet', status: 'completed',
  stopReason: '', settings: { streams: 4, duration: 10, budgetBytes: 250_000_000, endpoint: 'https://example.test' },
  download: { mbps: 80, bytes: 100_000_000, status: 'completed', samples: [], errors: [] },
  upload: { mbps: 16, bytes: 20_000_000, status: 'completed', samples: [], errors: [] },
  latency: { idle: samples([20, 10, 30, 10]), download: samples([30, 35, 40]), upload: samples([40, 45, 50]), monitor: [] },
  budget: { usedBytes: 120_000_000, limitBytes: 250_000_000 }, errors: [], durationSeconds: 25,
  ...overrides,
});
const memoryStorage = () => {
  const items = new Map();
  return {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: key => items.delete(key),
  };
};

test('latency uses ordered differences for jitter and sorted values only for quantiles', () => {
  const probes = samples([30, 10, 40, 20]);
  const before = structuredClone(probes);
  const summary = summarizeLatency(probes);
  assert.equal(summary.median, 25);
  assert.equal(summary.p95, 38.5);
  assert.equal(summary.jitter, 70 / 3);
  assert.deepEqual(probes, before);
});

test('failed probes break adjacency and retain an honest HTTP failure fraction', () => {
  const summary = summarizeLatency(samples([10, 20, null, 100, 110, NaN, -1, Infinity]));
  assert.equal(summary.count, 4);
  assert.equal(summary.failed, 4);
  assert.equal(summary.jitter, 10);
  assert.equal(summary.failureRate, 0.5);
  assert.equal(summarizeLatency(samples([10, null, 200])).jitter, null);
  assert.equal(summarizeLatency([{ ms: 10, error: 'network failure' }]).median, null);
  assert.equal(summarizeLatency().failureRate, null);
  assert.equal(summarizeLatency(samples([null, null])).median, null);
  assert.equal(summarizeLatency(samples([0])).median, 0);
});

test('bufferbloat requires idle probes, loaded probes, and real successful transfers in both directions', () => {
  const good = result();
  const summary = summarizeResult(good);
  assert.equal(summary.downloadAdded, 20);
  assert.equal(summary.uploadAdded, 30);
  assert.equal(summary.bufferbloatGrade, 'A');
  for (const change of [{ mbps: null }, { bytes: 0 }, { status: 'failed' }, { status: 'unsupported' }]) {
    const unavailable = summarizeResult({ ...good, upload: { ...good.upload, ...change } });
    assert.equal(unavailable.uploadAdded, null);
    assert.equal(unavailable.bufferbloatGrade, null);
    assert.equal(unavailable.downloadAdded, 20);
  }
  assert.equal(summarizeResult({ ...good, kind: 'monitor' }).bufferbloatGrade, null);
  assert.equal(summarizeResult({ ...good, latency: { ...good.latency, idle: [] } }).downloadAdded, null);
});

test('comparisons preserve missing values, handle zero baselines, and separate run kinds', () => {
  const a = result('a', { latency: { idle: samples([0, 0]), download: [], upload: [] } });
  const b = result('b', { download: { mbps: 100, bytes: 100, status: 'completed' } });
  const rows = compareResults(a, b);
  assert.equal(rows.length, 7);
  assert.equal(rows.find(row => row.metric === 'download').percent, 25);
  assert.equal(rows.find(row => row.metric === 'median').percent, null);
  assert.equal(rows.find(row => row.metric === 'downloadAdded').delta, null);
  assert.deepEqual(compareResults(a, { ...b, kind: 'monitor' }), []);
  const failed = { ...b, download: { mbps: 99, bytes: 0, status: 'failed' } };
  assert.equal(compareResults(a, failed)[0].b, null);
});

test('combined bufferbloat grades require three successful probes in every phase and a non-aborted run', () => {
  const good = result('sufficient', {
    latency: { idle: samples([10, 10, 10]), download: samples([10, 10, 10]), upload: samples([10, 10, 10]), monitor: [] },
  });
  assert.equal(summarizeResult(good).bufferbloatGrade, 'A+');
  for (const phase of ['idle', 'download', 'upload']) {
    for (const insufficient of [[10], [10, 10], [10, null, 10]]) {
      const reduced = { ...good, latency: { ...good.latency, [phase]: samples(insufficient) } };
      const summary = summarizeResult(reduced);
      assert.equal(summary.bufferbloatGrade, null, `${phase}: only successful probes count toward evidence`);
      assert.equal(summary.downloadAdded, 0, 'partial per-direction evidence stays available');
      assert.equal(summary.uploadAdded, 0, 'partial per-direction evidence stays available');
    }
  }
  for (const status of ['cancelled', 'failed']) {
    const summary = summarizeResult({ ...good, status });
    assert.equal(summary.bufferbloatGrade, null, `${status} is not a full load assessment`);
    assert.equal(summary.downloadAdded, 0);
    assert.equal(summary.uploadAdded, 0);
  }
  assert.equal(summarizeResult({ ...good, status: 'budget' }).bufferbloatGrade, 'A+',
    'a budget-limited run can still contain sufficient measured load evidence');
});

test('history reload preserves full UTC dates, settings, measurements and renamed labels', () => {
  const storage = memoryStorage();
  const store = new HistoryStore(storage);
  store.add(result());
  store.rename('run-1', 'Wi-Fi, upstairs');
  const [restored] = new HistoryStore(storage).load();
  assert.equal(restored.startedAt, '2026-10-10T00:51:20.123Z');
  assert.equal(restored.settings.streams, 4);
  assert.equal(restored.label, 'Wi-Fi, upstairs');
  assert.deepEqual(restored.latency.idle, samples([20, 10, 30, 10]));
  assert.equal(JSON.parse(storage.getItem(HISTORY_KEY)).version, 1);
  assert.deepEqual(store.clear(), []);
  assert.deepEqual(new HistoryStore(storage).load(), []);
});

test('history sorts full dates, deduplicates IDs, caps records and samples', () => {
  const storage = memoryStorage();
  const records = Array.from({ length: MAX_HISTORY + 5 }, (_, index) => result(`id-${index}`, {
    startedAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
  }));
  storage.setItem(HISTORY_KEY, JSON.stringify({ version: 1, records }));
  const store = new HistoryStore(storage);
  assert.equal(store.load().length, MAX_HISTORY);
  assert.equal(store.records[0].id, 'id-204');
  store.add(result('latest', { startedAt: '2026-10-11T01:01:00.000Z', latency: { monitor: samples(Array(MAX_SAMPLES + 7).fill(25)) } }));
  assert.equal(store.records[0].latency.monitor.length, MAX_SAMPLES);
  assert.equal(store.records[0].latency.monitor[0].t, 7000);
  store.add(result('latest', { startedAt: '2026-10-11T01:01:00.000Z', label: 'Updated' }));
  assert.equal(store.records.filter(record => record.id === 'latest').length, 1);
  assert.equal(store.records[0].label, 'Updated');
});

test('corrupted, invalid and unknown-version data produce warnings without crashing', () => {
  const storage = memoryStorage();
  for (const bad of ['{broken', '{"version":999,"records":[]}', '{"version":1,"records":{}}']) {
    storage.setItem(HISTORY_KEY, bad);
    const store = new HistoryStore(storage);
    assert.deepEqual(store.load(), []);
    assert.match(store.warning, /could not be read/);
  }
  storage.setItem(HISTORY_KEY, JSON.stringify({ version: 1, records: [null, { id: 'bad' }, result()] }));
  const store = new HistoryStore(storage);
  assert.equal(store.load().length, 1);
  assert.match(store.warning, /invalid/);
});

test('quota and security failures preserve in-session results and expose a warning', () => {
  const storage = memoryStorage();
  storage.setItem(HISTORY_KEY, JSON.stringify({ version: 1, records: [result('old')] }));
  const broken = { getItem: storage.getItem, setItem() { throw new Error('QuotaExceededError'); } };
  const store = new HistoryStore(broken);
  store.add(result('new', { startedAt: '2026-10-11T00:00:00.000Z' }));
  assert.equal(store.records.length, 2);
  assert.match(store.warning, /could not be saved/);
  assert.equal(store.load().length, 2, 'reload must not erase results held only in memory');
  const blocked = new HistoryStore({ getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } });
  assert.equal(blocked.add(result()).length, 1);
  assert.ok(blocked.warning);
  const unavailable = new HistoryStore(null);
  assert.equal(unavailable.add(result()).length, 1);
  assert.match(unavailable.warning, /unavailable/);
});

test('CSV quotes text, neutralizes formula labels, preserves dates and leaves unsupported values blank', () => {
  const run = result('csv', {
    label: '=HYPERLINK("https://example.test","click")',
    upload: { mbps: null, bytes: 0, status: 'unsupported', samples: [], errors: ['CORS failed'] },
  });
  const csv = toCSV([run]);
  assert.ok(csv.includes('"\'=HYPERLINK(""https://example.test"",""click"")"'));
  assert.ok(csv.includes('"2026-10-10T00:51:20.123Z"'));
  assert.ok(csv.includes(',"100000000",,"unsupported","0",'));
  assert.ok(!csv.includes('NaN') && !csv.includes('Infinity') && !csv.includes('undefined'));
  for (const label of [' +SUM(1,1)', '\t=2+2', '-cmd', '@SUM(A1)', '\r\n=2+2']) {
    assert.ok(toCSV([result('csv', { label })]).includes('"\''), label);
  }
});
