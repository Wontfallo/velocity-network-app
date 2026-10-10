import { SpeedTestEngine } from './engine.js';
import { HistoryStore, summarizeLatency, summarizeResult, compareResults, toCSV } from './data.js';

const $ = id => document.getElementById(id);
const APP_VERSION = $('appVersion').getAttribute('data-version');
const PREFERENCES_KEY = 'velocity.preferences.v1';
const budgetChoices = new Set(['50','250','1000','5000','10000','custom','none']);
let lastValidCustomBudget = '1000';
const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const set = (id, value) => { $(id).textContent = value; };
const colors = {download:'#29d3df', upload:'#b997ff', idle:'#f6be66', monitor:'#40d8ac'};
const store = new HistoryStore();
let history = store.load();
let busy = false;
let stopRequested = false;
let current = null;
let live = null;
let audible = false;
let audioContext;
let toastTimer;
let phase = 'idle';
const plots = new Map();
const recentLogs = [];
const runtimeErrors = [];
let activeRun = null;
let lastRun = null;

function errorText(error) {
  return String(error?.stack || error?.message || error || 'Unknown error').slice(0, 6000);
}

function runtimeInfo() {
  return {
    version: APP_VERSION,
    protocol: globalThis.location?.protocol || 'unavailable',
    context: window.top ? (window.top === window ? 'top-level' : 'embedded') : 'unavailable',
    secure: typeof globalThis.isSecureContext === 'boolean' ? globalThis.isSecureContext : null,
    browser: globalThis.navigator?.userAgent || 'unavailable',
    visibility: document.hidden ? 'hidden' : 'visible',
    online: typeof globalThis.navigator?.onLine === 'boolean' ? globalThis.navigator.onLine : null,
    fetch: typeof globalThis.fetch,
    xhr: typeof globalThis.XMLHttpRequest,
  };
}

function toast(message) {
  set('toast', message);
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}

function log(message, level = 'info') {
  const timestamp = new Date();
  recentLogs.push({time:timestamp.toISOString(), level, message:String(message).slice(0, 6000)});
  if (recentLogs.length > 300) recentLogs.shift();
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  line.textContent = `${timestamp.toLocaleTimeString()}  ${message}`;
  $('logContent').append(line);
  while ($('logContent').childElementCount > 300) $('logContent').firstChild.remove();
  $('logContent').scrollTop = $('logContent').scrollHeight;
}

function recordRuntimeError(error, source) {
  const detail = {time:new Date().toISOString(), source, detail:errorText(error)};
  runtimeErrors.push(detail);
  if (runtimeErrors.length > 20) runtimeErrors.shift();
  log(`${source}: ${detail.detail}`, 'error');
  set('runtimeIssue', `App error: ${error?.message || String(error)}. Open Logs to copy the diagnostic report.`);
  $('runtimeIssue').hidden = false;
}

function diagnosticsText() {
  const describe = result => result ? {
    id:result.id, startedAt:result.startedAt, kind:result.kind, status:result.status,
    stopReason:result.stopReason, settings:result.settings, durationSeconds:result.durationSeconds,
    download:result.download && {mbps:result.download.mbps,bytes:result.download.bytes,status:result.download.status,errors:result.download.errors},
    upload:result.upload && {mbps:result.upload.mbps,bytes:result.upload.bytes,status:result.upload.status,errors:result.upload.errors},
    latency:Object.fromEntries(Object.entries(result.latency || {}).map(([key, samples]) => [key, summarizeLatency(samples)])),
    budget:result.budget, errors:result.errors,
  } : null;
  return JSON.stringify({
    app:'Velocity', generatedAt:new Date().toISOString(), runtime:runtimeInfo(),
    activeRun, lastRun:lastRun && {...lastRun, result:describe(lastRun.result)},
    viewedSavedRun:current && current.id !== lastRun?.result?.id ? describe(current) : null,
    runtimeErrors, logs:recentLogs,
  }, null, 2);
}

function revealDiagnostics() {
  const report = $('diagnosticReport');
  report.value = diagnosticsText();
  $('diagnosticFallback').hidden = false;
  return report;
}

