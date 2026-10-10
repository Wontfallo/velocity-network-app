// Passive native DevTools observations. No fetch wrappers or response mocks.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function observeWebViewNetwork(adb, expectedUrl) {
  const {stdout} = await adb('shell', 'pidof', 'dev.velocity.smoke');
  const pid = stdout.trim().split(/\s+/)[0];
  if (!/^\d+$/.test(pid)) throw new Error('Android WebView process was not found');
  await adb('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`);
  let target;
  const deadline = Date.now() + 15000;
  while (!target && Date.now() < deadline) {
    try {
      const list = await (await fetch('http://127.0.0.1:9222/json')).json();
      target = list.find(item => item.type === 'page' && item.url === expectedUrl && item.webSocketDebuggerUrl);
    } catch { /* WebView's debugging socket can start after the Activity. */ }
    if (!target) await delay(100);
  }
  if (!target) throw new Error('Android WebView DevTools target was not available');
  const socketUrl = new URL(target.webSocketDebuggerUrl);
  socketUrl.hostname = '127.0.0.1';
  const socket = new WebSocket(socketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once: true});
    socket.addEventListener('error', reject, {once: true});
  });
  const pending = new Map();
  const requests = new Map();
  const exceptions = [];
  let sequence = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const callback = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(callback.timeout);
      message.error ? callback.reject(new Error(JSON.stringify(message.error))) : callback.resolve(message.result);
      return;
    }
    const params = message.params;
    if (message.method === 'Network.requestWillBeSent') {
      const url = new URL(params.request.url);
      requests.set(params.requestId, {
        url: url.origin + url.pathname,
        method: params.request.method,
        kind: params.type,
        status: null,
        receivedBytes: 0,
        finished: false,
        failure: null,
      });
    } else if (message.method === 'Network.responseReceived') {
      const request = requests.get(params.requestId);
      if (request) { request.status = params.response.status; request.mimeType = params.response.mimeType; }
    } else if (message.method === 'Network.dataReceived') {
      const request = requests.get(params.requestId);
      if (request) request.receivedBytes += params.dataLength;
    } else if (message.method === 'Network.loadingFinished') {
      const request = requests.get(params.requestId);
      if (request) { request.finished = true; request.encodedBytes = params.encodedDataLength; }
    } else if (message.method === 'Network.loadingFailed') {
      const request = requests.get(params.requestId);
      if (request) request.failure = {error: params.errorText, cors: params.corsErrorStatus || null, cancelled: params.canceled || false};
    } else if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text);
    }
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools ${method} timed out`)); }, 5000);
    pending.set(id, {resolve, reject, timeout});
    socket.send(JSON.stringify({id, method, params}));
  });
  try {
    await command('Network.enable');
    await command('Runtime.enable');
    // The original harness waits for this rendezvous before clicking Start.
    await command('Runtime.evaluate', {expression: 'window.__velocityNetworkObserverReady=true'});
  } catch (error) {
    socket.close();
    await adb('forward', '--remove', 'tcp:9222');
    throw error;
  }
  return {
    async finish() {
      // Allow the last response's loadingFinished event to arrive.
      await delay(250);
      const all = [...requests.values()];
      const uploads = all.filter(request => request.method === 'POST' && /\/(__up|post)$/.test(new URL(request.url).pathname));
      const acknowledged = uploads.filter(request => request.status >= 200 && request.status < 300 && request.finished && !request.failure);
      const failed = uploads.filter(request => request.failure && !request.failure.cancelled);
      socket.close();
      await adb('forward', '--remove', 'tcp:9222');
      return {
        observer: 'Android WebView native Chrome DevTools Protocol; fetch unmodified',
        uploadRequests: uploads.length,
        acknowledgedUploadRequests: acknowledged.length,
        acknowledgedUploadPayloadBytes: acknowledged.length * 512 * 1024,
        failedUploadRequests: failed.length,
        syntheticUploadFallbackTriggered: failed.length > 0,
        exceptions,
        requests: all,
      };
    },
  };
}
