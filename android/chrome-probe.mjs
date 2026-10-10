// Drives installed Android Chrome, not WebView or a desktop mobile user agent.
// Reuses the Android app's assertion harness while leaving native fetch intact.
import {execFile} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const directory = dirname(fileURLToPath(import.meta.url));
const chromePackage = 'com.android.chrome';

async function dismissFirstRun(adb) {
  // Use only observed ordinary UI buttons in this disposable emulator. No
  // command-line file, file-origin override, or disabled browser security.
  try {
    await adb('shell', 'uiautomator', 'dump', '/sdcard/velocity-chrome-ui.xml');
    const {stdout} = await adb('shell', 'cat', '/sdcard/velocity-chrome-ui.xml');
    const labels = /^(Accept &(?:amp;)? continue|Use without an account|Continue without an account|No thanks|Not now|Got it|Skip)$/i;
    for (const node of stdout.matchAll(/<node\b[^>]*>/g)) {
      const attributes = Object.fromEntries([...node[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1],match[2]]));
      if (!labels.test(attributes.text || attributes['content-desc'] || '') || attributes.enabled === 'false') continue;
      const bounds = attributes.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
      if (!bounds) continue;
      const [,left,top,right,bottom] = bounds.map(Number);
      await adb('shell', 'input', 'tap', String(Math.round((left + right) / 2)), String(Math.round((top + bottom) / 2)));
      return attributes.text || attributes['content-desc'];
    }
  } catch { /* UI may be transitioning; the startup deadline remains bounded. */ }
  return null;
}

function connectDevTools(socket, onEvent) {
  const pending = new Map();
  let sequence = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const callback = message.id && pending.get(message.id);
    if (callback) {
      pending.delete(message.id);
      clearTimeout(callback.timer);
      if (message.error) callback.reject(new Error(`${callback.method}: ${message.error.message}`));
      else callback.resolve(message.result);
    } else onEvent(message);
  });
  socket.addEventListener('close', () => {
    for (const callback of pending.values()) {
      clearTimeout(callback.timer);
      callback.reject(new Error('Android Chrome DevTools connection closed'));
    }
    pending.clear();
  });
  return (method, params = {}, timeoutMs = 10000) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {pending.delete(id); reject(new Error(`Android Chrome ${method} timed out`));}, timeoutMs);
    pending.set(id, {resolve,reject,timer,method});
    socket.send(JSON.stringify({id,method,params}));
  });
}