async function copyDiagnostics() {
  const report = revealDiagnostics();
  try {
    if (typeof globalThis.navigator?.clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable');
    await globalThis.navigator.clipboard.writeText(report.value);
    toast('Diagnostic report copied.');
  } catch {
    report.focus();
    report.select();
    toast('Select and copy the report below.');
  }
}

function downloadText(text, name, type) {
  const url=URL.createObjectURL(new Blob([text],{type}));
  const link=document.createElement('a');link.href=url;link.download=name;
  document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

window.addEventListener('error', event => recordRuntimeError(event.error || event.message, 'Uncaught runtime error'));
window.addEventListener('unhandledrejection', event => recordRuntimeError(event.reason, 'Unhandled promise rejection'));

function tone(done = false) {
  if (!audible) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    audioContext.resume();
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.frequency.value = done ? 660 : 440;
    gain.gain.setValueAtTime(0.025, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.12);
    osc.connect(gain).connect(audioContext.destination);
    osc.start(); osc.stop(audioContext.currentTime + 0.13);
  } catch { /* Audio is optional; measurements never depend on it. */ }
}

// Real sample times are retained. Nulls split a line instead of concealing failures.
function plot(id, series, {unit = 'Mbps', time = 'seconds', p95 = null} = {}) {
  plots.set(id, {series, options:{unit,time,p95}});
  const canvas = $(id);
  const width = Math.max(200, canvas.clientWidth);
  const height = Math.max(100, canvas.clientHeight);
  const scale = window.devicePixelRatio || 1;
  canvas.width = width * scale; canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const points = series.flatMap(s => s.points).filter(p => Number.isFinite(p.x));
  const values = points.filter(p => Number.isFinite(p.y)).map(p => p.y);
  const left = 52, right = width - 16, top = 24, bottom = height - 31;
  const minX = time === 'dates' && points.length ? Math.min(...points.map(p=>p.x)) : 0;
  const maxX = Math.max(minX + (time === 'dates' ? 60000 : 1), ...points.map(p=>p.x));
  const maxY = Math.max(unit === 'ms' ? 20 : 10, ...values, p95 || 0) * 1.15;
  const x = n => left + (n-minX)/(maxX-minX)*(right-left);
  const y = n => bottom - n/maxY*(bottom-top);
  ctx.font = '10px ui-monospace, monospace';
  ctx.lineWidth = 1;
  for (let i=0;i<4;i++) {
    const v = maxY * i/3;
    ctx.strokeStyle = '#223044'; ctx.beginPath(); ctx.moveTo(left,y(v)); ctx.lineTo(right,y(v)); ctx.stroke();
    ctx.fillStyle='#8392a9'; ctx.textAlign='right'; ctx.fillText(v>=100 ? v.toFixed(0) : v.toFixed(1),left-8,y(v)+3);
  }
  ctx.textAlign='left'; ctx.fillStyle='#a8b4c7'; ctx.fillText(unit,left,13);
  for (let i=0;i<3;i++) {
    const v=minX+(maxX-minX)*i/2;
    const label=time==='dates' ? new Date(v).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : `${Math.round(v)}s`;
    ctx.textAlign=i===0?'left':i===2?'right':'center'; ctx.fillText(label,x(v),height-9);
  }
  if (Number.isFinite(p95)) {
    ctx.setLineDash([4,4]); ctx.strokeStyle='#f6be6680'; ctx.beginPath(); ctx.moveTo(left,y(p95));ctx.lineTo(right,y(p95));ctx.stroke();ctx.setLineDash([]);
    ctx.textAlign='right';ctx.fillStyle='#f6be66';ctx.fillText(`p95 ${number(p95)} ms`,right,y(p95)-5);
  }
  series.forEach(s => {
    ctx.strokeStyle=s.color;ctx.fillStyle=s.color;ctx.lineWidth=2;ctx.lineJoin='round';ctx.beginPath();
    let connected=false;
    s.points.forEach(p => {
      if (!Number.isFinite(p.y)) { connected=false; return; }
      if(connected)ctx.lineTo(x(p.x),y(p.y));else ctx.moveTo(x(p.x),y(p.y));
      connected=true;
    });ctx.stroke();
    if (s.points.length<=2 || time==='dates') s.points.forEach(p=>{if(Number.isFinite(p.y)){ctx.beginPath();ctx.arc(x(p.x),y(p.y),3,0,Math.PI*2);ctx.fill();}});
    s.points.filter(p=>p.y===null).forEach(p=>{ctx.strokeStyle='#fb7185';ctx.beginPath();ctx.moveTo(x(p.x)-3,bottom-8);ctx.lineTo(x(p.x)+3,bottom-2);ctx.moveTo(x(p.x)+3,bottom-8);ctx.lineTo(x(p.x)-3,bottom-2);ctx.stroke();});
  });
  if (!points.length) {ctx.fillStyle='#72829a';ctx.textAlign='center';ctx.fillText('Measurements will appear here', (left+right)/2,(top+bottom)/2);}
}

function plotResult(result) {
  plot('throughputChart',['download','upload'].map(key=>({color:colors[key],points:(result?.[key]?.samples||[]).map(p=>({x:p.t,y:p.mbps}))})));
  const latency = result?.latency || {};
  const summary = summarizeLatency(latency.monitor || []);
  plot('latencyChart', ['idle','download','upload','monitor'].map(key=>({color:colors[key],points:(latency[key]||[]).map(p=>({x:p.t,y:p.ms}))})),{unit:'ms',p95:summary.p95});
}

function gauge(value, unit, title, hint) {
  set('gaugeValue',number(value));set('gaugeUnit',unit);set('gaugePhase',title);set('gaugeHint',hint);
  const fraction=Number.isFinite(value) ? Math.min(1, Math.log10(1+value)/Math.log10(unit==='ms'?1001:2501)) : 0;
  $('gaugeArc').style.strokeDashoffset='0';
  $('gaugeArc').style.strokeDasharray=`${fraction*100} 100`;
  $('gaugeArc').style.stroke=colors[phase] || colors.download;
}

function showMonitor(result) {
  const samples=result.latency.monitor;
  const s=summarizeLatency(samples);
  set('monitorCount',String(s.count));set('monitorFailures',`${s.failed} / ${number(Number.isFinite(s.failureRate)?s.failureRate*100:null)}%`);set('monitorP95',`${number(s.p95)} ms`);
  let gaps=0;
  for(let i=1;i<samples.length;i++)if(samples[i].t-samples[i-1].t>3)gaps++;
  set('monitorGaps',String(gaps));
}

function showSummary(result) {
  const s=summarizeResult(result);
  const base=result.kind==='monitor' ? s.monitor : s.idle;
  set('downloadValue',number(result.download?.mbps)); set('uploadValue',number(result.upload?.mbps));
  set('pingValue',number(base.median)); set('jitterValue',number(base.jitter));
  set('downloadHint',result.kind==='monitor'?'Not run in monitor mode':`Phase: ${result.download?.status || 'not run'}`);
  set('uploadHint',result.kind==='monitor'?'Not run in monitor mode':`Phase: ${result.upload?.status || 'not run'}`);
  set('pingHint',`Median · p95 ${number(base.p95)} ms`);set('jitterHint',`${base.count} successes · ${base.failed} failed probes`);
  for(const [prefix,values] of [['idle',s.idle],['download',s.downloadLoaded],['upload',s.uploadLoaded]]) {
    set(`${prefix}Median`,number(values.median));set(`${prefix}P95`,number(values.p95));
  }
  set('downloadAdded',Number.isFinite(s.downloadAdded)?`${s.downloadAdded>=0?'+':''}${number(s.downloadAdded)} ms`:'—');
  set('uploadAdded',Number.isFinite(s.uploadAdded)?`${s.uploadAdded>=0?'+':''}${number(s.uploadAdded)} ms`:'—');
  set('bufferGrade',s.bufferbloatGrade || '—');
  set('qualitySummary',result.kind==='monitor'?'Stability session':s.bufferbloatGrade?`Load response: ${s.bufferbloatGrade}`:'Load assessment unavailable');
  set('qualityDetail',s.bufferbloatGrade?'Grade reflects measured extra HTTP latency during this test’s traffic. Higher bandwidth is not guaranteed.':'Both transfer directions and enough valid latency probes are needed for an assessment.');
  capabilities(result,s);
  $('monitorSummary').hidden=result.kind!=='monitor';
  if(result.kind==='monitor')showMonitor(result);
  setBudget(result.budget);
  const issues=[];
  if(result.status!=='completed')issues.push(`Run status: ${result.status}${result.stopReason?` (${result.stopReason})`:''}. Incomplete measurements are not a full test.`);
  const errors=(result.errors || []).map(error=>typeof error==='string'?error:JSON.stringify(error));
  if(errors.some(error=>/illegal invocation/i.test(error)))issues.push(`Browser API invocation failed. Loaded app: Velocity ${APP_VERSION}. Open Logs and include its build and runtime details when reporting this error.`);
  if(result.kind==='monitor')issues.push('Failed HTTP probes can reflect the endpoint, browser, or network. They are not a packet-loss measurement.');
  issues.push(...errors);
  $('resultIssues').textContent=[...new Set(issues)].slice(0,5).join(' ');
  $('resultIssues').hidden=!issues.length;
}

function capabilities(result,s) {
  const valid=result.kind==='speed'&&result.status==='completed';
  const down=result.download?.mbps, up=result.upload?.mbps;
  set('gamingScore',valid&&Number.isFinite(s.idle.median)&&Number.isFinite(s.idle.jitter)?(s.idle.median<40&&s.idle.jitter<10?'Low idle delay':'Delay may affect play'):'Not assessed');
  set('streamingScore',valid&&Number.isFinite(down)?(down>=25?'4K bandwidth available':down>=8?'HD bandwidth available':'Limited bandwidth'):'Not assessed');
  set('callingScore',valid&&Number.isFinite(up)?(up>=5&&Number.isFinite(s.idle.jitter)&&s.idle.jitter<15?'HD call bandwidth':'Quality may vary'):'Not assessed');
  set('cloudScore',valid&&Number.isFinite(up)?`${number(up/8)} MB/s upload`:'Not assessed');
}

function customBudgetBytes(value) {
  const megabytes=Number(value);
  const bytes=Math.round(megabytes*1e6);
  if(!Number.isFinite(megabytes)||megabytes<=0||!Number.isSafeInteger(bytes)||bytes<=0) {
    throw new RangeError('Enter a positive budget in MB.');
  }
  return bytes;
}

function selectedBudgetBytes() {
  const selection=$('budget').value;
  if(selection==='none')return null;
  return customBudgetBytes(selection==='custom'?$('customBudget').value:selection);
}

function restoreBudgetPreferences() {
  try {
    const preference=JSON.parse(globalThis.localStorage?.getItem(PREFERENCES_KEY) || 'null');
    if(!preference || !budgetChoices.has(preference.budget))return;
    if(preference.customMB!==undefined) {
      customBudgetBytes(preference.customMB);
      lastValidCustomBudget=String(preference.customMB);
      $('customBudget').value=lastValidCustomBudget;
    }
    $('budget').value=preference.budget;
  } catch { /* Blocked or malformed preferences leave the default available. */ }
}

function saveBudgetPreferences() {
  try {customBudgetBytes($('customBudget').value);lastValidCustomBudget=$('customBudget').value;}
  catch { /* Preserve the last valid custom amount while the field is being edited. */ }
  try {
    globalThis.localStorage?.setItem(PREFERENCES_KEY,JSON.stringify({budget:$('budget').value,customMB:lastValidCustomBudget}));
  } catch { /* Preferences are optional; a test never depends on storage. */ }
}

function budgetControls() {
  const custom=$('budget').value==='custom'&&$('mode').value!=='monitor';
  $('customBudgetField').hidden=!custom;
  $('customBudget').disabled=busy||!custom;
  $('customBudget').required=custom;
  $('budgetError').hidden=true;
  $('customBudget').removeAttribute('aria-invalid');
}

function setBudget(budget) {
  const used=Number.isFinite(budget?.usedBytes)?budget.usedBytes:0;
  let limit;
  if(budget&&Object.prototype.hasOwnProperty.call(budget,'limitBytes'))limit=budget.limitBytes;
  else {try {limit=selectedBudgetBytes();} catch {limit=undefined;}}
  set('budgetUsed',`${number(used/1e6)} MB`);set('budgetLimit',limit===null?'No cap':`${number(limit/1e6,0)} MB`);
  const finite=Number.isFinite(limit)&&limit>0;
  $('budgetProgress').hidden=!finite;
  $('budgetProgress').max=finite?limit:1; $('budgetProgress').value=finite?Math.min(used,limit):0;
}

function event(event) {
  if(event.type==='log') {log(event.message,event.level);return;}
  if(event.type==='budget') {setBudget(event);return;}
  if(!live)return;
  if(event.type==='phase') {
    phase=event.phase;
    set('statusText',phase==='monitor'?'Monitoring connection':`Measuring ${phase==='idle'?'idle latency':phase}`);
    const remaining=Number.isFinite(event.durationSeconds)?` · ${Math.max(0,Math.ceil(event.durationSeconds-(event.elapsedSeconds||0)))}s left`:'';
    gauge(null,phase==='idle'||phase==='monitor'?'ms':'Mbps',phase.toUpperCase(),`${live.label || 'Current run'}${remaining}`);
    return;
  }
  if(event.type==='latency') {
    live.latency[event.phase].push({t:event.t,ms:event.ms,error:event.error});
    if(event.phase==='idle'||event.phase==='monitor') {
      const s=summarizeLatency(live.latency[event.phase]);
      set('pingValue',number(s.median));set('jitterValue',number(s.jitter));set('pingHint',`Median · p95 ${number(s.p95)} ms`);
      gauge(event.ms,'ms',event.phase.toUpperCase(),event.ms===null?'Probe failed':`${s.count} successful probes`);
    }
    if(event.phase==='monitor')showMonitor(live);
    plotResult(live);
  }
  if(event.type==='throughput') {
    live[event.phase].samples.push({t:event.t,mbps:event.mbps});
    set(`${event.phase}Value`,number(event.mbps));
    set(`${event.phase}Hint`,'Current interval · final average follows');
    gauge(event.mbps,'Mbps',event.phase.toUpperCase(),`${Math.round((event.progress||0)*100)}% · ${number(event.bytes/1e6)} MB measured`);
    plotResult(live);
  }
}
const engine = new SpeedTestEngine({onEvent:measurement => {
  try { event(measurement); }
  catch (error) {
    recordRuntimeError(error, `Rendering ${measurement.type}${measurement.phase ? ` (${measurement.phase})` : ''}`);
    engine.stop('display error');
  }
}});

function blank(kind='speed',label='') {
  return {kind,label,download:{samples:[]},upload:{samples:[]},latency:{idle:[],download:[],upload:[],monitor:[]}};
}

function controls() {
  const mode=$('mode').value;
  $('monitorField').hidden=mode!=='monitor';
  for(const id of ['durationField','streamsField','budgetField'])if($(id))$(id).hidden=mode==='monitor';
  set('modeHelp',mode==='compare'?`Runs 1 stream, then your selected multiple-stream setting. ${$('budget').value==='none'?'Each run uses the selected transfer duration.':'The total payload budget is shared equally between both runs.'}`:mode==='monitor'?'Lightweight HTTP probes for 5–30 minutes. Keep this tab visible and your device awake.':'Measures idle latency, then download and upload with simultaneous latency probes.');
  set('startBtn',mode==='compare'?'Compare streams':mode==='monitor'?'Start monitoring':'Start speed test');
  if(mode==='compare'&&$('streams').value==='1')$('streams').value='4';
  const single=$('streams').querySelector('option[value="1"]');if(single)single.disabled=mode==='compare';
  budgetControls();
  setBudget(null);
}

function setBusy(value) {
  busy=value;
  $('settings').querySelectorAll('input,select,button[type="submit"]').forEach(el=>el.disabled=value);
  $('stopBtn').disabled=!value;$('resetBtn').disabled=value;$('clearHistory').disabled=value;
  budgetControls();
  set('statusBadge',value?'RUNNING':'READY');
}

async function start(e) {
  e.preventDefault();if(busy)return;
  const mode=$('mode').value;
  let budgetBytes;
  try {
    budgetBytes=mode==='monitor'?null:selectedBudgetBytes();
    if(mode==='compare'&&budgetBytes!==null&&budgetBytes<2)throw new RangeError('Enter at least 0.000002 MB for two comparison runs.');
  }
  catch(error) {
    set('budgetError',error.message);$('budgetError').hidden=false;
    $('customBudget').setAttribute('aria-invalid','true');$('customBudget').focus();return;
  }
  saveBudgetPreferences();
  stopRequested=false;current=null;setBusy(true);tone();
  $('runtimeIssue').hidden = true;
  let executionFailed = false;
  const options={duration:Number($('duration').value),streams:Number($('streams').value),budgetBytes,label:$('label').value.trim(),monitorMinutes:Number($('monitorMinutes').value),probeIntervalMs:mode==='monitor'?1000:400};
  activeRun = {startedAt:new Date().toISOString(),mode,options:{...options}};
  const sequence=mode==='compare'?[1,options.streams]:[options.streams];
  const pair=[];
  if(mode==='compare'&&options.budgetBytes!==null)options.budgetBytes=Math.floor(options.budgetBytes/2);
  try {
    for(const streams of sequence) {
      if(stopRequested)break;
      const label=mode==='compare'?`${options.label || 'Stream comparison'} · ${streams} stream${streams===1?'':'s'}`:options.label;
      live=blank(mode==='monitor'?'monitor':'speed',label);
      clearReadings();$('monitorSummary').hidden=mode!=='monitor';
      if(mode==='monitor')showMonitor(live);
      log(`Starting ${mode==='monitor'?'monitor':`${streams}-stream speed test`}${label?` · ${label}`:''}`);
      const result=await (mode==='monitor'?engine.monitor({...options,label}):engine.run({...options,streams,label}));
      lastRun = {...activeRun, finishedAt:new Date().toISOString(), result};
      current=result;pair.push(result);history=store.add(result);renderHistory();showSummary(result);plotResult(result);
      set('statusBadge',result.status.toUpperCase());set('statusText',`${mode==='monitor'?'Monitor':'Test'} ${result.status}`);
      gauge(mode==='monitor'?summarizeLatency(result.latency.monitor).median:result.download.mbps,mode==='monitor'?'ms':'Mbps',result.status.toUpperCase(),result.label || 'Result saved on this device');
      log(`Finished: ${result.status}`,result.status==='completed'?'success':'warn');
      if(result.status==='cancelled'||result.status==='failed')break;
    }
    if(pair.length===2) { $('compareA').value=pair[0].id;$('compareB').value=pair[1].id;renderComparison(); }
    tone(true);
  } catch(error) {
    executionFailed = true;
    lastRun = {...activeRun, finishedAt:new Date().toISOString(), failure:errorText(error), result:current};
    recordRuntimeError(error, 'Test execution');
    set('statusText','Test failed');
    set('resultIssues',`The test could not finish: ${error?.message || String(error)}. Open Logs for the diagnostic report.`);
    $('resultIssues').hidden=false;
  } finally {
    activeRun=null;live=null;setBusy(false);
    if(executionFailed)set('statusBadge','FAILED');else if(current)set('statusBadge',current.status.toUpperCase());
    persistenceWarning();
  }
}

function clearReadings() {
  for(const id of ['downloadValue','uploadValue','pingValue','jitterValue','idleMedian','idleP95','downloadMedian','downloadP95','downloadAdded','uploadMedian','uploadP95','uploadAdded','bufferGrade'])set(id,'—');
  for(const id of ['downloadHint','uploadHint','pingHint','jitterHint'])set(id,'Awaiting measurement');
  for(const id of ['gamingScore','streamingScore','callingScore','cloudScore'])set(id,'Not assessed');
  set('qualitySummary','Waiting for measurements');set('qualityDetail','Measured latency under download and upload traffic.');
  $('resultIssues').hidden=true;plotResult(null);setBudget(null);
}

function persistenceWarning() {
  $('storageWarning').hidden=!store.warning;if(store.warning)set('storageWarning',store.warning);
}

function labelFor(r) {return `${new Date(r.startedAt).toLocaleString()} · ${r.label || (r.kind==='monitor'?'Monitor':`${r.settings.streams} streams`)} · ${r.status}`;}

function renderHistory() {
  set('historyCount',`${history.length} saved ${history.length===1?'run':'runs'}`);
  $('historyBody').replaceChildren();
  if(!history.length) {
    const row=$('historyBody').insertRow();const cell=row.insertCell();cell.colSpan=8;cell.textContent='Your saved tests will appear here. Results stay on this device.';cell.className='empty-row';
  }
  for(const r of history) {
    const s=summarizeLatency(r.latency[r.kind==='monitor'?'monitor':'idle']);
    const row=$('historyBody').insertRow();
    const values=[new Date(r.startedAt).toLocaleString(),r.label || 'Untitled',r.kind==='monitor'?`${r.settings.monitorMinutes}m monitor`:`${r.settings.streams} streams · ${r.settings.duration}s`,number(r.download.mbps),number(r.upload.mbps),number(s.median),r.status];
    values.forEach(value=>{row.insertCell().textContent=value;});
    const actions=row.insertCell();
    const view=document.createElement('button');view.type='button';view.className='table-btn';view.textContent='View';view.setAttribute('aria-label',`View ${labelFor(r)}`);
    view.addEventListener('click',()=>{if(busy){toast('Stop the current test before viewing a saved run.');return;}current=r;showSummary(r);plotResult(r);phase='download';gauge(r.kind==='monitor'?s.median:r.download.mbps,r.kind==='monitor'?'ms':'Mbps','SAVED RUN',labelFor(r));set('statusText',`Viewing ${labelFor(r)}`);set('statusBadge',r.status.toUpperCase());});
    const edit=document.createElement('button');edit.type='button';edit.className='table-btn';edit.textContent='Label';edit.setAttribute('aria-label',`Rename ${labelFor(r)}`);
    edit.addEventListener('click',()=>{const label=window.prompt('Label this run (Wi-Fi, Ethernet, VPN on, router change…)',r.label);if(label!==null){history=store.rename(r.id,label.slice(0,80));renderHistory();persistenceWarning();}});
    actions.append(view,edit);
  }
  for(const id of ['compareA','compareB']) {
    const old=$(id).value;$(id).replaceChildren();
    history.forEach(r=>{const option=document.createElement('option');option.value=r.id;option.textContent=labelFor(r);$(id).append(option);});
    if(history.some(r=>r.id===old))$(id).value=old;else if(id==='compareA'&&history.length>1)$(id).value=history[1].id;
  }
  $('exportCsv').disabled=!history.length;
  renderTrend();renderComparison();persistenceWarning();
}

function renderTrend() {
  const metric=$('trendMetric').value;
  const records=history.filter(r=>r.kind==='speed').slice().sort((a,b)=>new Date(a.startedAt)-new Date(b.startedAt));
  const points=records.map(r=>({x:new Date(r.startedAt).getTime(),y:['completed','partial','budget'].includes(r.status)?(metric==='ping'?summarizeLatency(r.latency.idle).median:r[metric].bytes>0?r[metric].mbps:null):null}));
  plot('trendChart',[{color:metric==='ping'?colors.idle:colors[metric],points}],{unit:metric==='ping'?'ms':'Mbps',time:'dates'});
}

function renderComparison() {
  const a=history.find(r=>r.id===$('compareA').value), b=history.find(r=>r.id===$('compareB').value);
  $('comparisonBody').replaceChildren();
  if(!a||!b||a.id===b.id){set('comparisonNote','Save two runs, then select a baseline (A) and a new result (B).');return;}
  if(a.kind!==b.kind){set('comparisonNote','Choose two speed tests or two monitor sessions to compare like measurements.');return;}
  const settingsDiffer=['duration','budgetBytes','endpoint','monitorMinutes'].some(k=>a.settings[k]!==b.settings[k]);
  set('comparisonNote',`${settingsDiffer?'Different test settings: interpret the changes cautiously. ':''}${a.status!=='completed'||b.status!=='completed'?'One or both runs are incomplete; partial values are not a full comparison. ':''}Change = B minus A. ${a.settings.streams!==b.settings.streams?'Stream count differs.':''}`);
  const rows=compareResults(a,b);
  for(const item of rows) {
    const row=$('comparisonBody').insertRow();
    row.insertCell().textContent=item.label || item.metric;
    row.insertCell().textContent=`${number(item.a)} ${item.unit}`;
    row.insertCell().textContent=`${number(item.b)} ${item.unit}`;
    const cell=row.insertCell();
    if(Number.isFinite(item.delta)) {
      cell.textContent=`${item.delta>=0?'+':''}${number(item.delta)} ${item.unit}${Number.isFinite(item.percent)?` (${item.percent>=0?'+':''}${number(item.percent)}%)`:''}`;
      if(item.delta!==0)cell.className=(item.better==='higher'?item.delta>0:item.delta<0)?'positive':'negative';
    }else cell.textContent='Unavailable';
  }
}

$('settings').addEventListener('submit',start);
$('mode').addEventListener('change',controls);
$('budget').addEventListener('change',()=>{controls();saveBudgetPreferences();});
$('customBudget').addEventListener('input',()=>{budgetControls();setBudget(null);saveBudgetPreferences();});
$('stopBtn').addEventListener('click',()=>{stopRequested=true;engine.stop('user');$('stopBtn').disabled=true;set('statusText','Stopping active requests…');});
$('resetBtn').addEventListener('click',()=>{if(busy)return;current=null;clearReadings();$('monitorSummary').hidden=true;gauge(0,'Mbps','READY','Choose a test to begin');set('statusBadge','READY');set('statusText','Ready to measure');});
$('soundToggle').addEventListener('click',()=>{audible=!audible;$('soundToggle').setAttribute('aria-pressed',String(audible));$('soundToggle').textContent=audible?'Sound on':'Sound off';tone();});
$('logsToggle').addEventListener('click',()=>{$('logDrawer').hidden=false;$('logsToggle').setAttribute('aria-expanded','true');$('closeLogs').focus();});
$('closeLogs').addEventListener('click',()=>{$('logDrawer').hidden=true;$('logsToggle').setAttribute('aria-expanded','false');$('logsToggle').focus();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('logDrawer').hidden)$('closeLogs').click();});
$('clearLogs').addEventListener('click',()=>{$('logContent').replaceChildren();recentLogs.length=0;});
$('copyDiagnostics').addEventListener('click',copyDiagnostics);
$('saveDiagnostics').addEventListener('click',()=>{
  const report=revealDiagnostics();
  try {downloadText(report.value,`velocity-diagnostics-${APP_VERSION}.json`,'application/json');}
  catch(error) {report.focus();report.select();toast('Select and copy the report below.');}
});
$('clearHistory').addEventListener('click',()=>{if(busy)return;if(window.confirm('Delete all saved test history on this device?')){history=store.clear();renderHistory();}});
$('exportCsv').addEventListener('click',()=>{downloadText(toCSV(history),`velocity-history-${new Date().toISOString().slice(0,10)}.csv`,'text/csv;charset=utf-8');});
for(const id of ['compareA','compareB'])$(id).addEventListener('change',renderComparison);
$('trendMetric').addEventListener('change',renderTrend);
document.addEventListener('visibilitychange',()=>{if(document.hidden&&busy){stopRequested=true;engine.stop('background');log('Test interrupted because the tab was hidden. Keep it visible for reliable timings.','warn');}});
window.addEventListener('offline',()=>log('Browser reports offline. Probes will show failures until connectivity returns.','warn'));
window.addEventListener('online',()=>log('Browser reports connectivity restored.'));
window.addEventListener('resize',()=>{for(const [id,{series,options}] of plots)plot(id,series,options);});
window.addEventListener('storage',()=>{if(!busy){history=store.load();renderHistory();}});
restoreBudgetPreferences();controls();renderHistory();clearReadings();gauge(0,'Mbps','READY','Choose a test to begin');
log(`Velocity ${APP_VERSION} ready. No measurements or external requests until you start a test.`);
const pageProtocol=globalThis.location?.protocol || 'unavailable';
$('localFileNotice').hidden=!['file:','content:','data:','blob:'].includes(pageProtocol);
const pageContext=window.top ? (window.top===window?'top-level':'embedded') : 'unavailable';
const secureContext=typeof globalThis.isSecureContext==='boolean'?String(globalThis.isSecureContext):'unavailable';
log(`Runtime: protocol=${pageProtocol}; context=${pageContext}; secure=${secureContext}.`);
log(`Browser: ${globalThis.navigator?.userAgent || 'unavailable'}`);
log(`Request APIs: fetch=${typeof globalThis.fetch==='function'?'available':'unavailable'}; XMLHttpRequest=${typeof globalThis.XMLHttpRequest==='function'?'available':'unavailable'}.`);
