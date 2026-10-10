// Runs the user's exact original HTML. Native fetch is observed through CDP,
// never wrapped or replaced. Displayed results are not proof of measurement:
// the original contains explicit synthetic latency/upload fallback paths.
(async () => {
  const byId = id => document.getElementById(id);
  const errors = [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const wait = async (condition, message, timeout) => {
    const deadline = performance.now() + timeout;
    while (!condition()) {
      check(performance.now() < deadline, message);
      await pause(100);
    }
  };
  window.addEventListener('error', event => errors.push(String(event.error?.stack || event.message)));
  window.addEventListener('unhandledrejection', event => errors.push(String(event.reason?.stack || event.reason)));
  const snapshot = () => ({
    version: 'original-upload',
    protocol: location.protocol,
    userAgent: navigator.userAgent,
    viewport: {width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth},
    status: byId('telemetryStreamState')?.textContent,
    gaugeStatus: byId('gaugePhaseLabel')?.textContent,
    values: Object.fromEntries(['displayDownload','displayUpload','displayPing','displayJitter','loadedLatencyVal'].map(id => [id, byId(id)?.textContent])),
    logs: byId('telemetryConsole')?.textContent,
    history: byId('historyTableBody')?.textContent,
    errors,
    limitation: 'Original code contains synthetic latency and upload fallback paths. Displayed values must be compared with separately captured native network acknowledgements.',
  });
  try {
    await wait(() => window.__velocityNetworkObserverReady === true, 'Native network observer did not attach', 20000);
    check(byId('startTestBtn'), 'Original application start control missing');
    byId('streamSelector').value = '4';
    byId('startTestBtn').click();
    await wait(() => byId('startTestBtn').disabled, 'Original start button did not begin a run', 3000);
    await wait(() => !byId('startTestBtn').disabled, 'Original run did not return controls within 90 seconds', 90000);
    const result = snapshot();
    result.uiCompleted = result.status === 'COMPLETED';
    result.measurementVerified = false;
    result.ok = result.uiCompleted;
    if (!result.ok) result.error = 'Original UI ended in ' + result.status;
    VelocityTest.report(JSON.stringify(result));
  } catch (error) {
    VelocityTest.report(JSON.stringify({...snapshot(), ok: false, error: String(error.stack || error)}));
  }
})();
