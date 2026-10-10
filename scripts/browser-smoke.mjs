// A real Window.fetch regression test with no npm/browser-driver dependency.
// Fixture responses exercise browser APIs, not Internet connection performance.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = process.env.CHROME_BIN
  ? [process.env.CHROME_BIN]
  : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
const chrome = candidates.find(binary => spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0);
assert.ok(chrome, 'Chrome/Chromium is required for browser smoke tests. Set CHROME_BIN to its executable.');

const [engineSource, standalone] = await Promise.all([
  readFile(join(root, 'src/engine.js'), 'utf8'),
  readFile(join(root, 'dist/Velocity.html'), 'utf8'),
]);
let report;
let origin;
const endpointCounts = { probes: 0, downloads: 0, uploads: 0 };
const browserHarness = `
  const report = async value => {
    await window.fetch('/report', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(value)});
  };
  const fail = error => report({ok:false, error:String(error?.stack || error)});
  window.addEventListener('error', event => fail(event.error || event.message));
  window.addEventListener('unhandledrejection', event => fail(event.reason));
  const check = (condition, message) => {if (!condition) throw new Error(message);};
`;
const sourceFixture = `<!doctype html><title>Velocity native fetch regression</title>
<script>${browserHarness}</script>
<script type="module">
  import { SpeedTestEngine } from '/engine.js';
  try {
    for (const [name, engine] of [
      ['default fetch', new SpeedTestEngine()],
      ['explicit native fetch', new SpeedTestEngine({fetchImpl:window.fetch})],
    ]) {
      const get = await engine.fetch('/native-check');
      check(get.ok && await get.text() === 'native fetch works', name + ': GET failed');
      const post = await engine.fetch('/native-check', {method:'POST', body:'upload body'});
      check(post.ok && await post.text() === 'upload body', name + ': POST failed');
    }
    await report({ok:true, checks:4});
  } catch (error) {await fail(error);}
</script>`;

function standaloneFixture() {
  // The sole production-code change in this served fixture is the endpoint
  // origin. Keep the native fetch, default engine, timers and UI untouched.
  const endpoint = "const SPEED_ENDPOINT = 'https://speed.cloudflare.com';";
  assert.equal(standalone.split(endpoint).length, 2, 'Standalone endpoint declaration changed; update fixture explicitly.');
  return standalone.replace(endpoint, `const SPEED_ENDPOINT = '${origin}';`)
    .replace('</head>', `<script>${browserHarness}</script></head>`)
    .replace('</body>', `<script type="module">
      window.addEventListener('load', async () => {
        try {
          const byId = id => document.getElementById(id);
          check(byId('statusBadge').textContent === 'READY', 'App did not initialize');
          byId('duration').value = '5';
          byId('streams').value = '1';
          byId('budget').value = '250';
          byId('label').value = 'Browser smoke fixture';
          byId('startBtn').click();
          const started = performance.now();
          while (!byId('historyBody').textContent.includes('Browser smoke fixture')) {
            check(performance.now() - started < 25000, 'App did not save a result within 25 seconds');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          check(byId('statusBadge').textContent === 'COMPLETED', byId('resultIssues').textContent || 'Run did not complete');
          for (const id of ['downloadValue','uploadValue','pingValue','idleMedian','downloadMedian','uploadMedian']) {
            const value = Number.parseFloat(byId(id).textContent);
            check(Number.isFinite(value) && value >= 0, id + ' has no measurement');
          }
          check(Number.parseFloat(byId('downloadValue').textContent) > 0, 'No downloaded bytes measured');
          check(Number.parseFloat(byId('uploadValue').textContent) > 0, 'No uploaded bytes measured');
          check(byId('resultIssues').hidden, byId('resultIssues').textContent);
          check(!byId('startBtn').disabled && byId('stopBtn').disabled, 'Controls did not recover');
          check(byId('historyBody').textContent.includes('completed'), 'Completed result missing from history');
          await report({ok:true, status:byId('statusBadge').textContent});
        } catch (error) {await fail(error);}
      }, {once:true});
    </script></body>`);
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url, origin);
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/report' && request.method === 'POST') {
      const result = JSON.parse((await bodyOf(request)).toString());
      response.end('received');
      report?.(result);
    } else if (url.pathname === '/source') {
      response.setHeader('Content-Type', 'text/html');
      response.end(sourceFixture);
    } else if (url.pathname === '/standalone') {
      response.setHeader('Content-Type', 'text/html');
      response.end(standaloneFixture());
    } else if (url.pathname === '/engine.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(engineSource);
    } else if (url.pathname === '/native-check') {
      response.end(request.method === 'POST' ? await bodyOf(request) : 'native fetch works');
    } else if (url.pathname === '/__down') {
      const bytes = Number(url.searchParams.get('bytes'));
      assert.ok(Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= 16 * 1024 * 1024);
      endpointCounts[bytes === 0 ? 'probes' : 'downloads']++;
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', bytes);
      if (!bytes) {response.end(); return;}
      // Pace real loopback response bytes to avoid exhausting the payload budget.
      let remaining = bytes;
      const timer = setInterval(() => {
        const size = Math.min(64 * 1024, remaining);
        response.write(Buffer.alloc(size, 120));
        remaining -= size;
        if (!remaining) {clearInterval(timer); response.end();}
      }, 50);
      response.once('close', () => clearInterval(timer));
    } else if (url.pathname === '/__up' && request.method === 'POST') {
      const body = await bodyOf(request);
      assert.ok(body.length > 0, 'Upload fixture received an empty body');
      endpointCounts.uploads++;
      const timer = setTimeout(() => response.end(), 250);
      response.once('close', () => clearTimeout(timer));
    } else {
      response.writeHead(404).end();
    }
  })().catch(error => {
    response.destroy(error);
    report?.({ok:false, error:`Fixture server: ${error.stack}`});
  });
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;

async function runBrowser(path) {
  const profile = await mkdtemp(join(tmpdir(), 'velocity-browser-'));
  let child;
  let deadline;
  let stderr = '';
  try {
    const result = await new Promise((resolve, reject) => {
      report = resolve;
      deadline = setTimeout(() => reject(new Error(`Browser ${path} timed out.\n${stderr}`)), 45000);
      child = spawn(chrome, [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${profile}`, `${origin}${path}`,
      ], {stdio:['ignore', 'ignore', 'pipe']});
      child.stderr.on('data', data => {stderr = (stderr + data).slice(-8000);});
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`Browser exited before reporting (${code ?? signal}).\n${stderr}`)));
    });
    assert.equal(result.ok, true, result.error || `Browser ${path} failed`);
    console.log(`Browser smoke passed: ${path}`, result);
  } finally {
    clearTimeout(deadline);
    report = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    await rm(profile, {recursive:true, force:true, maxRetries:5, retryDelay:100});
  }
}

try {
  await runBrowser('/source');
  await runBrowser('/standalone');
  assert.ok(endpointCounts.probes >= 8, 'Idle and loaded-latency requests did not reach the server');
  assert.ok(endpointCounts.downloads > 0 && endpointCounts.uploads > 0, 'Transfers did not reach the server');
  console.log('Standalone native HTTP requests:', endpointCounts);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
