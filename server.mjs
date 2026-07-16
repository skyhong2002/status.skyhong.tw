import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createUsageMonitor } from './usage.mjs';

const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || './data';
const historyFile = join(dataDir, 'history.json');
const agentsFile = join(dataDir, 'agents.json');
const intervalMs = Math.max(15, Number(process.env.CHECK_INTERVAL_SECONDS || 60)) * 1000;
const dockerApiUrl = process.env.DOCKER_API_URL || '';
const maxHistoryPoints = 24 * 60;

const targets = parseJson(process.env.STATUS_TARGETS_JSON, [
  { id: 'youtube-board-tw', name: 'youtube.board.tw', group: 'Products', url: 'https://youtube.board.tw' },
  { id: 'harmonica-observe', name: 'harmonica.observe.tw', group: 'Products', url: 'https://harmonica.observe.tw' },
  { id: 'youtube-observe', name: 'youtube.observe.tw', group: 'Products', url: 'https://youtube.observe.tw' },
  { id: 'plaud-skyhong', name: 'plaud.skyhong.tw', group: 'Products', url: 'https://plaud.skyhong.tw' },
  { id: 'mayor2026-observe', name: 'mayor2026.observe.tw', group: 'Products', url: 'https://mayor2026.observe.tw' },
  { id: 'infovore', name: 'Infovore', group: 'Products', url: 'https://infovore.skyhong.tw' },
  { id: 'n8n', name: 'n8n automations', group: 'Operations', url: 'https://n8n.skyhong.tw' },
  { id: 'freshrss', name: 'FreshRSS', group: 'Operations', url: 'https://rss.skyhong.tw' },
]);
const state = { checkedAt: null, targets: [], services: [], agents: {}, aiUsage: [], errors: [], history: {} };
const usageMonitor = await createUsageMonitor({ dataDir });

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function elapsed(ms) {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

async function checkTarget(target) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), target.timeoutMs || 12_000);
  try {
    const response = await fetch(target.url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    const accepted = target.acceptedStatuses || [];
    const up = accepted.length ? accepted.includes(response.status) : response.status < 500;
    return { ...target, up, statusCode: response.status, latencyMs: Date.now() - startedAt, detail: response.statusText || 'Reachable' };
  } catch (error) {
    return { ...target, up: false, statusCode: null, latencyMs: Date.now() - startedAt, detail: error.name === 'AbortError' ? 'Timed out' : 'Unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

async function dockerRequest(path) {
  if (!dockerApiUrl) return null;
  const response = await fetch(`${dockerApiUrl}${path}`, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`Docker API returned ${response.status}`);
  return response.json();
}

async function getDockerServices() {
  if (!dockerApiUrl) return [];
  const [services, tasks, containers] = await Promise.all([
    dockerRequest('/services'), dockerRequest('/tasks'), dockerRequest('/containers/json?all=1'),
  ]);
  const swarm = (services || []).map((service) => {
    const relevantTasks = (tasks || []).filter((task) => task.ServiceID === service.ID);
    const desired = service.Spec?.Mode?.Replicated?.Replicas ?? 1;
    const running = relevantTasks.filter((task) => task.Status?.State === 'running').length;
    const failed = relevantTasks.filter((task) => ['failed', 'rejected'].includes(task.Status?.State)).length;
    return {
      id: service.ID,
      name: service.Spec?.Name || service.ID.slice(0, 12),
      kind: 'Swarm service',
      up: running >= desired && failed === 0,
      detail: `${running}/${desired} running${failed ? `, ${failed} failed` : ''}`,
    };
  });
  const standalone = (containers || [])
    .filter((container) => !container.Labels?.['com.docker.swarm.service.name'])
    .map((container) => ({
      id: container.Id,
      name: container.Names?.[0]?.replace(/^\//, '') || container.Id.slice(0, 12),
      kind: 'Container',
      up: container.State === 'running' && !container.Status?.includes('(unhealthy)'),
      detail: container.Status || container.State,
    }));
  return [...swarm, ...standalone].sort((a, b) => a.name.localeCompare(b.name));
}

async function getAiUsage() {
  return usageMonitor ? [usageMonitor.summary()] : [];
}

async function loadHistory() {
  try { state.history = JSON.parse(await readFile(historyFile, 'utf8')); } catch { state.history = {}; }
  try { state.agents = JSON.parse(await readFile(agentsFile, 'utf8')); } catch { state.agents = {}; }
}

async function saveHistory() {
  await mkdir(dataDir, { recursive: true });
  await saveJson(historyFile, state.history);
}

async function saveJson(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value), 'utf8');
  await rename(temporary, file);
}

function recordHistory(items) {
  const now = Date.now();
  for (const item of items) {
    const points = state.history[item.id] || [];
    points.push({ t: now, up: item.up });
    state.history[item.id] = points.filter((point) => point.t > now - 24 * 60 * 60 * 1000).slice(-maxHistoryPoints);
  }
}

async function refresh() {
  const errors = [];
  const checkedTargets = await Promise.all(targets.map(checkTarget));
  let services = [];
  try { services = await getDockerServices(); } catch (error) { errors.push('Docker status temporarily unavailable'); }
  let aiUsage = [];
  try { aiUsage = await getAiUsage(); } catch (error) { errors.push('AI usage collection temporarily unavailable'); }
  state.checkedAt = new Date().toISOString();
  state.targets = checkedTargets;
  state.services = services;
  state.aiUsage = aiUsage;
  state.errors = errors;
  recordHistory([...checkedTargets, ...services]);
  await saveHistory();
}

function authorized(request) {
  const user = process.env.DASHBOARD_USER;
  const password = process.env.DASHBOARD_PASSWORD;
  if (!user || !password) return true;
  const header = request.headers.authorization || '';
  const token = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8') : '';
  return token === `${user}:${password}`;
}

function agentAuthorized(request) {
  const token = process.env.AGENT_INGEST_TOKEN;
  return Boolean(token) && request.headers.authorization === `Bearer ${token}`;
}

function remoteItems() {
  const now = Date.now();
  return Object.entries(state.agents).flatMap(([agentId, agent]) => {
    const stale = !agent.receivedAt || now - new Date(agent.receivedAt).getTime() > intervalMs * 3;
    return (agent.items || []).map((item) => ({
      ...item,
      id: `${agentId}:${item.id}`,
      name: `${agent.host || agentId} · ${item.name}`,
      up: stale ? false : Boolean(item.up),
      detail: stale ? 'Agent has not checked in' : item.detail,
      kind: `Remote host${item.kind ? ` · ${item.kind}` : ''}`,
      receivedAt: agent.receivedAt,
    }));
  });
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 100_000) request.destroy();
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
    });
    request.on('error', reject);
  });
}

