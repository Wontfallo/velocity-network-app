// Injected only by the Android test host after the unmodified page has loaded.
// This harness clicks the real controls. It never replaces native fetch/timers.
(async () => {
  const testCase = window.__velocityTestCase;
  const byId = id => document.getElementById(id);
  const errors = [];
  const completed = [];
  const savedRuns = () => {
    try { return JSON.parse(localStorage.getItem('velocity.history.v1') || '{}').records || []; }
    catch { return []; }
  };
  const measuredPhaseSeconds = result => Object.fromEntries(['download','upload'].map(phase => [
    phase, Math.max(0, ...(result[phase].samples || []).map(sample => Number.isFinite(sample.t) ? sample.t : 0)),
  ]));
  const measurementSummary = result => ({
    label: result.label,
    status: result.status,
    durationSeconds: result.durationSeconds,
    requestedSecondsPerPhase: result.settings.duration,
    requestedBudgetBytes: result.settings.budgetBytes,
    actualTransferredPayloadBytes: result.download.bytes + result.upload.bytes,
    measuredPhaseSeconds: measuredPhaseSeconds(result),
    fullDurationCompleted: result.status === 'completed' && result.download.status === 'completed' && result.upload.status === 'completed',
    budgetLimited: result.status === 'budget',
    budget: result.budget,
    download: {bytes: result.download.bytes, mbps: result.download.mbps, status: result.download.status, errors: result.download.errors},
    upload: {bytes: result.upload.bytes, mbps: result.upload.mbps, status: result.upload.status, errors: result.upload.errors},
    successfulProbes: Object.fromEntries(['idle','download','upload','monitor'].map(phase => [phase, (result.latency[phase] || []).filter(sample => Number.isFinite(sample.ms)).length])),
    errors: result.errors,
  });
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (condition, message, timeout = 45000) => {
    const deadline = performance.now() + timeout;
    while (!condition()) {
      check(performance.now() < deadline, message);
      await pause(100);
    }
  };
  const snapshot = () => ({
    version: byId('appVersion')?.dataset.version,
    protocol: location.protocol,
    userAgent: navigator.userAgent,
    viewport: {width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth},
    status: byId('statusBadge')?.textContent,
    issues: byId('resultIssues')?.textContent,
    values: Object.fromEntries(['downloadValue','uploadValue','pingValue','idleMedian','downloadMedian','uploadMedian'].map(id => [id, byId(id)?.textContent])),
    logs: byId('logContent')?.textContent,
    history: byId('historyBody')?.textContent,
    measurements: savedRuns().map(measurementSummary),
    errors,
    completed,
  });
  window.addEventListener('error', event => errors.push(String(event.error?.stack || event.message)));
  window.addEventListener('unhandledrejection', event => errors.push(String(event.reason?.stack || event.reason)));
  const run = async (label, {mode = 'speed', stopAfterMs = 0} = {}) => {
    byId('mode').value = mode;
    byId('mode').dispatchEvent(new Event('change', {bubbles: true}));
    byId('duration').value = '5';
    byId('streams').value = mode === 'compare' ? '4' : '1';
    byId('budget').value = testCase === 'live-cloudflare-http' ? 'none' : '250';
    byId('budget').dispatchEvent(new Event('change', {bubbles: true}));
    byId('label').value = label;
    byId('startBtn').click();
    await wait(() => byId('startBtn').disabled, 'Start did not begin a measurement', 3000);
    if (stopAfterMs) {
      await pause(stopAfterMs);
      byId('stopBtn').click();
    }
    await wait(() => !byId('startBtn').disabled, 'Run did not restore its controls', mode === 'compare' ? 120000 : 90000);
    check(byId('stopBtn').disabled, 'Stop remained active after measurement');
    check(byId('historyBody').textContent.includes(label), 'Run was not saved to history');
    const status = byId('statusBadge').textContent;
    check(!byId('logContent').textContent.includes('Illegal invocation'), 'Native browser method receiver error');
    if (stopAfterMs) check(status === 'CANCELLED', 'Stopped measurement was not marked cancelled: ' + status);
    else {
      check(testCase === 'fixture-http' ? status === 'COMPLETED' : ['COMPLETED', 'BUDGET'].includes(status), 'Incomplete measurement: ' + status + '. ' + byId('resultIssues').textContent);
      for (const id of ['downloadValue','uploadValue','idleMedian','downloadMedian','uploadMedian']) {
        const value = Number.parseFloat(byId(id).textContent);
        check(Number.isFinite(value) && value >= 0, id + ' has no measurement');
        // Cards round to one decimal; a measured rate below 0.05 Mbps displays
        // 0.0. Verify strictly positive bytes/rate from the saved record below.
      }
      const matching = savedRuns().filter(result => mode === 'compare' ? result.label.startsWith(label + ' · ') : result.label === label);
      check(matching.length === (mode === 'compare' ? 2 : 1), 'Measurement records missing from persisted history');
      for (const result of matching) {
        check((result.errors || []).length === 0, 'Measurement errors: ' + JSON.stringify(result.errors));
        if (testCase === 'live-cloudflare-http') {
          check(result.settings.budgetBytes === null && result.budget.limitBytes === null, 'No-cap choice was not retained in the result');
          check(result.status === 'completed', 'No-cap run did not finish both requested phase durations');
          check(Number.isFinite(result.budget.usedBytes) && result.budget.usedBytes > 0, 'No-cap run did not record its payload usage');
          for (const phase of ['download','upload']) {
            check(measuredPhaseSeconds(result)[phase] >= result.settings.duration - 0.05, phase + ' stopped before the requested duration');
          }
        }
        for (const phase of ['download','upload']) {
          check(result[phase].bytes > 0 && Number.isFinite(result[phase].mbps) && result[phase].mbps > 0, phase + ' has no measured payload');
          check((result[phase].errors || []).length === 0, phase + ' has request errors');
          check(['completed','budget'].includes(result[phase].status), phase + ' did not complete or reach its budget');
        }
        for (const phase of ['idle','download','upload']) {
          const samples = result.latency[phase] || [];
          check(samples.length >= 3 && samples.every(sample => Number.isFinite(sample.ms) && sample.ms >= 0 && !sample.error), phase + ' lacks three successful error-free probes');
        }
        if (result.status === 'completed') check(result.durationSeconds >= 2 * result.settings.duration - 0.02, 'Completed result ended before both requested phase durations');
      }
    }
    completed.push({label, mode, status, values: snapshot().values});
  };
  try {
    await wait(() => document.readyState === 'complete' && byId('appVersion') && byId('startBtn'), 'Application did not render', 10000);
    check(document.documentElement.scrollWidth <= innerWidth + 2, 'Android layout overflows the viewport');
    await run(testCase + ' speed');
    if (testCase === 'fixture-http') {
      await run('Android stop and restart', {stopAfterMs: 500});
      await run('Android stability monitor', {mode: 'monitor', stopAfterMs: 2500});
      await run('Android stream comparison', {mode: 'compare'});
      check(byId('compareA').value && byId('compareB').value && byId('compareA').value !== byId('compareB').value, 'Stream comparison was not selected');
    }
    check(errors.length === 0, 'Browser errors: ' + errors.join('; '));
    const outcome = snapshot();
    outcome.ok = true;
    if (testCase === 'local-file') {
      outcome.observation = outcome.status === 'COMPLETED'
        ? 'Android file-origin run completed both requested phase durations with error-free transfer and latency evidence'
        : 'Android file-origin run produced error-free transfer and latency evidence but reached its payload budget; full duration was not completed';
    }
    VelocityTest.report(JSON.stringify(outcome));
  } catch (error) {
    VelocityTest.report(JSON.stringify({...snapshot(), ok: false, error: String(error.stack || error)}));
  }
})();
