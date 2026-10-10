// A real Window.fetch regression test with no npm/browser-driver dependency.
// Desktop Chrome fixture responses exercise browser APIs, not Internet speed
// or physical Android/Brave/WebView compatibility. No user-agent spoofing.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = process.env.CHROME_BIN
  ? [process.env.CHROME_BIN]
  : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
const chrome = candidates.find(binary => spawnSync(binary, ['--version'], { stdio: 'ignore' }).status === 0);
assert.ok(chrome, 'Chrome/Chromium is required for browser smoke tests. Set CHROME_BIN to its executable.');

const [engineSource, standalone, packageText] = await Promise.all([
  readFile(join(root, 'src/engine.js'), 'utf8'),
  readFile(join(root, 'dist/Velocity.html'), 'utf8'),
  readFile(join(root, 'package.json'), 'utf8'),
]);
const expectedVersion = JSON.parse(packageText).version;
let report;
let origin;
let endpointOrigin;
const endpointCounts = { probes: 0, downloads: 0, uploads: 0 };
const requestOrigins = new Set();
const browserHarness = () => `
  const report = async value => {
    await window.fetch('${origin}/report', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(value)});
  };
  const fail = error => report({ok:false, error:String(error?.stack || error)});
  window.addEventListener('error', event => fail(event.error || event.message));
  window.addEventListener('unhandledrejection', event => fail(event.reason));
  const check = (condition, message) => {if (!condition) throw new Error(message);};
`;
const sourceFixture = () => `<!doctype html><title>Velocity native fetch regression</title>
<script>${browserHarness()}</script>
<script type="module">
  import { SpeedTestEngine } from '/engine.js';
  try {
    for (const [name, engine] of [
      ['default fetch', new SpeedTestEngine()],
      ['explicit native fetch', new SpeedTestEngine({fetchImpl:window.fetch})],
    ]) {
      for (const endpoint of ['${origin}', '${endpointOrigin}']) {
        const get = await engine.fetch(endpoint + '/native-check');
        check(get.ok && await get.text() === 'native fetch works', name + ': GET failed');
        const post = await engine.fetch(endpoint + '/native-check', {method:'POST', body:'upload body'});
        check(post.ok && await post.text() === 'upload body', name + ': POST failed');
      }
    }
    await report({ok:true, checks:8});
  } catch (error) {await fail(error);}
</script>`;

function standaloneFixture({endpoint = origin, protocol = 'http:', narrow = false} = {}) {
  // The sole production-code change in this served fixture is the endpoint
  // origin. Keep the native fetch, default engine, timers and UI untouched.
  const declaration = "const SPEED_ENDPOINT = 'https://speed.cloudflare.com';";
  assert.equal(standalone.split(declaration).length, 2, 'Standalone endpoint declaration changed; update fixture explicitly.');
  return standalone.replace(declaration, `const SPEED_ENDPOINT = '${endpoint}';`)
    .replace('</head>', `<script>${browserHarness()}</script></head>`)
    .replace('</body>', `<script type="module">
      window.addEventListener('load', async () => {
        try {
          const byId = id => document.getElementById(id);
          check(location.protocol === '${protocol}', 'Wrong document protocol: ' + location.protocol);
          const version = byId('appVersion');
          check(version?.dataset.version === '${expectedVersion}', 'Standalone build version does not match package.json');
          check(version.textContent.trim() === 'v${expectedVersion}', 'Visible standalone version is incorrect');
          const versionRect = version.getBoundingClientRect();
          check(versionRect.width > 0 && versionRect.height > 0, 'Version is not visibly rendered');
          if (${narrow}) {
            check(innerWidth <= 620, 'Narrow viewport was not applied: ' + innerWidth);
            check(document.documentElement.scrollWidth <= innerWidth + 1, 'Narrow layout overflows the viewport');
            const startRect = byId('startBtn').getBoundingClientRect();
            check(startRect.width > 0 && startRect.left >= 0 && startRect.right <= innerWidth, 'Start control is outside narrow viewport');
          }
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
          await report({ok:true, status:byId('statusBadge').textContent, version:version.dataset.version, protocol:location.protocol, viewport:innerWidth});
        } catch (error) {await fail(error);}
      }, {once:true});
    </script></body>`);
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const requestHandler = (request, response) => {
  void (async () => {
    const url = new URL(request.url, origin);
    response.setHeader('Cache-Control', 'no-store');
    // Normal CORS permission on this local fixture supports both a different
    // HTTP origin and the opaque Origin: null sent by the file: document.
    // Browser security is left enabled; fetch itself is never intercepted.
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'content-type, cache-control, pragma');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
    } else if (url.pathname === '/report' && request.method === 'POST') {
      const result = JSON.parse((await bodyOf(request)).toString());
      response.end('received');
      report?.(result);
    } else if (url.pathname === '/source') {
      response.setHeader('Content-Type', 'text/html');
      response.end(sourceFixture());
    } else if (url.pathname === '/standalone') {
      response.setHeader('Content-Type', 'text/html');
      response.end(standaloneFixture({endpoint:url.searchParams.has('cross') ? endpointOrigin : origin}));
    } else if (url.pathname === '/engine.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(engineSource);
    } else if (url.pathname === '/native-check') {
      response.end(request.method === 'POST' ? await bodyOf(request) : 'native fetch works');
    } else if (url.pathname === '/__down') {
      const bytes = Number(url.searchParams.get('bytes'));
      assert.ok(Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= 16 * 1024 * 1024);
      endpointCounts[bytes === 0 ? 'probes' : 'downloads']++;
      requestOrigins.add(request.headers.origin ?? 'same-origin');
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
      requestOrigins.add(request.headers.origin ?? 'same-origin');
      const timer = setTimeout(() => response.end(), 250);
      response.once('close', () => clearTimeout(timer));
    } else {
      response.writeHead(404).end();
    }
  })().catch(error => {
    response.destroy(error);
    report?.({ok:false, error:`Fixture server: ${error.stack}`});
  });
};