async function ingestAgent(request, response, agentId) {
  if (!agentAuthorized(request)) {
    response.writeHead(401);
    response.end('Invalid agent token');
    return;
  }
  try {
    const payload = await readRequest(request);
    if (!Array.isArray(payload.items) || payload.items.length > 100 || typeof payload.host !== 'string') throw new Error('Invalid agent payload');
    state.agents[agentId] = { host: payload.host.slice(0, 80), receivedAt: new Date().toISOString(), items: payload.items.map((item) => ({
      id: String(item.id || '').slice(0, 80), name: String(item.name || '').slice(0, 120), kind: String(item.kind || 'Process').slice(0, 80),
      up: Boolean(item.up), detail: String(item.detail || '').slice(0, 200),
    })).filter((item) => item.id && item.name) };
    recordHistory(remoteItems());
    await Promise.all([saveHistory(), saveJson(agentsFile, state.agents)]);
    json(response, { ok: true });
  } catch (error) {
    response.writeHead(400);
    response.end('Invalid agent payload');
  }
}

function json(response, body) {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function page() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sky Status</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f6f7;color:#16252d;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1240px;margin:auto;padding:32px 24px 48px}header{display:flex;align-items:end;justify-content:space-between;border-bottom:1px solid #cad6d8;padding-bottom:20px;margin-bottom:28px}h1{font-size:26px;margin:0;letter-spacing:0;font-weight:680}header p{margin:5px 0 0;color:#52646c}.updated{color:#52646c;font-size:12px;text-align:right}.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:28px}.metric,.panel{background:#fff;border:1px solid #d5dfe0;border-radius:6px}.metric{padding:16px}.metric b{display:block;font-size:25px;margin-top:2px}.metric span{color:#52646c;font-size:12px;text-transform:uppercase;letter-spacing:.04em}.grid{display:grid;grid-template-columns:1.15fr .85fr;gap:18px}.panel{padding:18px}.panel.wide{grid-column:1/-1}.panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}h2{font-size:15px;margin:0}.row{display:grid;grid-template-columns:minmax(140px,1fr) 105px 90px;gap:12px;padding:11px 0;border-top:1px solid #e6ecec;align-items:center}.row:first-of-type{border-top:0}.name{font-weight:620}.muted{color:#63747a;font-size:12px}.status{font-size:12px;font-weight:700;text-align:right}.up{color:#08783f}.down{color:#bf3030}.history{display:flex;gap:2px;justify-content:flex-end}.dot{display:block;width:5px;height:16px;background:#cbd5d7}.dot.up{background:#20a662}.dot.down{background:#e05454}.empty{color:#63747a;padding:12px 0}.footer{margin-top:26px;color:#63747a;font-size:12px}.ai-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid #e6ecec;border-bottom:1px solid #e6ecec}.ai-stat{padding:14px 16px 14px 0}.ai-stat span,.section-label{display:block;color:#63747a;font-size:11px;text-transform:uppercase}.ai-stat b{display:block;font-size:20px;margin-top:3px}.ai-layout{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:20px}.quota{margin:12px 0 18px}.quota-head{display:flex;justify-content:space-between;gap:16px;margin-bottom:7px}.quota-head b{font-size:13px}.track{height:8px;background:#e5ebeb;overflow:hidden}.fill{height:100%;background:#168554}.fill.warn{background:#d18322}.fill.danger{background:#c43b3b}.trend{height:82px;display:flex;align-items:flex-end;gap:3px;border-bottom:1px solid #cbd6d8;margin:12px 0 20px}.trend i{display:block;min-width:4px;flex:1;background:#168554}.data-table{width:100%;border-collapse:collapse;margin-top:7px}.data-table th,.data-table td{text-align:left;padding:7px 5px;border-top:1px solid #e6ecec;font-size:12px}.data-table th{color:#63747a;font-weight:500}.data-table td:last-child,.data-table th:last-child{text-align:right}.tag{display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;padding:1px 5px;border:1px solid #b9c7c9}.tag.billable{color:#a32b2b;border-color:#e2adad}@media(max-width:900px){.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.ai-layout{grid-template-columns:1fr}}@media(max-width:760px){main{padding:22px 14px}header{align-items:start;flex-direction:column;gap:12px}.updated{text-align:left}.summary,.grid{grid-template-columns:1fr}.row{grid-template-columns:minmax(120px,1fr) 80px 65px}.ai-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head><body><main><header><div><h1>Sky Status</h1><p>Products, infrastructure, and AI operations.</p></div><div class="updated" id="updated">Loading status...</div></header><section class="summary" id="summary"></section><section class="grid"><div class="panel"><div class="panel-head"><h2>Public products</h2></div><div id="targets"></div></div><div class="panel"><div class="panel-head"><h2>Docker runtime</h2></div><div id="services"></div></div><div class="panel"><div class="panel-head"><h2>Remote hosts</h2></div><div id="remote"></div></div><div class="panel"><div class="panel-head"><h2>Attention</h2></div><div id="attention"></div></div><div class="panel wide"><div class="panel-head"><h2>OpenAI organization usage</h2><span class="muted" id="ai-sync"></span></div><div id="ai"></div></div></section><p class="footer">Service checks run every minute. OpenAI usage syncs hourly and re-fetches recent buckets to account for delayed usage data.</p></main><script>
const esc=v=>String(v??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
function row(item,detail,right){const points=(window.data.history[item.id]||[]).slice(-24);const history=points.length?'<div class="history">'+points.map(p=>'<i class="dot '+(p.up?'up':'down')+'"></i>').join('')+'</div>':'<span class="muted">No history</span>';return '<div class="row"><div><div class="name">'+esc(item.name)+'</div><div class="muted">'+esc(detail)+'</div></div><div class="status '+(item.up||item.connected?'up':'down')+'">'+right+'</div>'+history+'</div>'}
function render(items,id,renderer){document.getElementById(id).innerHTML=items.length?items.map(renderer).join(''):'<div class="empty">No sources configured.</div>'}
const number=v=>new Intl.NumberFormat().format(Number(v||0));
function renderAi(ai){if(!ai){document.getElementById('ai').innerHTML='<div class="empty">OpenAI Usage API is not configured.</div>';document.getElementById('ai-sync').textContent='Not connected';return}document.getElementById('ai-sync').textContent=ai.lastSyncAt?'Synced '+new Date(ai.lastSyncAt).toLocaleString():ai.detail;const stats='<div class="ai-stats"><div class="ai-stat"><span>Input tokens today</span><b>'+number(ai.input)+'</b></div><div class="ai-stat"><span>Output tokens today</span><b>'+number(ai.output)+'</b></div><div class="ai-stat"><span>Requests today</span><b>'+number(ai.requests)+'</b></div><div class="ai-stat"><span>Cost · UTC day</span><b>$'+Number(ai.cost||0).toFixed(4)+'</b></div></div>';const pools='<div><span class="section-label">預估免費池使用量</span>'+ai.pools.map(p=>{const level=p.percent>=95?'danger':p.percent>=70?'warn':'';return '<div class="quota"><div class="quota-head"><b>'+esc(p.name)+'</b><span>'+number(p.used)+' / '+number(p.limit)+' · '+p.percent.toFixed(1)+'%</span></div><div class="track"><div class="fill '+level+'" style="width:'+Math.min(100,p.percent)+'%"></div></div><div class="muted">Remaining '+number(p.remaining)+'</div></div>'}).join('')+'<span class="section-label">Last 24 hours</span><div class="trend">'+(()=>{const max=Math.max(1,...ai.trend.map(x=>x.tokens));return ai.trend.map(x=>'<i title="'+new Date(x.start*1000).toLocaleString()+': '+number(x.tokens)+' tokens" style="height:'+Math.max(3,x.tokens/max*100)+'%"></i>').join('')})()+'</div></div>';const modelRows=ai.byModel.map(x=>'<tr><td>'+esc(x.model||'Unknown')+'</td><td><span class="tag '+(x.pool==='billable'?'billable':'')+'">'+esc(x.pool==='billable'?'possible billing':x.pool+' pool')+'</span></td><td>'+number(x.tokens)+'</td></tr>').join('');const keyRows=ai.byKey.map(x=>'<tr><td>'+esc(x.name)+'</td><td>'+number(x.requests)+'</td><td>'+number(x.tokens)+'</td></tr>').join('');const projectRows=ai.byProject.map(x=>'<tr><td>'+esc(x.name)+'</td><td>'+number(x.requests)+'</td><td>'+number(x.tokens)+'</td></tr>').join('');const tierRows=ai.byTier.map(x=>'<tr><td>'+esc(x.name||'unspecified')+'</td><td>'+number(x.requests)+'</td><td>'+number(x.tokens)+'</td></tr>').join('');const tables='<div><span class="section-label">Models</span><table class="data-table"><thead><tr><th>Model</th><th>Classification</th><th>Tokens</th></tr></thead><tbody>'+modelRows+'</tbody></table><span class="section-label" style="margin-top:20px">API keys</span><table class="data-table"><thead><tr><th>Key / service</th><th>Requests</th><th>Tokens</th></tr></thead><tbody>'+keyRows+'</tbody></table><span class="section-label" style="margin-top:20px">Projects</span><table class="data-table"><thead><tr><th>Project</th><th>Requests</th><th>Tokens</th></tr></thead><tbody>'+projectRows+'</tbody></table><span class="section-label" style="margin-top:20px">Service tiers</span><table class="data-table"><thead><tr><th>Tier</th><th>Requests</th><th>Tokens</th></tr></thead><tbody>'+tierRows+'</tbody></table></div>';document.getElementById('ai').innerHTML=stats+'<div class="ai-layout">'+pools+tables+'</div>'}
async function load(){const r=await fetch('/api/status');window.data=await r.json();const d=window.data;const products=d.targets.filter(x=>x.group==='Products'),others=d.targets.filter(x=>x.group!=='Products'),remote=Object.entries(d.agents).flatMap(([id,a])=>(a.items||[]).map(x=>({...x,id:id+':'+x.id,name:(a.host||id)+' · '+x.name,up:(Date.now()-new Date(a.receivedAt).getTime()<180000)&&x.up,detail:(Date.now()-new Date(a.receivedAt).getTime()<180000)?x.detail:'Agent has not checked in',kind:'Remote host · '+x.kind})));const all=[...products,...others],ai=d.aiUsage[0],up=all.filter(x=>x.up).length,running=d.services.filter(x=>x.up).length,remoteUp=remote.filter(x=>x.up).length;document.getElementById('summary').innerHTML='<div class="metric"><span>Public checks</span><b>'+up+' / '+all.length+'</b></div><div class="metric"><span>Docker runtime</span><b>'+running+' / '+d.services.length+'</b></div><div class="metric"><span>Remote hosts</span><b>'+remoteUp+' / '+remote.length+'</b></div><div class="metric"><span>AI requests today</span><b>'+number(ai?.requests)+'</b></div>';document.getElementById('updated').textContent='Last check: '+new Date(d.checkedAt).toLocaleString();render(all,'targets',x=>row(x,(x.statusCode?'HTTP '+x.statusCode+' · ':'')+(x.latencyMs+' ms'),x.up?'UP':'DOWN'));render(d.services,'services',x=>row(x,x.kind+' · '+x.detail,x.up?'RUNNING':'DEGRADED'));render(remote,'remote',x=>row(x,x.kind+' · '+x.detail,x.up?'RUNNING':'OFFLINE'));renderAi(ai);const aiIssues=ai?[...(!ai.connected?[ai]:[]),...ai.possibleBillable.map(x=>({name:x.model,detail:'Model is outside configured free pools'})),...ai.pools.filter(x=>x.percent>=70).map(x=>({name:x.name,detail:x.percent.toFixed(1)+'% of estimated free pool used'}))]:[];const issues=[...all.filter(x=>!x.up),...d.services.filter(x=>!x.up),...remote.filter(x=>!x.up),...aiIssues];document.getElementById('attention').innerHTML=issues.length?issues.map(x=>'<div class="row"><div><div class="name">'+esc(x.name)+'</div><div class="muted">'+esc(x.detail||'Needs review')+'</div></div><div class="status down">ACTION</div><span></span></div>').join(''):'<div class="empty">No active incidents.</div>'}
load();setInterval(load,60000);
</script></body></html>`;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const agentMatch = url.pathname.match(/^\/api\/agents\/([a-z0-9-]{1,64})$/i);
  if (request.method === 'POST' && agentMatch) return ingestAgent(request, response, agentMatch[1]);
  if (!authorized(request)) {
    response.writeHead(401, { 'www-authenticate': 'Basic realm="Sky Status"' });
    response.end('Authentication required');
    return;
  }
  if (url.pathname === '/api/status') return json(response, state);
  if (url.pathname === '/healthz') return json(response, { ok: true });
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(page());
});

await loadHistory();
if (usageMonitor) await usageMonitor.sync();
await refresh();
setInterval(() => refresh().catch(() => {}), intervalMs);
if (usageMonitor) setInterval(() => usageMonitor.sync().catch(() => {}), 60 * 60 * 1000);
server.listen(port, '0.0.0.0');

export { checkTarget, parseJson };
