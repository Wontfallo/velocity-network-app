// Live desktop Chrome diagnostics, using the exact shipped standalone HTML.
// No endpoint substitution, fetch interception, security bypass, or fake UA.
// Two runs at 50 MB/run reserve at most 100 MB of application payload in total.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'live-diagnostics');
await mkdir(output, {recursive:true});
const artifactPath = join(root, 'dist/Velocity.html');
const html = await readFile(artifactPath);
const artifactSha256 = createHash('sha256').update(html).digest('hex');
const {version} = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const candidates = process.env.CHROME_BIN ? [process.env.CHROME_BIN] : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
const chrome = candidates.find(binary => spawnSync(binary, ['--version'], {stdio:'ignore'}).status === 0);
assert.ok(chrome, 'Chrome/Chromium is required; set CHROME_BIN. Live diagnostics cannot be simulated or skipped.');

// DevTools pipe uses NUL-delimited JSON on descriptors 3/4. No browser driver,
// WebSocket dependency, remote browser service, or debug network port is needed.
class DevTools {
  constructor(child, onEvent) {
    this.child = child;
    this.sequence = 0;
    this.pending = new Map();
    let buffer = '';
    child.stdio[4].setEncoding('utf8');
    child.stdio[4].on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\0')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id) {
          const call = this.pending.get(message.id);
          if (!call) continue;
          this.pending.delete(message.id);
          clearTimeout(call.timer);
          if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`));
          else call.resolve(message.result);
        } else onEvent(message);
      }
    });
    const fail = error => {
      for (const call of this.pending.values()) {clearTimeout(call.timer); call.reject(error);}
      this.pending.clear();
    };
    child.once('error', fail);
    child.once('exit', (code, signal) => fail(new Error(`Chrome exited (${code ?? signal})`)));
    child.stdio[3].on('error', fail);
  }
  send(method, params = {}, sessionId, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {resolve,reject,timer,method});
      this.child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId ? {sessionId} : {})}) + '\0');
    });
  }
}

const server = createServer((request, response) => {
  if (request.url === '/Velocity.html') {
    response.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store'});
    response.end(html);
  } else response.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const httpUrl = `http://127.0.0.1:${server.address().port}/Velocity.html`;

const exerciseApp = expectedVersion => `
(async () => {
  const startedAt = performance.now();
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const byId = id => document.getElementById(id);
  while (document.readyState !== 'complete' || !byId('startBtn') || byId('statusBadge')?.textContent !== 'READY') {
    if (performance.now() - startedAt > 15000) throw new Error('The app did not initialize within 15 seconds');
    await pause(100);
  }
  const actualVersion = byId('appVersion')?.dataset.version;
  if (actualVersion !== ${JSON.stringify(expectedVersion)}) throw new Error('Visible build version differs from package.json: ' + actualVersion);
  byId('duration').value = '5';
  byId('streams').value = '1';
  byId('budget').value = '50';
  byId('label').value = 'Live Cloudflare ' + location.protocol;
  const testStartedAt = performance.now();
  byId('startBtn').click();
  let timedOut = false;
  while (byId('startBtn').disabled) {
    if (performance.now() - testStartedAt > 45000) {
      timedOut = true;
      byId('stopBtn').click();
      await pause(1000);
      break;
    }
    await pause(100);
  }
  let result = null, storageError = null;
  try {result = JSON.parse(localStorage.getItem('velocity.history.v1'))?.records?.[0] ?? null;}
  catch (error) {storageError = String(error);}
  return {
    protocol:location.protocol, version:actualVersion, userAgent:navigator.userAgent,
    timedOut, elapsedMs:performance.now() - testStartedAt, result, storageError,
    display:Object.fromEntries(['statusBadge','statusText','resultIssues','downloadValue','uploadValue','pingValue','bufferGrade','qualityDetail','storageWarning']
      .map(id => [id, byId(id)?.textContent ?? null])),
    controls:{startDisabled:byId('startBtn').disabled, stopDisabled:byId('stopBtn').disabled},
    log:byId('logContent').innerText,
    resources:performance.getEntriesByType('resource').filter(entry => entry.name.startsWith('https://speed.cloudflare.com/'))
      .map(entry => ({url:entry.name,duration:entry.duration,transferSize:entry.transferSize,encodedBodySize:entry.encodedBodySize})),
  };
})()`;

function assess(diagnostic) {
  const problems = [];
  const result = diagnostic.app?.result;
  if (diagnostic.error) problems.push(diagnostic.error);
  if (!result) problems.push('No saved result was available');
  else {
    if (result.settings.endpoint !== 'https://speed.cloudflare.com') problems.push('Unexpected endpoint');
    if (result.budget.usedBytes > 50e6 || result.budget.limitBytes !== 50e6) problems.push('Payload budget was not respected');
    for (const direction of ['download', 'upload']) {
      if (!(result[direction].bytes > 0 && result[direction].mbps > 0)) problems.push(`No valid ${direction} measurement`);
    }
    for (const phase of ['idle', 'download', 'upload']) {
      const valid = result.latency[phase].filter(sample => Number.isFinite(sample.ms)).length;
      if (valid < 3) problems.push(`${phase}: only ${valid} successful latency probes (need at least 3)`);
    }
    if (!['completed','budget'].includes(result.status)) problems.push(`Run status: ${result.status}`);
    if (result.errors.length) problems.push(...result.errors);
  }
  if (diagnostic.app?.timedOut) problems.push('App exceeded live diagnostic time limit');
  const truthfulIncomplete = result?.status === 'budget'
    && diagnostic.app.display.resultIssues.includes('Incomplete measurements')
    && diagnostic.app.display.bufferGrade.trim() === '—';
  return {
    ok:problems.length === 0,
    outcome:problems.length === 0 ? 'live measurements verified' : truthfulIncomplete ? 'truthfully reported incomplete budget-limited measurement' : 'live measurement failure',
    problems:[...new Set(problems)],
  };
}

async function run(label, url) {
  const profile = await mkdtemp(join(tmpdir(), 'velocity-live-'));
  const diagnostic = {label, startedAt:new Date().toISOString(), version, artifactSha256, network:[], console:[]};
  const requests = new Map();
  let stderr = '';
  let child;
  let cdp;
  let sessionId;
  let documentCommitted = false;
  let pageLoaded;
  try {
    child = spawn(chrome, [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check', '--remote-debugging-pipe',
      '--window-size=1280,1000', `--user-data-dir=${profile}`, 'about:blank',
    ], {stdio:['ignore','ignore','pipe','pipe','pipe']});
    child.stderr.on('data', chunk => {stderr = (stderr + chunk).slice(-16000);});
    cdp = new DevTools(child, message => {
      if (message.sessionId !== sessionId) return;
      const event = message.params;
      if (message.method === 'Page.frameNavigated' && !event.frame.parentId && event.frame.url === url) {
        documentCommitted = true;
      } else if (message.method === 'Page.loadEventFired' && documentCommitted) {
        pageLoaded?.();
      } else if (message.method === 'Network.requestWillBeSent' && event.request.url.startsWith('https://speed.cloudflare.com/')) {
        const item = {id:event.requestId,url:event.request.url,method:event.request.method,start:event.timestamp,origin:event.request.headers.Origin ?? event.request.headers.origin ?? null};
        requests.set(event.requestId, item);
        diagnostic.network.push(item);
      } else if (message.method === 'Network.responseReceived' && requests.has(event.requestId)) {
        const item = requests.get(event.requestId);
        const response = event.response;
        Object.assign(item, {status:response.status,protocol:response.protocol,mimeType:response.mimeType,timing:response.timing});
        item.headers = Object.fromEntries(Object.entries(response.headers).filter(([key]) => /^(access-control-|content-type$|content-encoding$|content-length$|cf-ray$|server$)/i.test(key)));
      } else if (message.method === 'Network.loadingFinished' && requests.has(event.requestId)) {
        Object.assign(requests.get(event.requestId), {end:event.timestamp,encodedDataLength:event.encodedDataLength});
      } else if (message.method === 'Network.loadingFailed' && requests.has(event.requestId)) {
        Object.assign(requests.get(event.requestId), {errorText:event.errorText,canceled:event.canceled,corsErrorStatus:event.corsErrorStatus,blockedReason:event.blockedReason});
      } else if (message.method === 'Runtime.exceptionThrown') {
        diagnostic.console.push({type:'exception',text:event.exceptionDetails.exception?.description ?? event.exceptionDetails.text});
      } else if (message.method === 'Runtime.consoleAPICalled') {
        diagnostic.console.push({type:event.type,text:event.args.map(arg => String(arg.value ?? arg.description ?? arg.type).slice(0,2000)).join(' ')});
      } else if (message.method === 'Log.entryAdded') {
        diagnostic.console.push({type:event.entry.level,text:event.entry.text,url:event.entry.url});
      }
    });
    diagnostic.browser = await cdp.send('Browser.getVersion');
    const {targetId} = await cdp.send('Target.createTarget', {url:'about:blank'});
    ({sessionId} = await cdp.send('Target.attachToTarget', {targetId,flatten:true}));
    for (const domain of ['Page','Runtime','Network','Log']) await cdp.send(`${domain}.enable`, {}, sessionId);
    await cdp.send('Page.bringToFront', {}, sessionId);
    let loadTimer;
    const loaded = new Promise((resolve, reject) => {
      loadTimer = setTimeout(() => reject(new Error('Standalone document did not finish loading')), 20000);
      pageLoaded = () => {clearTimeout(loadTimer); resolve();};
    });
    try {await Promise.all([cdp.send('Page.navigate', {url}, sessionId), loaded]);}
    finally {clearTimeout(loadTimer);}
    const evaluated = await cdp.send('Runtime.evaluate', {expression:exerciseApp(version),awaitPromise:true,returnByValue:true}, sessionId, 65000);
    if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text);
    diagnostic.app = evaluated.result.value;
  } catch (error) {
    diagnostic.error = error.stack ?? String(error);
  } finally {
    if (cdp && sessionId) {
      try {
        const screenshot = await cdp.send('Page.captureScreenshot', {format:'png',captureBeyondViewport:true}, sessionId);
        await writeFile(join(output, `${label}.png`), Buffer.from(screenshot.data, 'base64'));
      } catch (error) {diagnostic.screenshotError = String(error);}
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    diagnostic.stderr = stderr;
    await rm(profile, {recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
  Object.assign(diagnostic, assess(diagnostic));
  await writeFile(join(output, `${label}.json`), JSON.stringify(diagnostic, null, 2));
  console.log(JSON.stringify({label,ok:diagnostic.ok,outcome:diagnostic.outcome,status:diagnostic.app?.result?.status,problems:diagnostic.problems,display:diagnostic.app?.display,cloudflareRequests:diagnostic.network.length},null,2));
  return diagnostic;
}

const results = [];
try {
  results.push(await run('http-live', httpUrl));
  results.push(await run('file-live', pathToFileURL(artifactPath).href));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
const summary = {
  version, artifactSha256, scope:'Desktop Chrome on this runner; actual Cloudflare endpoint; no Android/Brave/WebView claim',
  maximumReservedPayloadBytes:100e6,
  results:results.map(({label,ok,outcome,problems}) => ({label,ok,outcome,problems})),
};
await writeFile(join(output, 'summary.json'), JSON.stringify(summary,null,2));
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Live Cloudflare browser diagnostics\n\nBuild ${version}, SHA-256 \`${artifactSha256}\`. Actual standalone bytes over HTTP and file:, desktop Chrome. No transport mocks. At most 100 MB reserved payload total.\n\n${summary.results.map(result => `- **${result.label}: ${result.outcome}**${result.problems.length ? '\n  ' + result.problems.join('; ') : ''}`).join('\n')}\n\nJSON includes exact app errors, CORS/network events, console and timing data. Screenshots are in the uploaded artifact. Incomplete results do not count as successful live verification.\n`);
}
if (results.some(result => !result.ok)) process.exitCode = 1;
