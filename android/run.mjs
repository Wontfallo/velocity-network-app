// Starts a real HTTP fixture and drives the Android APK with adb. Native WebView
// security and the page's fetch implementation stay enabled and unmodified.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {observeWebViewNetwork} from './network-observer.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'test-results/android');
await mkdir(output, {recursive: true});
const standalone = await readFile(join(root, 'dist/Velocity.html'), 'utf8');
const original = await readFile(join(root, 'android/baseline/Gemini-original.html'));
const originalHash = createHash('sha256').update(original).digest('hex');
assert.equal(originalHash, '6081a7427a3816a9d2ed655394e0249ba12fa3adbfe0e338488a44a51b85f976', 'Original comparison baseline was modified');
const expectedVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const declaration = "const SPEED_ENDPOINT = 'https://speed.cloudflare.com';";
assert.equal(standalone.split(declaration).length, 2, 'Update Android fixture for changed endpoint declaration');
const fixture = standalone.replace(declaration, "const SPEED_ENDPOINT = 'http://127.0.0.1:4175';");
const counts = {probes: 0, downloads: 0, uploads: 0};
const origins = new Set();
const handler = (request, response) => {
  void (async () => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'content-type, cache-control, pragma');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (request.method === 'OPTIONS') {response.writeHead(204).end(); return;}
    if (url.pathname === '/live' || url.pathname === '/fixture' || url.pathname === '/original') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(url.pathname === '/original' ? original : url.pathname === '/live' ? standalone : fixture);
    } else if (url.pathname === '/__down') {
      const bytes = Number(url.searchParams.get('bytes'));
      assert.ok(Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= 16 * 1024 * 1024);
      counts[bytes ? 'downloads' : 'probes']++;
      origins.add(request.headers.origin || 'same-origin');
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Length', bytes);
      if (!bytes) {response.end(); return;}
      let remaining = bytes;
      const timer = setInterval(() => {
        const size = Math.min(64 * 1024, remaining);
        response.write(Buffer.alloc(size, 120));
        remaining -= size;
        if (!remaining) {clearInterval(timer); response.end();}
      }, 50);
      response.once('close', () => clearInterval(timer));
    } else if (url.pathname === '/__up' && request.method === 'POST') {
      let length = 0;
      for await (const chunk of request) length += chunk.length;
      assert.ok(length > 0);
      counts.uploads++;
      origins.add(request.headers.origin || 'same-origin');
      // Keep the 4-stream comparison below its per-run payload allowance.
      const timer = setTimeout(() => response.end(), 500);
      response.once('close', () => clearTimeout(timer));
    } else response.writeHead(404).end();
  })().catch(error => { console.error(error); response.destroy(error); });
};
const servers = [createServer(handler), createServer(handler)];
const adb = (...args) => execute('adb', args, {timeout: 30000, maxBuffer: 8 * 1024 * 1024});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
try {
  for (const [index, server] of servers.entries()) await new Promise(resolve => server.listen(4174 + index, '127.0.0.1', resolve));
  await adb('reverse', 'tcp:4174', 'tcp:4174');
  await adb('reverse', 'tcp:4175', 'tcp:4175');
  await adb('shell', 'svc', 'power', 'stayon', 'true');
  await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
  await adb('shell', 'wm', 'dismiss-keyguard');
  await adb('install', '-r', join(root, 'android/app/build/outputs/apk/debug/app-debug.apk'));
  for (const [testCase, url] of [
    ['fixture-http', 'http://127.0.0.1:4174/fixture'],
    ['live-cloudflare-http', 'http://127.0.0.1:4174/live'],
    ['local-file', 'file:///android_asset/Velocity.html'],
    ['original-http', 'http://127.0.0.1:4174/original'],
    ['original-local-file', 'file:///android_asset/Gemini-original.html'],
  ]) {
    await adb('shell', 'am', 'force-stop', 'dev.velocity.smoke');
    await adb('shell', 'pm', 'clear', 'dev.velocity.smoke');
    await adb('logcat', '-c');
    await adb('shell', 'am', 'start', '-W', '-n', 'dev.velocity.smoke/.MainActivity', '--es', 'case', testCase, '--es', 'url', url);
    let network;
    let observerError;
    if (testCase.startsWith('original-')) {
      try { network = await observeWebViewNetwork(adb, url); }
      catch (error) { observerError = String(error.stack || error); }
    }
    let result;
    const deadline = Date.now() + (testCase === 'fixture-http' ? 240000 : 120000);
    while (!result && Date.now() < deadline) {
      try {
        const response = await adb('shell', 'run-as', 'dev.velocity.smoke', 'cat', 'files/report.json');
        result = JSON.parse(response.stdout);
      } catch { await delay(500); }
    }
    result ||= {case: testCase, ok: false, error: 'Android harness did not report before timeout'};
    if (testCase.startsWith('original-')) {
      result.originalSha256 = originalHash;
      if (network) result.nativeNetwork = await network.finish();
      if (observerError) { result.ok = false; result.observerError = observerError; }
    } else if (result.version !== expectedVersion) {
      result.ok = false;
      result.error = `Expected version ${expectedVersion}; received ${result.version}. ${result.error || ''}`;
    }
    results.push(result);
    await writeFile(join(output, `${testCase}.json`), JSON.stringify(result, null, 2));
    const screenshot = await execute('adb', ['exec-out', 'screencap', '-p'], {encoding: 'buffer', timeout: 10000, maxBuffer: 8 * 1024 * 1024});
    await writeFile(join(output, `${testCase}.png`), screenshot.stdout);
    const logs = await adb('logcat', '-d', '-v', 'threadtime');
    await writeFile(join(output, `${testCase}.log`), logs.stdout);
    console.log(JSON.stringify(result, null, 2));
  }
  await writeFile(join(output, 'summary.json'), JSON.stringify({results, fixtureRequests: counts, fixtureOrigins: [...origins]}, null, 2));
  assert.ok(counts.probes >= 8 && counts.downloads > 0 && counts.uploads > 0, 'Android native requests did not reach fixture');
  assert.ok(origins.has('http://127.0.0.1:4174'), 'Android cross-origin fixture was not exercised');
  const failed = results.filter(result => !result.ok);
  assert.equal(failed.length, 0, failed.map(result => `${result.case}: ${result.error}`).join('\n'));
} finally {
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
}
