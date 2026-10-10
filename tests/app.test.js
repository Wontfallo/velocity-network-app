import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createDOM, memoryStorage} from './helpers/dom.js';

// Exercise the actual generated app/data modules. Only the engine export is
// replaced for controlled workflow tests; engine.test.js checks real networking
// logic separately. These tests do not emulate layout, CORS, or browser timing.
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(process.execPath, ['scripts/build.mjs'], {cwd:root});
const html = readFileSync(new URL('../dist/Velocity.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
assert.equal(scripts.length, 1, 'Standalone output contains one embedded app script');
assert.match(scripts[0][1], /type=["']module["']/, 'Head script must retain deferred module semantics');

function speedResult(options, index = 1, status = 'completed') {
  const samples = values => values.map((ms, i) => ({t:i + 1, ms}));
  return {
    id:`test-run-${index}`, startedAt:new Date(Date.UTC(2026, 9, 10, 0, index)).toISOString(),
    kind:'speed', label:options.label || '', status, stopReason:status === 'cancelled' ? 'user' : '',
    settings:{...options, endpoint:'https://speed.cloudflare.com'},
    download:{mbps:100 * options.streams, bytes:12500000, status:'completed', samples:[{t:1,mbps:100}], errors:[]},
    upload:{mbps:20 * options.streams, bytes:2500000, status:'completed', samples:[{t:2,mbps:20}], errors:[]},
    latency:{idle:samples([10,12,11]), download:samples([25,22,28]), upload:samples([30,33,29]), monitor:[]},
    budget:{usedBytes:15000000, limitBytes:options.budgetBytes}, errors:[], durationSeconds:25,
  };
}

function boot({storage = memoryStorage(), run, monitor, realEngine = false} = {}) {
  const dom = createDOM(html);
  const calls = [], pending = [], timers = new Map(), blobs = new Map();
  let engine, nextTimer = 0, fetchCount = 0;
  class FakeEngine {
    constructor({onEvent}) { this.onEvent = onEvent; this.stops = []; engine = this; }
    run(options) {
      calls.push({method:'run', options:{...options}});
      const result = run ? run(options, calls.length, this) : speedResult(options, calls.length);
      return Promise.resolve(result);
    }
    monitor(options) {
      calls.push({method:'monitor', options:{...options}});
      return Promise.resolve(monitor ? monitor(options, calls.length, this) : speedResult(options, calls.length));
    }
    stop(reason) { this.stops.push(reason); }
  }
  const globals = {
    document:dom.document, window:dom.window, localStorage:storage, console, Blob, AbortController,
    TextEncoder, TextDecoder, performance, crypto:globalThis.crypto,
    fetch() { fetchCount++; throw new Error('Unexpected fetch from UI contract test'); },
    setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    URL:{createObjectURL(blob) { const url=`blob:test-${blobs.size+1}`; blobs.set(url,blob); return url; }, revokeObjectURL(url) { blobs.delete(url); }},
    __FakeEngine:FakeEngine,
  };
  Object.assign(dom.window, {localStorage:storage, document:dom.document});
  let script = scripts[0][2];
  if (!realEngine) {
    const boundary = '__modules.app = (() => {';
    assert.equal(script.split(boundary).length, 2, 'Known engine/app module boundary');
    script = script.replace(boundary, `__modules.engine.SpeedTestEngine = globalThis.__FakeEngine;\n${boundary}`);
  }
  vm.runInNewContext(script, globals, {filename:'dist/Velocity.html', timeout:3000});
  const element = id => { const el=dom.document.getElementById(id); assert.ok(el, `Element #${id} remains connected`); return el; };
  const saved = () => JSON.parse(storage.getItem('velocity.history.v1') || '{"records":[]}').records;
  const submit = () => { const promise=element('settings').fire('submit'); pending.push(promise); return promise; };
  const assertHealthy = async () => {
    await Promise.all(pending);
    for (const [id, callback] of [...timers]) {
      timers.delete(id);
      try { await callback(); }
      catch (error) { dom.state.errors.push(error); }
    }
    assert.equal(dom.state.errors.length, 0, 'No unexpected event-handler errors');
    assert.equal(element('logContent').children.some(line => line.classList.contains('error')), false,
      'No callback exception silently converted into an app error log');
  };
  return {...dom, element, calls, submit, saved, storage, blobs, timers, assertHealthy,
    get engine() { return engine; }, get fetchCount() { return fetchCount; }};
}

test('built app initializes every DOM binding without auto-fetching; export requires history', async () => {
  const app = boot({realEngine:true});
  const {version} = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(app.element('appVersion').textContent,`v${version}`);
  assert.equal(app.element('appVersion').getAttribute('data-version'),version);
  assert.ok(app.element('logContent').textContent.includes(`Velocity ${version}`));
  assert.equal(app.fetchCount,0);
  assert.equal(app.element('duration').value,'10');
  assert.equal(app.element('streams').value,'4');
  assert.equal(app.element('budget').value,'1000');
  assert.equal(app.element('budgetLimit').textContent,'1000 MB');
  assert.equal(app.element('customBudgetField').hidden,true);
  assert.equal(app.element('customBudget').disabled,true);
  assert.equal(app.element('exportCsv').disabled,true);
  assert.equal(app.element('stopBtn').disabled,true);
  assert.equal(app.element('downloadValue').textContent,'—');
  assert.equal(app.element('gaugeArc').style.strokeDashoffset,'0');
  await app.assertHealthy();
});

test('browser API failure guidance identifies the running build', async () => {
  const app = boot({run:options => {
    const result = speedResult(options, 1, 'failed');
    result.errors = ["idle: Browser API error: Failed to execute 'fetch' on 'Window': Illegal invocation"];
    result.download = {mbps:null,bytes:0,status:'failed',samples:[],errors:[]};
    result.upload = {...result.download};
    result.latency = {idle:[],download:[],upload:[],monitor:[]};
    return result;
  }});
  await app.submit();
  const issues = app.element('resultIssues').textContent;
  assert.ok(issues.includes(app.element('appVersion').getAttribute('data-version')));
  assert.match(issues,/Logs/);
  assert.match(issues,/Illegal invocation/);
  assert.equal(app.element('downloadValue').textContent,'—');
  assert.equal(app.element('uploadValue').textContent,'—');
  await app.assertHealthy();
});

test('unexpected engine exceptions leave a persistent FAILED state and a copyable stack; retry recovers', async () => {
  const app = boot({run:(options,index) => {
    if (index === 1) throw new TypeError('Transport startup failed');
    return speedResult(options,index);
  }});
  await app.submit();
  assert.equal(app.element('statusBadge').textContent,'FAILED');
  assert.equal(app.element('startBtn').disabled,false);
  assert.equal(app.element('stopBtn').disabled,true);
  assert.equal(app.element('resultIssues').hidden,false);
  assert.match(app.element('resultIssues').textContent,/Transport startup failed/);
  assert.equal(app.element('runtimeIssue').hidden,false);
  assert.equal(app.saved().length,0,'An exception does not create a fake measurement');
  await app.element('copyDiagnostics').click();
  assert.equal(app.element('diagnosticFallback').hidden,false);
  assert.equal(app.state.selectedElement,app.element('diagnosticReport'),'File/WebView without Clipboard has a selectable fallback');
  const report=JSON.parse(app.element('diagnosticReport').value);
  assert.equal(report.activeRun,null);
  assert.match(report.lastRun.failure,/TypeError: Transport startup failed/);
  assert.match(report.runtimeErrors[0].detail,/app\.test\.js/,'Original stack is retained');
  assert.equal(report.runtime.version,app.element('appVersion').getAttribute('data-version'));
  await app.submit();
  assert.equal(app.element('statusBadge').textContent,'COMPLETED');
  assert.equal(app.element('runtimeIssue').hidden,true);
  assert.equal(app.saved().length,1);
  assert.equal(app.state.errors.length,0);
});

test('render callback exceptions are reported and stop the active run instead of disappearing', async () => {
  let app;
  app=boot({run:(options,index,engine) => {
    const canvas=app.element('throughputChart');
    const original=canvas.getContext;
    canvas.getContext=()=>{throw new Error('Canvas rendering unavailable');};
    engine.onEvent({type:'throughput',phase:'download',t:1,mbps:100,bytes:12500000,progress:0.2});
    canvas.getContext=original;
    return speedResult(options,index,'cancelled');
  }});
  await app.submit();
  assert.deepEqual(app.engine.stops,['display error']);
  assert.equal(app.element('runtimeIssue').hidden,false);
  assert.match(app.element('runtimeIssue').textContent,/Canvas rendering unavailable/);
  await app.element('copyDiagnostics').click();
  const report=JSON.parse(app.element('diagnosticReport').value);
  assert.match(report.runtimeErrors[0].source,/Rendering throughput \(download\)/);
  assert.equal(report.lastRun.result.status,'cancelled');
  assert.equal(app.element('startBtn').disabled,false);
  assert.equal(app.state.errors.length,0);
});

test('diagnostics distinguish last execution from a viewed saved result and capture global errors', async () => {
  const app=boot();
  await app.submit();await app.submit();
  await app.element('historyBody').children[1].children.at(-1).children[0].click();
  await app.window.fire('unhandledrejection',{reason:new Error('Asynchronous UI failure')});
  await app.element('saveDiagnostics').click();
  const download=app.state.downloads.at(-1);
  assert.match(download.download,/^velocity-diagnostics-.*\.json$/);
  const report=JSON.parse(await app.blobs.get(download.href).text());
  assert.equal(report.lastRun.result.id,'test-run-2');
  assert.equal(report.viewedSavedRun.id,'test-run-1');
  assert.equal(report.runtimeErrors[0].source,'Unhandled promise rejection');
  assert.match(report.runtimeErrors[0].detail,/Asynchronous UI failure/);
  assert.equal(app.element('downloadValue').textContent,'400.0','Collecting errors never overwrites measured readings');
  assert.equal(app.state.errors.length,0);
});

test('compare enforces multi-stream selection, splits budget, saves sequential runs and selects the pair', async () => {
  let releaseFirst;
  const app = boot({run:(options,index) => index===1 ? new Promise(resolve => {releaseFirst=()=>resolve(speedResult(options,index));}) : speedResult(options,index)});
  app.element('budget').value='250';await app.element('budget').fire('change');
  app.element('streams').value='1'; app.element('mode').value='compare';
  await app.element('mode').fire('change');
  assert.equal(app.element('streams').value,'4');
  assert.equal(app.element('streams').querySelector('option[value="1"]').disabled,true);
  app.element('label').value='Office Ethernet';
  const finished=app.submit();
  assert.equal(app.calls.length,1,'Second run waits until first finishes');
  assert.equal(app.element('startBtn').disabled,true);
  assert.equal(app.element('stopBtn').disabled,false);
  releaseFirst(); await finished;
  assert.equal(app.calls.length,2);
  assert.deepEqual(app.calls.map(c=>c.options.streams),[1,4]);
  assert.deepEqual(app.calls.map(c=>c.options.budgetBytes),[125000000,125000000]);
  assert.equal(app.saved().length,2);
  assert.equal(app.element('compareA').value,'test-run-1');
  assert.equal(app.element('compareB').value,'test-run-2');
  assert.ok(app.element('comparisonBody').children.length>=7);
  assert.match(app.element('comparisonBody').textContent,/300\.0%/);
  assert.equal(app.element('stopBtn').disabled,true);
  assert.equal(app.element('exportCsv').disabled,false);
  await app.assertHealthy();
});

test('larger presets and custom decimal MB send real byte limits; invalid custom input never starts requests', async () => {
  const app=boot();
  for(const megabytes of ['50','250','1000','5000','10000']) {
    app.element('budget').value=megabytes;await app.element('budget').fire('change');
    await app.submit();
    assert.equal(app.calls.at(-1).options.budgetBytes,Number(megabytes)*1e6);
  }
  app.element('budget').value='custom';await app.element('budget').fire('change');
  assert.equal(app.element('customBudgetField').hidden,false);
  assert.equal(app.element('customBudget').disabled,false);
  for(const invalid of ['','0','-1','Infinity','1e100']) {
    app.element('customBudget').value=invalid;await app.element('customBudget').fire('input');
    await app.submit();
    assert.equal(app.calls.length,5);
    assert.equal(app.element('budgetError').hidden,false);
    assert.equal(app.element('startBtn').disabled,false);
  }
  app.element('customBudget').value='750.5';await app.element('customBudget').fire('input');
  await app.submit();
  assert.equal(app.calls.at(-1).options.budgetBytes,750500000);
  assert.equal(app.element('budgetError').hidden,true);
  assert.equal(app.saved()[0].settings.budgetBytes,750500000);
  await app.assertHealthy();
});

test('No cap stays null in both comparison runs, persistence, and the live meter', async () => {
  const app=boot({run:(options,index,engine)=>{
    assert.equal(options.budgetBytes,null);
    engine.onEvent({type:'budget',usedBytes:123456789,limitBytes:null});
    assert.equal(app.element('budgetLimit').textContent,'No cap');
    assert.equal(app.element('budgetProgress').hidden,true);
    assert.equal(app.element('budgetProgress').max,1);
    assert.equal(Number(app.element('budgetProgress').value),0);
    assert.equal(app.element('budgetUsed').textContent,'123.5 MB');
    return speedResult(options,index);
  }});
  app.element('budget').value='none';await app.element('budget').fire('change');
  app.element('mode').value='compare';await app.element('mode').fire('change');
  assert.match(app.element('modeHelp').textContent,/selected transfer duration/);
  await app.submit();
  assert.deepEqual(app.calls.map(call=>call.options.budgetBytes),[null,null]);
  assert.equal(app.saved().length,2);
  for(const result of app.saved()) {
    assert.equal(result.settings.budgetBytes,null);
    assert.equal(result.budget.limitBytes,null);
  }
  assert.equal(app.element('budgetLimit').textContent,'No cap');
  assert.equal(app.element('budgetProgress').hidden,true);
  await app.assertHealthy();
});

test('custom budget preferences survive reload and controls remain disabled while running or monitoring', async () => {
  const first=boot();
  first.element('budget').value='custom';await first.element('budget').fire('change');
  first.element('customBudget').value='1750.25';await first.element('customBudget').fire('input');
  let release;
  const app=boot({storage:first.storage,run:(options,index)=>new Promise(resolve=>{release=()=>resolve(speedResult(options,index));})});
  assert.equal(app.element('budget').value,'custom');
  assert.equal(app.element('customBudget').value,'1750.25');
  assert.equal(app.element('customBudgetField').hidden,false);
  const finished=app.submit();
  assert.equal(app.element('customBudget').disabled,true);
  release();await finished;
  assert.equal(app.element('customBudget').disabled,false);
  app.element('mode').value='monitor';await app.element('mode').fire('change');
  assert.equal(app.element('customBudgetField').hidden,true);
  assert.equal(app.element('customBudget').disabled,true);
  app.element('mode').value='speed';await app.element('mode').fire('change');
  app.element('budget').value='none';await app.element('budget').fire('change');
  const reloaded=boot({storage:app.storage});
  assert.equal(reloaded.element('budget').value,'none');
  assert.equal(reloaded.element('budgetLimit').textContent,'No cap');
  assert.equal(reloaded.element('customBudget').value,'1750.25');
  await first.assertHealthy();await app.assertHealthy();await reloaded.assertHealthy();
});

test('blocked preferences storage leaves budget selection and measurements usable', async () => {
  const app=boot({storage:{
    getItem(){throw new Error('Storage blocked');},
    setItem(){throw new Error('Storage blocked');},
    removeItem(){throw new Error('Storage blocked');},
  }});
  assert.equal(app.element('budget').value,'1000');
  app.element('budget').value='none';await app.element('budget').fire('change');
  await app.submit();
  assert.equal(app.calls[0].options.budgetBytes,null);
  assert.equal(app.element('statusBadge').textContent,'COMPLETED');
  assert.equal(app.element('startBtn').disabled,false);
  await app.assertHealthy();
});

test('Stop between comparison runs prevents a second run even if the first resolves completed', async () => {
  let release;
  const app=boot({run:(options,index) => new Promise(resolve => { release=()=>resolve(speedResult(options,index)); })});
  app.element('mode').value='compare'; await app.element('mode').fire('change');
  const finished=app.submit();
  await app.element('stopBtn').click();
  assert.deepEqual(app.engine.stops,['user']);
  release(); await finished;
  assert.equal(app.calls.length,1);
  assert.equal(app.saved().length,1);
  assert.equal(app.element('startBtn').disabled,false);
  await app.assertHealthy();
});

test('monitor with no successes keeps unavailable readings and reports failed HTTP probes', async () => {
  let release;
  const app=boot({monitor:(options,index,engine) => new Promise(resolve => {
    release=()=>{
      engine.onEvent({type:'phase',phase:'monitor'});
      for(let i=0;i<3;i++)engine.onEvent({type:'latency',phase:'monitor',t:i,ms:null,error:'Network request failed'});
      const result=speedResult(options,index,'failed');result.kind='monitor';
      result.download={mbps:null,bytes:0,status:'not-run',samples:[],errors:[]};
      result.upload={...result.download};result.latency={idle:[],download:[],upload:[],monitor:[0,1,2].map(t=>({t,ms:null,error:'Network request failed'}))};
      resolve(result);
    };
  })});
  app.element('mode').value='monitor';await app.element('mode').fire('change');
  assert.equal(app.element('monitorField').hidden,false);assert.equal(app.element('budgetField').hidden,true);
  const finished=app.submit();
  assert.match(app.element('monitorFailures').textContent,/—/,'No probes has an unavailable failure percentage');
  assert.doesNotMatch(app.element('monitorFailures').textContent,/0\.0%/,'No probes does not imply 0% failure');
  release();await finished;
  assert.equal(app.calls[0].method,'monitor');
  assert.equal(app.element('monitorCount').textContent,'0');
  assert.match(app.element('monitorFailures').textContent,/3.*100\.0%/);
  for(const id of ['pingValue','jitterValue','downloadValue','uploadValue'])assert.equal(app.element(id).textContent,'—');
  assert.match(app.element('monitorP95').textContent,/—/);
  assert.match(app.element('resultIssues').textContent,/not a packet-loss measurement/);
  await app.assertHealthy();
});

test('history persists through reload, renders labels as text, resets metrics without erasing history, exports CSV', async () => {
  const label='<img src=x onerror="globalThis.pwned=true"> & VPN';
  const first=boot();first.element('label').value=label;await first.submit();
  assert.equal(first.saved()[0].label,label);
  const app=boot({storage:first.storage});
  assert.equal(app.saved().length,1);
  const row=app.element('historyBody').children[0];
  assert.equal(row.children[1].textContent,label);
  assert.equal(row.children[1].childElementCount,0,'Label is a text node, not parsed HTML');
  await row.children.at(-1).children[0].click();
  assert.equal(app.element('downloadValue').textContent,'400.0');
  await app.element('resetBtn').click();
  assert.equal(app.element('downloadValue').textContent,'—');
  assert.equal(app.saved().length,1);assert.equal(app.element('historyBody').children.length,1);
  assert.equal(app.element('exportCsv').disabled,false);
  await app.element('exportCsv').click();
  assert.equal(app.state.downloads.length,1);
  assert.match(app.state.downloads[0].download,/^velocity-history-.*\.csv$/);
  const csv=await app.blobs.get(app.state.downloads[0].href).text();
  assert.match(csv,/onerror/);assert.match(csv,/Download \(Mbps\)/);
  await first.assertHealthy();await app.assertHealthy();
});

test('background visibility interrupts the active run and cannot launch the second comparison', async () => {
  let release;
  const app=boot({run:(options,index) => new Promise(resolve=>{release=()=>resolve(speedResult(options,index,'cancelled'));})});
  app.element('mode').value='compare';await app.element('mode').fire('change');const finished=app.submit();
  app.document.hidden=true;await app.document.fire('visibilitychange');
  assert.deepEqual(app.engine.stops,['background']);
  release();await finished;
  assert.equal(app.calls.length,1);assert.equal(app.saved()[0].status,'cancelled');
  await app.assertHealthy();
});

test('log controls, Escape, rename, and clear-history event handlers stay connected', async () => {
  const app=boot();
  await app.element('logsToggle').click();assert.equal(app.element('logDrawer').hidden,false);
  await app.document.fire('keydown',{key:'Escape'});assert.equal(app.element('logDrawer').hidden,true);
  await app.element('clearLogs').click();assert.equal(app.element('logContent').childElementCount,0);
  await app.submit();app.window.prompt=()=>'<b>Ethernet</b>';
  await app.element('historyBody').children[0].children.at(-1).children[1].click();
  assert.equal(app.saved()[0].label,'<b>Ethernet</b>');
  assert.equal(app.element('historyBody').children[0].children[1].childElementCount,0);
  await app.element('clearHistory').click();
  assert.equal(app.saved().length,0);assert.equal(app.element('exportCsv').disabled,true);
  await app.assertHealthy();
});