const server = createServer(requestHandler);
const endpointServer = createServer(requestHandler);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
await new Promise(resolve => endpointServer.listen(0, '127.0.0.1', resolve));
endpointOrigin = `http://127.0.0.1:${endpointServer.address().port}`;
const fixtureDirectory = await mkdtemp(join(tmpdir(), 'velocity-file-fixture-'));

async function runBrowser(label, url, {narrow = false} = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'velocity-browser-'));
  let child;
  let deadline;
  let stderr = '';
  try {
    const result = await new Promise((resolve, reject) => {
      report = resolve;
      deadline = setTimeout(() => reject(new Error(`Browser ${label} timed out.\n${stderr}`)), 45000);
      child = spawn(chrome, [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
        `--window-size=${narrow ? '500,900' : '1280,900'}`,
        `--user-data-dir=${profile}`, url,
      ], {stdio:['ignore', 'ignore', 'pipe']});
      child.stderr.on('data', data => {stderr = (stderr + data).slice(-8000);});
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`Browser exited before reporting (${code ?? signal}).\n${stderr}`)));
    });
    assert.equal(result.ok, true, result.error || `Browser ${label} failed`);
    console.log(`Desktop Chrome smoke passed: ${label}`, result);
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
  await runBrowser('source native fetch: same-origin and cross-origin', `${origin}/source`);
  const fixturePath = join(fixtureDirectory, 'Velocity.html');
  await writeFile(fixturePath, standaloneFixture({endpoint:endpointOrigin, protocol:'file:', narrow:true}));
  for (const [label, url, options] of [
    ['standalone HTTP same-origin', `${origin}/standalone`, {}],
    ['standalone HTTP cross-origin', `${origin}/standalone?cross`, {}],
    ['standalone local file, cross-origin, narrow viewport', pathToFileURL(fixturePath).href, {narrow:true}],
  ]) {
    const before = {...endpointCounts};
    await runBrowser(label, url, options);
    assert.ok(endpointCounts.probes - before.probes >= 8, `${label}: latency requests did not reach the server`);
    assert.ok(endpointCounts.downloads > before.downloads && endpointCounts.uploads > before.uploads, `${label}: transfers did not reach the server`);
  }
  assert.ok(requestOrigins.has(origin), 'HTTP cross-origin fetch was not exercised');
  assert.ok(requestOrigins.has('null'), 'File-origin native fetch was not exercised');
  console.log('Standalone native HTTP requests:', endpointCounts);
} finally {
  for (const activeServer of [server, endpointServer]) activeServer.closeAllConnections();
  await Promise.all([server, endpointServer].map(activeServer => new Promise(resolve => activeServer.close(resolve))));
  await rm(fixtureDirectory, {recursive:true, force:true});
}