export async function probeAndroidChrome(adb, {
  url = 'http://127.0.0.1:4174/live', expectedVersion, artifactSha256, outputDirectory,
} = {}) {
  const result = {
    case:'android-chrome-http', browser:'Installed Android Chrome', package:chromePackage,
    available:false, ok:false, artifactSha256,
    scope:'Native Android Chrome in the emulator; no claim about Brave or a physical phone',
  };
  let socket;
  let forwarded = false;
  let reportTimer;
  const requests = new Map();
  const requestExtras = new Map();
  const responseExtras = new Map();
  const exceptions = [];
  const consoleErrors = [];
  const firstRunButtons = [];
  try {
    const installed = await adb('shell', 'pm', 'path', chromePackage);
    if (!installed.stdout.trim().startsWith('package:')) {
      result.unavailableReason = 'com.android.chrome is not installed in this emulator; no Chrome test was run';
      return result;
    }
    result.available = true;
    const packageDump = await adb('shell', 'dumpsys', 'package', chromePackage);
    result.packageVersion = packageDump.stdout.match(/versionName=([^\s]+)/)?.[1] ?? 'unknown';
    const properties = (await adb('shell', 'getprop')).stdout;
    const property = name => properties.split('\n').find(line => line.startsWith(`[${name}]: [`))?.slice(name.length + 5).replace(/\]\s*$/, '') ?? 'unknown';
    result.androidApi = property('ro.build.version.sdk');
    result.androidRelease = property('ro.build.version.release');
    result.device = property('ro.product.model');
    await adb('shell', 'am', 'force-stop', chromePackage);
    await adb('shell', 'am', 'start', '-W', '-n', 'com.android.chrome/com.google.android.apps.chrome.Main', '-a', 'android.intent.action.VIEW', '-d', url);
    await adb('forward', 'tcp:9223', 'localabstract:chrome_devtools_remote');
    forwarded = true;
    let target;
    const startupDeadline = Date.now() + 60000;
    let nextUiCheck = 0;
    while (!target && Date.now() < startupDeadline) {
      try {
        const targets = await (await fetch('http://127.0.0.1:9223/json', {signal:AbortSignal.timeout(1500)})).json();
        target = targets.find(item => item.type === 'page' && item.url === url && item.webSocketDebuggerUrl);
      } catch { /* Chrome's native debug socket is unavailable during first-run UI. */ }
      if (!target && Date.now() >= nextUiCheck) {
        const button = await dismissFirstRun(adb);
        if (button) firstRunButtons.push(button);
        nextUiCheck = Date.now() + 1500;
      }
      if (!target) await delay(250);
    }
    if (!target) throw new Error('Installed Android Chrome did not expose the requested page within 60 seconds');
    result.devToolsTarget = {type:target.type,url:target.url,title:target.title};
    const socketUrl = new URL(target.webSocketDebuggerUrl);
    socketUrl.hostname = '127.0.0.1';
    socketUrl.port = '9223';
    socket = new WebSocket(socketUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Android Chrome DevTools socket did not open')), 10000);
      socket.addEventListener('open', () => {clearTimeout(timer); resolve();}, {once:true});
      socket.addEventListener('error', event => {clearTimeout(timer); reject(new Error(`Android Chrome DevTools socket failed: ${event.message || 'connection error'}`));}, {once:true});
    });
    let report;
    const reported = new Promise(resolve => {report = resolve;});
    const command = connectDevTools(socket, message => {
      const params = message.params;
      if (message.method === 'Runtime.bindingCalled' && params.name === '__velocityChromeReport') {
        try {report({payload:JSON.parse(params.payload)});}
        catch (error) {report({error:`Invalid browser report: ${error.message}`});}
      } else if (message.method === 'Network.requestWillBeSent' && params.request.url.startsWith('https://speed.cloudflare.com/')) {
        requests.set(params.requestId, {
          url:params.request.url,method:params.request.method,receivedBytes:0,finished:false,
          ...requestExtras.get(params.requestId), ...responseExtras.get(params.requestId),
        });
      } else if (message.method === 'Network.requestWillBeSentExtraInfo') {
        const extra = {origin:params.headers.Origin ?? params.headers.origin ?? null};
        requestExtras.set(params.requestId, extra);
        if (requests.has(params.requestId)) Object.assign(requests.get(params.requestId), extra);
      } else if (message.method === 'Network.responseReceivedExtraInfo') {
        const extra = {rawHttpStatus:params.statusCode,headers:Object.fromEntries(Object.entries(params.headers).filter(([key]) => /^(access-control-|content-length$|content-type$|server$|cf-ray$)/i.test(key)))};
        responseExtras.set(params.requestId, extra);
        if (requests.has(params.requestId)) Object.assign(requests.get(params.requestId), extra);
      } else if (message.method === 'Network.responseReceived' && requests.has(params.requestId)) {
        Object.assign(requests.get(params.requestId), {status:params.response.status,protocol:params.response.protocol});
      } else if (message.method === 'Network.dataReceived' && requests.has(params.requestId)) {
        requests.get(params.requestId).receivedBytes += params.dataLength;
      } else if (message.method === 'Network.loadingFinished' && requests.has(params.requestId)) {
        Object.assign(requests.get(params.requestId), {finished:true,encodedBytes:params.encodedDataLength});
      } else if (message.method === 'Network.loadingFailed' && requests.has(params.requestId)) {
        requests.get(params.requestId).failure = {error:params.errorText,cors:params.corsErrorStatus ?? null,cancelled:params.canceled || false};
      } else if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text);
      } else if (message.method === 'Log.entryAdded' && params.entry.level === 'error') {
        consoleErrors.push({text:params.entry.text,url:params.entry.url});
      }
    });
    result.devToolsBrowser = await command('Browser.getVersion');
    for (const domain of ['Network','Runtime','Page','Log']) await command(`${domain}.enable`);
    await command('Page.bringToFront');
    await command('Runtime.addBinding', {name:'__velocityChromeReport'});
    // Same assertions as the native WebView host: actual UI, no-cap quick run,
    // positive acknowledged bytes, >=3 probes/phase, 5-second phase completion.
    const harness = await readFile(join(directory, 'app/src/main/assets/probe.js'), 'utf8');
    const injected = await command('Runtime.evaluate', {
      expression:`window.__velocityTestCase='live-cloudflare-http'; window.VelocityTest={report:value=>window.__velocityChromeReport(value)};\n${harness}`,
      awaitPromise:false,
    });
    if (injected.exceptionDetails) throw new Error(injected.exceptionDetails.exception?.description ?? injected.exceptionDetails.text);
    reportTimer = setTimeout(() => report({error:'Actual Android Chrome did not report within 105 seconds'}), 105000);
    const response = await reported;
    clearTimeout(reportTimer);
    if (response.error) throw new Error(response.error);
    Object.assign(result, response.payload);
    await delay(250);
    if (result.version !== expectedVersion) {result.ok = false; result.error = `Expected visible version ${expectedVersion}; got ${result.version}`;}
    if (/\bwv\b/.test(result.userAgent || '') || !/Chrome\//.test(result.userAgent || '')) {
      result.ok = false; result.error = 'Observed user agent does not identify standalone Android Chrome';
    }
    const transportErrors = [...requests.values()].filter(request => request.failure && !request.failure.cancelled);
    const acknowledgedUploads = [...requests.values()].filter(request => request.method === 'POST' && request.finished && request.status >= 200 && request.status < 300 && !request.failure);
    if (transportErrors.length || exceptions.length || !acknowledgedUploads.length) {
      result.ok = false;
      result.error = [result.error, transportErrors.length ? `${transportErrors.length} native transport request(s) failed` : '', exceptions.length ? 'Native browser exception(s)' : '', !acknowledgedUploads.length ? 'No native acknowledged upload response observed' : ''].filter(Boolean).join('; ');
    }
    result.fullDurationVerified = result.ok && result.measurements?.length === 1 && result.measurements[0].fullDurationCompleted === true;
    if (!result.fullDurationVerified) result.ok = false;
  } catch (error) {
    result.ok = false;
    result.error = String(error.stack || error);
  } finally {
    clearTimeout(reportTimer);
    socket?.close();
    if (forwarded) await adb('forward', '--remove', 'tcp:9223').catch(() => {});
    result.firstRunButtons = firstRunButtons;
    result.nativeNetwork = {observer:'Installed Android Chrome native CDP; fetch unmodified',exceptions,consoleErrors,requests:[...requests.values()]};
    if (outputDirectory) {
      await mkdir(outputDirectory, {recursive:true});
      try {
        const screenshot = await execute('adb', ['exec-out','screencap','-p'], {encoding:'buffer',timeout:10000,maxBuffer:8 * 1024 * 1024});
        await writeFile(join(outputDirectory, 'android-chrome-http.png'), screenshot.stdout);
      } catch (error) {result.screenshotError = String(error);}
      await writeFile(join(outputDirectory, 'android-chrome-http.json'), JSON.stringify(result,null,2));
    }
  }
  return result;
}
