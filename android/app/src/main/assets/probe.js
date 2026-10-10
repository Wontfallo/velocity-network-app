// Injected only by the Android test host after the unmodified page has loaded.
// This harness clicks the real controls. It never replaces native fetch/timers.
(async () => {
  const testCase = window.__velocityTestCase;
  const byId = id => document.getElementById(id);
  const errors = [];
  const completed = [];
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
    byId('budget').value = testCase === 'fixture-http' ? '250' : '50';
    byId('label').value = label;
    byId('startBtn').click();
    await wait(() => byId('startBtn').disabled, 'Start did not begin a measurement', 3000);
    if (stopAfterMs) {
      await pause(stopAfterMs);
      byId('stopBtn').click();
    }
    await wait(() => !byId('startBtn').disabled, 'Run did not restore its controls', mode === 'compare' ? 90000 : 60000);
    check(byId('stopBtn').disabled, 'Stop remained active after measurement');
    check(byId('historyBody').textContent.includes(label), 'Run was not saved to history');
    const status = byId('statusBadge').textContent;
    check(!byId('logContent').textContent.includes('Illegal invocation'), 'Native browser method receiver error');
    if (stopAfterMs) check(status === 'CANCELLED', 'Stopped measurement was not marked cancelled: ' + status);
    else if (testCase !== 'local-file') {
      check(testCase === 'fixture-http' ? status === 'COMPLETED' : ['COMPLETED', 'BUDGET'].includes(status), 'Incomplete measurement: ' + status + '. ' + byId('resultIssues').textContent);
      for (const id of ['downloadValue','uploadValue','idleMedian','downloadMedian','uploadMedian']) {
        const value = Number.parseFloat(byId(id).textContent);
        check(Number.isFinite(value) && value >= 0, id + ' has no measurement');
        if (id.endsWith('Value')) check(value > 0, id + ' is not positive');
      }
    }
    completed.push({label, mode, status, values: snapshot().values});
  };
  try {
    await wait(() => byId('appVersion') && byId('startBtn'), 'Application did not render', 10000);
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
      outcome.observation = ['COMPLETED','BUDGET'].includes(outcome.status)
        ? 'Measurements succeeded from Android file origin'
        : 'Android file origin blocked or could not complete measurements; this is a diagnostic observation, not a passed network run';
    }
    VelocityTest.report(JSON.stringify(outcome));
  } catch (error) {
    VelocityTest.report(JSON.stringify({...snapshot(), ok: false, error: String(error.stack || error)}));
  }
})();
