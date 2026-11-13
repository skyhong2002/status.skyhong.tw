const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const HOUR = 3_600_000;
const BINS = 48;
const BIN_MS = (24 * HOUR) / BINS;
const LIST_LIMIT = 8;
const ATTENTION_LIMIT = 5;
const POLL_MS = 60_000;

// ---------- storage (may be unavailable in private windows) ----------
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* per-visit only */ } },
};

// ---------- i18n ----------
// Traditional Chinese is the default; English is kept. Service names and the server's own
// detail text (HTTP reasons, error messages) are shown as reported.
const ZH = 'zh-Hant-TW';
const STRINGS = {
  [ZH]: {
    home: 'Sky Status 首頁', navLabel: '頁面區塊', themeToggle: '切換深淺色', summary: '狀態摘要',
    description: 'Sky Hong 各項產品、基礎設施與 AI 閘道的即時服務狀態。',
    navProducts: '產品', navInfra: '基礎設施', navJobs: '排程工作', navExpiry: '到期', navGateway: 'AI 閘道',
    loading: '載入中…',
    tilePublic: '公開端點', tileDocker: 'Docker 執行環境', tileRemote: '遠端主機', tileGateway: 'AI 閘道',
    attentionEyebrow: '待處理', attentionTitle: '需要注意',
    productsEyebrow: '外部探測', productsTitle: '產品與服務',
    legendUp: '正常', legendDown: '故障', legendNone: '無資料', legendNote: '過去 24 小時，每格 30 分鐘',
    infraEyebrow: '執行環境', infraTitle: '基礎設施', infraMeta: '唯讀代理程式 · 每分鐘更新',
    dockerTitle: 'Docker 服務', remoteKicker: '遠端代理程式', remoteTitle: '主機程序',
    jobsEyebrow: '失聯偵測', jobsTitle: '背景工作', jobsMeta: '每個工作須按時回報；沒有回報即視為事件',
    heartbeatKicker: 'Cron · n8n · 備份', heartbeatTitle: '心跳', deliveryTitle: '告警送達',
    expiryEyebrow: '到期監控', expiryTitle: '憑證與網域', expiryMeta: 'TLS 每 6 小時檢查 · WHOIS / RDAP',
    certTitle: 'TLS 憑證', domainKicker: '註冊', domainTitle: '網域到期',
    gatewayTitle: 'AI 閘道', gatewayPlan: 'Codex 訂閱', usageTitle: '用量額度',
    footer: '每分鐘檢查一次 · 閘道用量每 5 分鐘讀取一次。', metrics: '指標', badge: '徽章', source: '原始碼',
    langButton: '中文', langSwitch: '切換為繁體中文',
    // time
    justNow: '剛剛', never: '從未', minutesAgo: (n) => `${n} 分鐘前`, hoursAgo: (n) => `${n} 小時前`, daysAgo: (n) => `${n} 天前`,
    inDays: (d, h) => `${d} 天 ${h} 小時後`, inHours: (h) => `${h} 小時後`, inMinutes: (m) => `${m} 分鐘後`,
    durMinutes: (m) => `${m} 分鐘`, durHours: (h, m) => (m ? `${h} 小時 ${m} 分` : `${h} 小時`),
    since: (time, duration, approx) => `${approx ? '約 ' : ''}${time} 起 · 已 ${duration}`,
    sinceOver24h: '超過 24 小時',
    updated: (ago) => `${ago}更新`, checked: (ago) => `${ago}檢查`,
    // hero
    pendingTitle: '等待首次檢查', pendingDetail: '監控剛啟動，結果將在一分鐘內出現。',
    okTitle: '所有系統運作正常', okDetail: '所有監控中的產品、執行環境、排程工作與閘道皆正常回應。',
    warnTitle: '部分效能降級', majorTitle: '重大服務中斷', partialTitle: '部分服務中斷',
    maintenanceTitle: '維護進行中', maintenanceDetail: '維護期間暫停告警。',
    offlineTitle: '無法取得狀態資料', offlineDetail: '無法取得最新狀態，每分鐘會自動重試。',
    namesDown: (names) => `${names.length <= 2 ? names.join('、') : `${names.slice(0, 2).join('、')} 等 ${names.length} 項`} 無法使用`,
    restOk: '其餘服務正常回應。',
    alsoWarn: (n) => `另有 ${n} 項需要留意。`,
    nDown: (n) => `${n} 個項目故障，詳見下方清單。`,
    warnSlow: (n) => `${n} 項回應緩慢`, warnExpiry: (n) => `${n} 項即將到期`, warnDelivery: (n) => `${n} 項告警送達未確認`, warnOther: (n) => `${n} 項需要留意`,
    warnTail: '；服務仍可使用。', list: (items) => items.join('、'),
    // tiles & counts
    slowCount: (n) => `${n} 緩慢`, groupHealthy: (up, total) => `${up}/${total} 正常`, activeCount: (n) => `${n} 項進行中`,
    showMore: (n) => `顯示其餘 ${n} 項`,
    groupNames: (names, n) => (n <= 2 ? names.join('、') : `${names.slice(0, 2).join('、')} 等 ${n} 項`),
    // empty
    notChecked: '尚未檢查。', noTargets: '尚未設定公開端點。', noDocker: '沒有 Docker 資料。', noRemote: '沒有遠端代理程式資料。',
    noHeartbeats: '尚未設定心跳。', noDelivery: '沒有告警送達資料。', noCerts: '尚無憑證資料。', noDomains: '尚無網域資料。',
    noGateway: '尚無閘道資料。', noUsage: '未回報用量額度。',
    // bars & metrics
    historyLabel: '24 小時狀態紀錄', barUp: '全部檢查通過', barDown: '至少一次檢查失敗', barNone: '無資料',
    response: '回應時間', noResponse: '無回應', days: (n) => `${n} 天`, observedDays: (n) => `已觀測 ${n} 天`, hours24: '24 小時',
    windowTip: (pct, seen, total) => `${pct}（已觀測 ${seen}/${total} 天）`,
    // states
    operational: '正常', degraded: '緩慢', unavailable: '無法使用', running: '執行中', stopped: '已停止', down: '故障',
    onTime: '準時', late: '逾時未回報', verified: '已確認', unverified: '未確認', off: '關閉', serving: '服務中',
    mapped: '已對應', paused: '已暫停', missing: '缺少', drift: '不一致', stale: '過時', relogin: '需重新登入', expired: '已過期',
    usedUp: '已用完', valid: '有效', invalid: '無效', answered: '已回應', failed: '失敗',
    // tags & rows
    tagSwarm: 'swarm', tagContainer: '容器', tagHost: '主機', tagListener: '監聽', tagAlias: '別名', tagMirror: '鏡像', tagLogin: '登入',
    every: (n, unit) => `每 ${n} ${unit === 'h' ? '小時' : '分鐘'}`,
    agentSilent: (ago) => `代理程式未回報 · 上次回報 ${ago}`,
    used: (n) => `已使用 ${n}%`, remaining: (n) => `剩餘 ${n}%`, daysRemaining: (n) => `剩餘 ${n} 天`, unknownDays: '不明',
    certificate: '憑證', validUntil: (date) => `有效至 ${date}`, checkFailed: '檢查失敗', expires: (date) => `到期日 ${date}`, expiryUnpublished: '未公開到期日',
    webhookMissing: '未設定 Webhook', lastFailed: (err) => `上次傳送失敗 · ${err}`, verifiedAt: (date) => `已於 ${date} 確認`, notVerified: '尚未確認送達',
    incidentAlerts: '事件告警', alerts: (id) => `${id} 告警`,
    // gateway
    notMonitored: '未監控', disabledInHosts: '已在 hosts.json 停用', over24h: (pct) => `24 小時 ${pct}`,
    accountHidden: '帳號已隱藏', refreshed: (ago) => `${ago}更新`, codexCredential: 'Codex 憑證', inferenceProbe: '推論探測', every30: '每 30 分鐘',
    hostTelemetry: '主機遙測', agentLast: (agent, ago) => `${agent} 代理程式上次回報：${ago}`, agentNever: (agent) => `${agent} 代理程式尚未回報`,
    gatewayHost: '閘道主機', hostOff: '閘道主機 · 關閉', hostDrift: '閘道主機 · 設定不一致',
    policy: (rev) => `政策 ${rev}`, policyUnknown: '政策未知', hostCount: (n) => `${n} 台主機`, onePerHost: '每台主機一個閘道',
    resets: (date, until) => `${date} 重置 · ${until}`,
    usageRead: (ago) => `${ago}透過 codex app-server 讀取，不消耗額度。`, usageNever: '尚未讀取用量。', telemetryStale: '遙測資料過時 · ', limitReached: '已達速率上限。',
    weeklyWindow: '每週額度', dayWindow: (n) => `${n} 天額度`, hourWindow: (n) => `${n} 小時額度`, minuteWindow: (n) => `${n} 分鐘額度`,
    // attention
    agentOffline: (host) => `${host} · 代理程式離線`, agentOfflineDetail: (ago, n) => `${ago}起無回報；${n} 個監控項目狀態不明`,
    tlsCert: (host) => `${host} · TLS 憑證`, domainReg: (domain) => `${domain} · 網域註冊`, expiresIn: (n) => `${n} 天後到期`,
    incidentDelivery: '事件告警送達', alertDelivery: (id) => `${id} 告警送達`, deliveryUnverified: '尚未確認送達',
    slowFallback: '回應緩慢', needsReview: '需要檢查',
  },
  en: {
    home: 'Sky Status home', navLabel: 'Dashboard sections', themeToggle: 'Toggle colour theme', summary: 'Status summary',
    description: "Live service, infrastructure, and AI gateway status for Sky Hong's projects.",
    navProducts: 'Products', navInfra: 'Infrastructure', navJobs: 'Jobs', navExpiry: 'Expiry', navGateway: 'AI gateway',
    loading: 'Loading…',
    tilePublic: 'Public endpoints', tileDocker: 'Docker runtime', tileRemote: 'Remote hosts', tileGateway: 'AI gateway',
    attentionEyebrow: 'Attention', attentionTitle: 'Needs attention',
    productsEyebrow: 'External probes', productsTitle: 'Products and services',
    legendUp: 'Up', legendDown: 'Down', legendNone: 'No data', legendNote: 'Last 24 h, 30 min per bar',
    infraEyebrow: 'Runtime', infraTitle: 'Infrastructure', infraMeta: 'Read-only agents · refreshed every minute',
    dockerTitle: 'Docker services', remoteKicker: 'Remote agents', remoteTitle: 'Host processes',
    jobsEyebrow: "Dead-man's switch", jobsTitle: 'Background jobs', jobsMeta: 'Each job pings in on schedule; silence is an incident',
    heartbeatKicker: 'Cron · n8n · backups', heartbeatTitle: 'Heartbeats', deliveryTitle: 'Alert delivery',
    expiryEyebrow: 'Expiry watch', expiryTitle: 'Certificates and domains', expiryMeta: 'TLS checked every 6 h · WHOIS / RDAP',
    certTitle: 'TLS certificates', domainKicker: 'Registration', domainTitle: 'Domain expiry',
    gatewayTitle: 'AI gateway', gatewayPlan: 'Codex subscription', usageTitle: 'Usage windows',
    footer: 'Checks refresh every minute · gateway usage every 5 minutes.', metrics: 'Metrics', badge: 'Badge', source: 'Source',
    langButton: 'EN', langSwitch: 'Switch to English',
    justNow: 'just now', never: 'never', minutesAgo: (n) => `${n} min ago`, hoursAgo: (n) => `${n} h ago`, daysAgo: (n) => `${n} d ago`,
    inDays: (d, h) => `in ${d} d ${h} h`, inHours: (h) => `in ${h} h`, inMinutes: (m) => `in ${m} min`,
    durMinutes: (m) => `${m} min`, durHours: (h, m) => (m ? `${h} h ${m} min` : `${h} h`),
    since: (time, duration, approx) => `since ${approx ? '~' : ''}${time} · ${duration}`,
    sinceOver24h: 'over 24 h',
    updated: (ago) => `Updated ${ago}`, checked: (ago) => `Checked ${ago}`,
    pendingTitle: 'Waiting for first checks', pendingDetail: 'Monitoring just started; results appear within a minute.',
    okTitle: 'All systems operational', okDetail: 'Every monitored product, runtime, job and gateway is responding normally.',
    warnTitle: 'Degraded performance', majorTitle: 'Major outage', partialTitle: 'Partial outage',
    maintenanceTitle: 'Scheduled maintenance in progress', maintenanceDetail: 'Alerts are paused during this maintenance window.',
    offlineTitle: 'Status data unavailable', offlineDetail: 'The dashboard could not retrieve the latest snapshot. It will retry every minute.',
    namesDown: (names) => `${names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`} ${names.length === 1 ? 'is' : 'are'} down`,
    restOk: 'Everything else is responding normally.',
    alsoWarn: (n) => `${n} more ${n === 1 ? 'item needs' : 'items need'} attention.`,
    nDown: (n) => `${n} items are down; see the list below.`,
    warnSlow: (n) => `${n} slow`, warnExpiry: (n) => `${n} expiring soon`, warnDelivery: (n) => `${n} alert delivery unverified`, warnOther: (n) => `${n} to review`,
    warnTail: '; services remain available.', list: (items) => items.join(', '),
    slowCount: (n) => `${n} slow`, groupHealthy: (up, total) => `${up}/${total} operational`, activeCount: (n) => `${n} active`,
    showMore: (n) => `Show ${n} more`,
    groupNames: (names, n) => (n <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${n - 2} more`),
    notChecked: 'Not checked yet.', noTargets: 'No public targets configured.', noDocker: 'No Docker data.', noRemote: 'No remote agent data.',
    noHeartbeats: 'No heartbeats configured.', noDelivery: 'No alert delivery data.', noCerts: 'No certificate data yet.', noDomains: 'No domain data yet.',
    noGateway: 'No gateway data yet.', noUsage: 'No usage windows reported.',
    historyLabel: '24 hour status history', barUp: 'All checks passed', barDown: 'At least one check failed', barNone: 'No data',
    response: 'response', noResponse: 'no response', days: (n) => `${n} d`, observedDays: (n) => `${n} d observed`, hours24: '24 h',
    windowTip: (pct, seen, total) => `${pct} (${seen}/${total} d observed)`,
    operational: 'Operational', degraded: 'Degraded', unavailable: 'Unavailable', running: 'Running', stopped: 'Stopped', down: 'Down',
    onTime: 'On time', late: 'Late', verified: 'Verified', unverified: 'Unverified', off: 'Off', serving: 'Serving',
    mapped: 'Mapped', paused: 'Paused', missing: 'Missing', drift: 'Drift', stale: 'Stale', relogin: 'Re-login', expired: 'Expired',
    usedUp: 'Used up', valid: 'Valid', invalid: 'Invalid', answered: 'Answered', failed: 'Failed',
    tagSwarm: 'swarm', tagContainer: 'container', tagHost: 'host', tagListener: 'listener', tagAlias: 'alias', tagMirror: 'mirror', tagLogin: 'login',
    every: (n, unit) => `every ${n} ${unit === 'h' ? 'h' : 'min'}`,
    agentSilent: (ago) => `Agent has not checked in · last report ${ago}`,
    used: (n) => `${n}% used`, remaining: (n) => `${n}% remaining`, daysRemaining: (n) => `${n} days remaining`, unknownDays: 'n/a',
    certificate: 'certificate', validUntil: (date) => `until ${date}`, checkFailed: 'check failed', expires: (date) => `expires ${date}`, expiryUnpublished: 'expiry not published',
    webhookMissing: 'Webhook not configured', lastFailed: (err) => `Last attempt failed · ${err}`, verifiedAt: (date) => `Verified ${date}`, notVerified: 'Delivery not verified',
    incidentAlerts: 'Incident alerts', alerts: (id) => `${id} alerts`,
    notMonitored: 'Not monitored', disabledInHosts: 'Disabled in hosts.json', over24h: (pct) => `${pct} over 24 h`,
    accountHidden: 'account hidden', refreshed: (ago) => `refreshed ${ago}`, codexCredential: 'Codex credential', inferenceProbe: 'Inference probe', every30: 'every 30 min',
    hostTelemetry: 'Host telemetry', agentLast: (agent, ago) => `${agent} agent last reported ${ago}`, agentNever: (agent) => `${agent} agent has not reported`,
    gatewayHost: 'Gateway host', hostOff: 'Gateway host · off', hostDrift: 'Gateway host · config drift',
    policy: (rev) => `Policy ${rev}`, policyUnknown: 'Policy unknown', hostCount: (n) => `${n} ${n === 1 ? 'host' : 'hosts'}`, onePerHost: 'one gateway per host',
    resets: (date, until) => `Resets ${date} · ${until}`,
    usageRead: (ago) => `Read ${ago} via the codex app-server, without spending quota.`, usageNever: 'Usage has not been read yet.', telemetryStale: 'Telemetry stale · ', limitReached: 'Rate limit reached.',
    weeklyWindow: 'Weekly window', dayWindow: (n) => `${n}-day window`, hourWindow: (n) => `${n}-hour window`, minuteWindow: (n) => `${n}-minute window`,
    agentOffline: (host) => `${host} · agent offline`, agentOfflineDetail: (ago, n) => `Last report ${ago}; ${n} monitored items unknown`,
    tlsCert: (host) => `${host} · TLS certificate`, domainReg: (domain) => `${domain} · domain registration`, expiresIn: (n) => `Expires in ${n} days`,
    incidentDelivery: 'Incident alert delivery', alertDelivery: (id) => `${id} alert delivery`, deliveryUnverified: 'Delivery has not been verified',
    slowFallback: 'Degraded', needsReview: 'Needs review',
  },
};

const LANG_KEY = 'sky-status-lang';
const storedLang = store.get(LANG_KEY);
// A choice made with the toggle wins; otherwise the server picked <html lang> from Accept-Language.
let lang = storedLang === 'en' || storedLang === ZH ? storedLang : (document.documentElement.lang === 'en' ? 'en' : ZH);
const t = (key, ...args) => {
  const value = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  return typeof value === 'function' ? value(...args) : value;
};
const locale = () => (lang === 'en' ? 'en' : 'zh-TW');
const number = (value) => new Intl.NumberFormat(locale()).format(Number(value || 0));
const timeOfDay = (at) => new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', hour12: false });
const dateTime = (at) => new Date(at).toLocaleString(locale());
const localTimes = (text) => String(text || '').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, (stamp) => dateTime(stamp));

function applyStaticText() {
  document.documentElement.lang = lang;
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll('[data-i18n-aria]')) element.setAttribute('aria-label', t(element.dataset.i18nAria));
  for (const element of document.querySelectorAll('[data-i18n-title]')) element.title = t(element.dataset.i18nTitle);
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('description'));
  // The toggle names the *other* language, in that language.
  const other = lang === 'en' ? ZH : 'en';
  const button = $('lang-toggle');
  button.textContent = STRINGS[other].langButton;
  button.lang = other;
  button.setAttribute('aria-label', STRINGS[other].langSwitch);
  button.title = STRINGS[other].langSwitch;
}

// ---------- theme ----------
const theme = {
  key: 'sky-status-theme',
  resolve() {
    const stored = store.get(this.key);
    return stored === 'light' || stored === 'dark' ? stored : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  },
  apply(value) { document.documentElement.dataset.theme = value; },
  toggle() {
    const next = this.resolve() === 'dark' ? 'light' : 'dark';
    store.set(this.key, next);
    this.apply(next);
  },
};
theme.apply(theme.resolve());
$('theme-toggle').addEventListener('click', () => theme.toggle());

// ---------- time helpers ----------
function ago(at) {
  const ms = Date.now() - Date.parse(at || '');
  if (!Number.isFinite(ms)) return t('never');
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 45) return t('justNow');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('minutesAgo', minutes);
  const hours = Math.round(minutes / 60);
  return hours < 48 ? t('hoursAgo', hours) : t('daysAgo', Math.round(hours / 24));
}

function until(at) {
  const ms = Date.parse(at || '') - Date.now();
  if (!Number.isFinite(ms)) return '';
  const hours = Math.max(0, ms / HOUR);
  return hours >= 24 ? t('inDays', Math.floor(hours / 24), Math.round(hours % 24)) : hours >= 1 ? t('inHours', hours.toFixed(1)) : t('inMinutes', Math.round(hours * 60));
}

function duration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 60 ? t('durMinutes', minutes) : t('durHours', Math.floor(minutes / 60), minutes % 60);
}

function freshness(receivedAt) {
  return receivedAt && Date.now() - new Date(receivedAt).getTime() < 180_000;
}

function pct(value) {
  if (value == null) return '—';
  // Never round a window with any downtime up to 100%.
  return value >= 100 ? '100%' : `${(Math.floor(value * 100) / 100).toFixed(2)}%`;
}

// ---------- status helpers ----------
// One state vocabulary for colour: ok / warn / down / off. The label says what kind of OK.
const STATE_CLASS = { ok: '', warn: 'warn', down: 'down', off: 'off' };
const toState = (up) => (up === null ? 'off' : up === 'warn' ? 'warn' : up ? 'ok' : 'down');

function pill(state, label) {
  return `<span class="pill ${STATE_CLASS[state] ?? ''}">${esc(label)}</span>`;
}

function remoteItems(agents) {
  return Object.entries(agents || {}).flatMap(([id, agent]) => (agent.items || []).map((item) => ({
    ...item,
    id: `${id}:${item.id}`,
    host: agent.host || id,
    fresh: Boolean(freshness(agent.receivedAt)),
    receivedAt: agent.receivedAt,
    up: Boolean(freshness(agent.receivedAt) && item.up),
    detail: freshness(agent.receivedAt) ? item.detail : t('agentSilent', ago(agent.receivedAt)),
  })));
}

// Toggle state survives a re-render: remember which <details> and "show more" lists are open.
const openDetails = new Set();
const expandedLists = new Set();
document.addEventListener('toggle', (event) => {
  if (event.target.tagName === 'DETAILS' && event.target.id) event.target.open ? openDetails.add(event.target.id) : openDetails.delete(event.target.id);
}, true);
document.addEventListener('click', (event) => {
  const button = event.target.closest('button.more');
  if (!button) return;
  const list = button.parentElement;
  expandedLists.add(list.id);
  list.querySelectorAll('.is-hidden').forEach((element) => element.classList.remove('is-hidden'));
  button.remove();
});

function collapse(id, items, limit) {
  const collapsed = !expandedLists.has(id) && items.length > limit + 1;
  const html = items.map((item, index) => (collapsed && index >= limit ? item.replace('class="', 'class="is-hidden ') : item)).join('');
  return html + (collapsed ? `<button class="more" type="button">${esc(t('showMore', items.length - limit))}</button>` : '');
}

function renderList(id, rows, emptyText) {
  const list = $(id);
  list.innerHTML = rows.length ? collapse(id, rows, LIST_LIMIT) : `<div class="empty">${esc(emptyText)}</div>`;
}

// ---------- 24h history ----------
function historyFor(id, history) {
  const entry = history?.[id];
  if (!entry) return { bars: new Array(BINS).fill('empty'), uptime: null };
  const bars = entry.bars.split('').map((state) => (state === '2' ? 'down' : state === '1' ? 'up' : 'empty'));
  return { bars, uptime: entry.uptime };
}

// Start of the current failing run, from the 30-minute bins (anchored at the server's check time).
function failingSince(id, history, anchor) {
  const bars = history?.[id]?.bars;
  if (!bars || bars.at(-1) !== '2') return null;
  let index = bars.length;
  while (index > 0 && bars[index - 1] === '2') index -= 1;
  return { at: anchor - 24 * HOUR + index * BIN_MS, whole: index === 0, approx: true };
}

function sinceText(since, now = Date.now()) {
  if (!since) return '';
  if (since.whole) return t('sinceOver24h');
  return t('since', timeOfDay(since.at), duration(now - since.at), since.approx);
}

function barsHtml(bars, anchor) {
  const start = anchor - 24 * HOUR;
  const label = { up: t('barUp'), down: t('barDown'), empty: t('barNone') };
  return `<div class="bars" role="img" aria-label="${esc(t('historyLabel'))}">${bars.map((status, index) => {
    const from = start + index * BIN_MS;
    return `<i class="${status}" title="${timeOfDay(from)}–${timeOfDay(from + BIN_MS)} · ${esc(label[status])}"></i>`;
  }).join('')}</div>`;
}

// ---------- products ----------
function statusLabel(target) {
  if (!target.up) return { state: 'down', text: t('unavailable') };
  if (target.degraded) return { state: 'warn', text: t('degraded') };
  return { state: 'ok', text: t('operational') };
}

function slaSummary(target, data) {
  const history = historyFor(target.id, data.history24h);
  const day = history.uptime === null ? '—' : pct(history.uptime);
  const windows = (data.uptime || {})[target.id] || {};
  const preferred = windows.d30?.uptime != null ? windows.d30 : windows.d7;
  const long = preferred?.uptime != null ? pct(preferred.uptime) : null;
  const label = preferred?.complete ? t('days', preferred.windowDays) : t('observedDays', preferred?.observedDays || 0);
  const windowTip = (window) => (window?.uptime == null ? '—' : t('windowTip', pct(window.uptime), window.observedDays || 0, window.windowDays || 0));
  const tip = `24 h ${day} · 7 d ${windowTip(windows.d7)} · 30 d ${windowTip(windows.d30)} · 90 d ${windowTip(windows.d90)}`;
  return { bars: history.bars, value: long || day, label: long ? label : t('hours24'), tip };
}

function monitorRow(target, data, ctx) {
  const sla = slaSummary(target, data);
  const label = statusLabel(target);
  const sub = target.degraded && target.degradedReason
    ? target.degradedReason
    : target.statusCode ? `HTTP ${target.statusCode} · ${target.detail || 'OK'}` : (target.detail || '—');
  // A failed connection's latency is just the timeout; don't present it as a response time.
  const latency = !target.up && !target.statusCode
    ? `<strong>—</strong><span>${esc(t('noResponse'))}</span>`
    : `<strong>${number(target.latencyMs)} ms</strong><span>${esc(t('response'))}</span>`;
  return `<article class="monitor">
    <div class="monitor-name"><a href="${esc(target.url)}" rel="noopener">${esc(target.name)}</a><span title="${esc(sub)}">${esc(sub)}</span></div>
    ${barsHtml(sla.bars, ctx.anchor)}
    <div class="metric latency">${latency}</div>
    <div class="metric uptime" title="${esc(sla.tip)}"><strong>${esc(sla.value)}</strong><span>${esc(sla.label)}</span></div>
    ${pill(label.state, label.text)}
  </article>`;
}

function renderProducts(data, ctx) {
  const targets = data.targets;
  const groups = [...new Set(targets.map((target) => target.group || 'Other'))];
  $('product-list').innerHTML = groups.map((group) => {
    const members = targets.filter((target) => (target.group || 'Other') === group);
    const healthy = members.filter((target) => target.up && !target.degraded).length;
    const title = groups.length > 1 ? `<div class="group-title"><span>${esc(group)}</span><b>${esc(t('groupHealthy', healthy, members.length))}</b></div>` : '';
    return title + members.map((target) => monitorRow(target, data, ctx)).join('');
  }).join('') || `<div class="empty">${esc(ctx.checked ? t('noTargets') : t('notChecked'))}</div>`;
}

// ---------- generic rows ----------
function meterHtml(detail) {
  const match = /(\d{1,3})%\s*used/.exec(detail || '');
  if (!match) return '';
  const value = Math.min(100, Number(match[1]));
  const level = value >= 90 ? 'bad' : value >= 75 ? 'warn' : '';
  return `<i class="meter" title="${esc(t('used', value))}"><b class="${level}" style="width:${value}%"></b></i>`;
}

function row(name, sub, up, label, options = {}) {
  const tag = options.tag ? `<em class="tag">${esc(options.tag)}</em>` : '';
  return `<div class="row"><div><strong>${esc(name)}</strong><span title="${esc(sub)}">${tag}${esc(sub)}</span></div><div class="row-right">${options.meter || ''}${pill(toState(up), label)}</div></div>`;
}

function setCount(id, up, total, level = 'bad') {
  const element = $(id);
  element.textContent = `${up}/${total}`;
  element.classList.remove('bad', 'warn');
  if (up < total) element.classList.add(level);
}

function renderInfrastructure(data, remote, ctx) {
  const services = [...data.services].sort((a, b) => Number(a.up) - Number(b.up) || a.name.localeCompare(b.name));
  renderList('docker-list', services.map((item) => row(item.name, item.detail, item.stopped ? null : item.up, item.stopped ? t('stopped') : item.up ? t('running') : t('down'), { tag: item.kind === 'Swarm service' ? t('tagSwarm') : t('tagContainer') })), ctx.checked ? t('noDocker') : t('notChecked'));
  const hosts = [...new Set(remote.map((item) => item.host))];
  const rows = hosts.flatMap((host) => {
    const items = remote.filter((item) => item.host === host).sort((a, b) => Number(a.up) - Number(b.up));
    const healthy = items.filter((item) => item.up).length;
    return [
      `<div class="group-title"><span>${esc(host)}</span><b>${healthy}/${items.length}</b></div>`,
      ...items.map((item) => row(item.name, item.detail, item.up, item.up ? t('running') : t('down'), { tag: item.kind === 'Host metric' ? t('tagHost') : null, meter: item.kind === 'Host metric' ? meterHtml(item.detail) : '' })),
    ];
  });
  renderList('remote-list', rows, ctx.checked ? t('noRemote') : t('notChecked'));
  setCount('docker-total', services.filter((item) => item.up).length, services.length);
  setCount('remote-total', remote.filter((item) => item.up).length, remote.length);
}

function expiryRow(name, sub, days, known, warnDays, scaleDays) {
  const danger = Math.ceil(warnDays / 3);
  const level = !known ? 'unknown' : days <= danger ? 'bad' : days <= warnDays ? 'warn' : '';
  const meter = known ? `<i class="meter" title="${esc(t('daysRemaining', days))}"><b class="${level}" style="width:${Math.max(3, Math.min(100, (days / scaleDays) * 100))}%"></b></i>` : '';
  return `<div class="row"><div><strong>${esc(name)}</strong><span title="${esc(sub)}">${esc(sub)}</span></div><div class="row-right">${meter}<b class="days ${level}">${known ? esc(t('days', number(days))) : esc(t('unknownDays'))}</b></div></div>`;
}

function expiryCount(id, items, warnDays) {
  const known = items.filter((item) => item.ok && item.daysRemaining != null);
  const urgent = known.some((item) => item.daysRemaining <= Math.ceil(warnDays / 3));
  setCount(id, known.filter((item) => item.daysRemaining > warnDays).length, items.length, urgent ? 'bad' : 'warn');
}

function renderCertificates(data, ctx) {
  const certWarn = data.thresholds?.certWarnDays ?? 21;
  const domainWarn = data.thresholds?.domainWarnDays ?? 30;
  const byUrgency = (a, b) => (a.ok && a.daysRemaining != null ? a.daysRemaining : Infinity) - (b.ok && b.daysRemaining != null ? b.daysRemaining : Infinity);
  const certs = [...(data.certificates || [])].sort(byUrgency);
  const domains = [...(data.domains || [])].sort(byUrgency);
  renderList('cert-list', certs.map((c) => expiryRow(
    c.host,
    c.ok ? `${c.issuer || t('certificate')} · ${t('validUntil', c.validTo || '')}` : (c.error || t('checkFailed')),
    c.daysRemaining, c.ok && c.daysRemaining != null, certWarn, 90,
  )), ctx.checked ? t('noCerts') : t('notChecked'));
  renderList('domain-list', domains.map((d) => expiryRow(
    d.domain,
    d.ok ? t('expires', d.expiryDate || '') : (d.supported === false ? t('expiryUnpublished') : (d.error || t('checkFailed'))),
    d.daysRemaining, d.ok && d.daysRemaining != null, domainWarn, 365,
  )), ctx.checked ? t('noDomains') : t('notChecked'));
  expiryCount('cert-total', certs, certWarn);
  expiryCount('domain-total', domains, domainWarn);
}

function deliveryOk(status) {
  const success = Date.parse(status?.lastSuccessAt || '');
  const failure = Date.parse(status?.lastFailureAt || '');
  return Boolean(status?.configured && Number.isFinite(success) && (!Number.isFinite(failure) || success >= failure));
}

function renderJobs(data) {
  const jobs = data.heartbeats || [];
  const deliveries = Object.entries(data.alertDelivery || {}).map(([id, status]) => {
    const detail = !status?.configured ? t('webhookMissing')
      : status.lastError ? t('lastFailed', status.lastError)
        : status.lastSuccessAt ? t('verifiedAt', dateTime(status.lastSuccessAt)) : t('notVerified');
    return { id, name: id === 'incident' ? t('incidentAlerts') : t('alerts', id), up: deliveryOk(status), detail };
  });
  $('jobs').hidden = jobs.length === 0 && deliveries.length === 0;
  const period = (seconds) => (seconds >= 3600 ? t('every', Math.round(seconds / 3600), 'h') : t('every', Math.round(seconds / 60), 'min'));
  renderList('jobs-list', jobs.map((job) => row(job.name, job.detail, job.up, job.up ? t('onTime') : t('late'), { tag: job.periodSeconds ? period(job.periodSeconds) : null })), t('noHeartbeats'));
  // An unverified webhook is a warning (as in the attention list), not an outage.
  renderList('delivery-list', deliveries.map((delivery) => row(delivery.name, delivery.detail, delivery.up || 'warn', delivery.up ? t('verified') : t('unverified'), { tag: 'Discord webhook' })), t('noDelivery'));
  setCount('jobs-total', jobs.filter((job) => job.up).length, jobs.length);
  setCount('delivery-total', deliveries.filter((delivery) => delivery.up).length, deliveries.length, 'warn');
}

// ---------- gateway ----------
function windowLabel(window) {
  const minutes = window.windowMinutes;
  if (!minutes) return window.label;
  if (minutes === 10_080) return t('weeklyWindow');
  if (minutes % 1_440 === 0) return t('dayWindow', minutes / 1_440);
  if (minutes % 60 === 0) return t('hourWindow', minutes / 60);
  return t('minuteWindow', minutes);
}

function gatewayHostPanel(host, history) {
  const up = host.enabled ? host.checks.filter((check) => check.up).length : 0;
  const total = host.enabled ? host.checks.length : 0;
  const rows = [];
  if (!host.enabled) {
    rows.push(row(t('notMonitored'), host.note || t('disabledInHosts'), null, t('off')));
  } else {
    for (const listener of host.listeners) {
      const uptime = listener.id === 'probe' ? historyFor(`gateway:${host.name}:probe`, history).uptime : null;
      const latency = listener.up && listener.latencyMs != null ? ` · ${number(listener.latencyMs)} ms` : ` · ${listener.detail}`;
      rows.push(row(listener.name, `${listener.source}${latency}${uptime == null ? '' : ` · ${t('over24h', pct(uptime))}`}`, listener.up, listener.up ? t('serving') : t('down'), { tag: t('tagListener') }));
    }
    for (const alias of host.aliases) {
      const label = alias.up ? t('mapped') : alias.paused ? t('paused') : alias.listed === false ? t('missing') : t('drift');
      rows.push(row(alias.alias, alias.detail, alias.listed === null && alias.configMatches === null ? null : alias.up, label, { tag: t('tagAlias') }));
    }
    for (const account of host.accounts?.list || []) {
      const stale = !host.reportFresh || !host.accounts.fresh;
      // A mirror of a rejected login is neutral here; the owning host's row is the one that needs action.
      const state = stale || (account.up && account.loginRejected) ? null : account.up;
      const badge = stale ? t('stale') : account.loginRejected ? t('relogin') : !account.up ? t('expired') : account.remainingPercent === 0 ? t('usedUp') : t('valid');
      rows.push(row(account.label, account.detail, state, badge, { tag: account.mirror === 'peer' ? t('tagMirror') : t('tagLogin') }));
    }
    if (host.credential) {
      const credential = host.credential;
      const plan = credential.plan ? `ChatGPT ${credential.plan[0].toUpperCase()}${credential.plan.slice(1)}` : 'Codex OAuth';
      const sub = credential.up ? `${plan} · ${credential.account || t('accountHidden')} · ${t('refreshed', ago(credential.lastRefreshAt))}` : credential.detail;
      rows.push(row(t('codexCredential'), sub, host.reportFresh ? credential.up : null, !host.reportFresh ? t('stale') : credential.up ? t('valid') : t('invalid')));
    }
    if (host.inference) {
      const inference = host.inference;
      const timing = inference.latencyMs != null ? ` · ${(inference.latencyMs / 1000).toFixed(1)} s` : '';
      rows.push(row(t('inferenceProbe'), `${inference.detail}${inference.up ? timing : ''} · ${ago(inference.checkedAt)} · ${t('every30')}`, inference.fresh ? inference.up : null, !inference.fresh ? t('stale') : inference.up ? t('answered') : t('failed')));
    }
    if (host.agent && !host.reportFresh) {
      rows.push(row(t('hostTelemetry'), host.reportReceivedAt ? t('agentLast', host.agent, ago(host.reportReceivedAt)) : t('agentNever', host.agent), false, t('stale')));
    }
  }
  const kicker = !host.enabled ? t('hostOff') : host.configRevisionMatches === false ? t('hostDrift') : t('gatewayHost');
  const note = host.note ? `<span class="panel-note">${esc(host.note)}</span>` : '';
  return `<article class="panel"><div class="panel-head"><div><span class="kicker">${esc(kicker)}</span><h3>${esc(host.name)}</h3>${note}</div><strong class="panel-count ${host.enabled && up < total ? 'bad' : ''}">${host.enabled ? `${up}/${total}` : esc(t('off'))}</strong></div><div class="list">${rows.join('') || `<div class="empty">${esc(t('noGateway'))}</div>`}</div></article>`;
}

function renderGateway(data) {
  const gateway = data.gateway;
  $('ai-gateway').hidden = !gateway;
  if (!gateway) return;
  const live = gateway.hosts.filter((host) => host.enabled).length;
  $('gateway-policy').textContent = `${gateway.revision ? t('policy', gateway.revision) : t('policyUnknown')} · ${t('hostCount', live)} · ${t('onePerHost')}`;
  $('gateway-hosts').innerHTML = gateway.hosts.map((host) => gatewayHostPanel(host, data.history24h)).join('');

  const usage = gateway.usage;
  $('gateway-plan').textContent = usage?.plan ? `ChatGPT ${usage.plan[0].toUpperCase()}${usage.plan.slice(1)} · Codex` : t('gatewayPlan');
  const windows = usage?.windows || [];
  $('gateway-usage-total').textContent = windows.length ? t('used', Math.max(...windows.map((window) => window.usedPercent))) : '–';
  const bars = windows.map((window) => {
    const level = window.usedPercent >= 90 ? 'danger' : window.usedPercent >= 70 ? 'warn' : '';
    const resets = window.resetsAt ? t('resets', new Date(window.resetsAt).toLocaleString(locale(), { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }), until(window.resetsAt)) : '';
    return `<div class="pool"><div class="pool-head"><strong>${esc(windowLabel(window))}</strong><b>${esc(t('used', window.usedPercent))}</b></div><div class="pool-track"><div class="pool-fill ${level}" style="width:${Math.min(100, window.usedPercent)}%"></div></div><div class="pool-foot"><span>${esc(t('remaining', 100 - window.usedPercent))}</span><span>${esc(resets)}</span></div></div>`;
  }).join('');
  const source = usage?.checkedAt ? t('usageRead', ago(usage.checkedAt)) : t('usageNever');
  const note = `<p class="gateway-note ${usage?.fresh ? '' : 'stale'}">${esc(usage?.fresh ? source : `${t('telemetryStale')}${source}`)}${usage?.limitReached ? ` ${esc(t('limitReached'))}` : ''}</p>`;
  $('gateway-usage').innerHTML = `${bars || `<div class="empty">${esc(t('noUsage'))}</div>`}${note}`;
}

// ---------- attention & hero ----------
const alertIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';
// Lower rank first: infrastructure failures are usually the cause of product failures.
const RANK = { infra: 0, product: 1, job: 2, warn: 3 };

function collectIssues(data, remote, ctx) {
  const certWarn = data.thresholds?.certWarnDays ?? 21;
  const domainWarn = data.thresholds?.domainWarnDays ?? 30;
  const since = (id) => failingSince(id, data.history24h, ctx.anchor);
  return [
    ...data.services.filter((item) => !item.up).map((item) => ({ name: item.name, detail: item.detail, level: 'down', rank: RANK.infra, href: '#infrastructure', since: since(item.id) })),
    ...remoteIssues(remote, since),
    ...(data.gateway?.checks || []).filter((check) => !check.up).map((check) => ({ name: check.name, detail: localTimes(check.detail), level: 'down', rank: RANK.infra, href: '#ai-gateway', since: since(check.id) })),
    ...data.targets.filter((item) => !item.up).map((item) => ({ name: item.name, detail: item.statusCode ? `HTTP ${item.statusCode} · ${item.detail}` : item.detail, level: 'down', rank: RANK.product, href: '#products', since: since(item.id) })),
    ...(data.heartbeats || []).filter((job) => !job.up).map((job) => ({ name: job.name, detail: job.detail, level: 'down', rank: RANK.job, href: '#jobs', since: since(job.id) })),
    ...data.targets.filter((item) => item.up && item.degraded).map((item) => ({ name: item.name, detail: item.degradedReason || t('slowFallback'), level: 'warn', kind: 'slow', rank: RANK.warn, href: '#products' })),
    ...(data.certificates || []).filter((c) => c.ok && c.daysRemaining != null && c.daysRemaining <= certWarn).map((c) => ({ name: t('tlsCert', c.host), detail: t('expiresIn', c.daysRemaining), level: 'warn', kind: 'expiry', rank: RANK.warn, href: '#certificates' })),
    ...(data.domains || []).filter((d) => d.ok && d.daysRemaining != null && d.daysRemaining <= domainWarn).map((d) => ({ name: t('domainReg', d.domain), detail: t('expiresIn', d.daysRemaining), level: 'warn', kind: 'expiry', rank: RANK.warn, href: '#certificates' })),
    ...Object.entries(data.alertDelivery || {}).filter(([, status]) => !deliveryOk(status)).map(([id, status]) => ({ name: id === 'incident' ? t('incidentDelivery') : t('alertDelivery', id), detail: status?.lastError || (status?.configured ? t('deliveryUnverified') : t('webhookMissing')), level: 'warn', kind: 'delivery', rank: RANK.warn, href: '#jobs' })),
  ].sort((a, b) => a.rank - b.rank);
}

// A silent agent is one incident, not one per item it used to report.
function remoteIssues(remote, since) {
  const issues = [];
  for (const host of [...new Set(remote.map((item) => item.host))]) {
    const items = remote.filter((item) => item.host === host);
    if (items.length && items.every((item) => !item.fresh)) {
      const at = Date.parse(items[0].receivedAt || '');
      issues.push({ name: t('agentOffline', host), detail: t('agentOfflineDetail', ago(items[0].receivedAt), items.length), level: 'down', rank: RANK.infra, href: '#infrastructure', since: Number.isFinite(at) ? { at, whole: false, approx: false } : null });
      continue;
    }
    issues.push(...items.filter((item) => !item.up).map((item) => ({ name: `${host} · ${item.name}`, detail: item.detail, level: 'down', rank: RANK.infra, href: '#infrastructure', since: since(item.id) })));
  }
  return issues;
}

// Items failing with the same error collapse into one card: five timeouts are one story.
function groupIssues(issues) {
  const groups = [];
  const byKey = new Map();
  for (const issue of issues) {
    const key = issue.level === 'down' && issue.detail ? `${issue.rank}|${issue.detail}` : null;
    const existing = key && byKey.get(key);
    if (existing) { existing.members.push(issue); continue; }
    const group = { ...issue, members: [issue] };
    if (key) byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}

function earliest(members) {
  const known = members.map((member) => member.since).filter(Boolean);
  if (!known.length) return null;
  return known.reduce((first, since) => (since.whole || since.at < first.at ? since : first));
}

function alertCard(group, index) {
  const cls = `alert ${group.level === 'warn' ? 'warn' : ''}`;
  const since = sinceText(group.members.length > 1 ? earliest(group.members) : group.since);
  const sinceHtml = since ? `<span class="since num">${esc(since)}</span>` : '';
  if (group.members.length === 1) {
    return `<a class="${cls}" href="${esc(group.href || '#')}">${alertIcon}<div><strong>${esc(group.name)}</strong><span class="alert-detail">${esc(group.detail || t('needsReview'))}</span></div>${sinceHtml}</a>`;
  }
  const id = `attention-group-${index}`;
  const names = group.members.map((member) => member.name);
  const members = group.members.map((member) => {
    const memberSince = sinceText(member.since);
    return `<li><a href="${esc(member.href || '#')}">${esc(member.name)}</a>${memberSince ? `<span class="num">${esc(memberSince)}</span>` : ''}</li>`;
  }).join('');
  return `<details class="${cls} alert-group" id="${id}"${openDetails.has(id) ? ' open' : ''}><summary>${alertIcon}<div><strong>${esc(t('groupNames', names, names.length))}</strong><span class="alert-detail">${esc(group.detail)}</span></div>${sinceHtml}</summary><ul class="alert-members">${members}</ul></details>`;
}

function renderAttention(issues) {
  const groups = groupIssues(issues);
  $('attention-section').hidden = issues.length === 0;
  $('attention-count').textContent = t('activeCount', issues.length);
  $('attention').innerHTML = collapse('attention', groups.map(alertCard), ATTENTION_LIMIT);
}

function tile(id, { up, total, slow = 0 }) {
  const slowNote = slow ? ` · ${esc(t('slowCount', slow))}` : '';
  $(`summary-${id}`).innerHTML = total ? `${up}<small> / ${total}${slowNote}</small>` : '–';
  const meter = $(`meter-${id}`);
  meter.style.width = `${total ? Math.max(2, (up / total) * 100) : 0}%`;
  // Coloured by the worst member, not by the ratio: one product down is red.
  meter.className = up < total ? 'bad' : slow ? 'warn' : '';
}

let lastCheckedAt = null;
let lastData = null;

function renderClock() {
  const dot = $('last-check').querySelector('.live-dot');
  const label = $('last-check').lastElementChild;
  label.removeAttribute('data-i18n');
  if (!lastCheckedAt) {
    dot.classList.add('pending');
    label.textContent = lastData ? t('pendingTitle') : t('loading');
    return;
  }
  dot.classList.remove('pending');
  dot.classList.toggle('stale', Date.now() - Date.parse(lastCheckedAt) > 3 * 60_000);
  label.textContent = t('updated', ago(lastCheckedAt));
  const time = $('state-time');
  time.textContent = t('checked', ago(lastCheckedAt));
  time.title = dateTime(lastCheckedAt);
}

function setHero(state, title, detail) {
  const hero = $('global-state');
  hero.classList.remove('down', 'warn', 'maintenance', 'offline', 'pending');
  if (state) hero.classList.add(state);
  $('global-title').textContent = title;
  $('global-detail').textContent = detail;
  document.title = `${title} · Sky Status`;
}

function warnSummary(warn) {
  const count = (kind) => warn.filter((issue) => issue.kind === kind).length;
  const other = warn.filter((issue) => !['slow', 'expiry', 'delivery'].includes(issue.kind)).length;
  const parts = [
    count('slow') && t('warnSlow', count('slow')),
    count('expiry') && t('warnExpiry', count('expiry')),
    count('delivery') && t('warnDelivery', count('delivery')),
    other && t('warnOther', other),
  ].filter(Boolean);
  return `${t('list', parts)}${t('warnTail')}`;
}

function renderGlobal(data, remote, issues, ctx) {
  const down = issues.filter((issue) => issue.level === 'down');
  const warn = issues.filter((issue) => issue.level === 'warn');
  if (!ctx.checked) {
    setHero('pending', t('pendingTitle'), t('pendingDetail'));
  } else if (data.maintenance) {
    setHero('maintenance', t('maintenanceTitle'), data.maintenance.reason || t('maintenanceDetail'));
  } else if (down.filter((issue) => issue.rank === RANK.product).length >= 3) {
    // Major: several public products are unreachable, not one product plus its own container.
    setHero('down', t('majorTitle'), `${t('nDown', down.length)}${warn.length ? ` ${t('alsoWarn', warn.length)}` : ''}`);
  } else if (down.length) {
    setHero('down', t('partialTitle'), `${t('namesDown', down.map((issue) => issue.name))}${lang === 'en' ? '. ' : '；'}${warn.length ? t('alsoWarn', warn.length) : t('restOk')}`);
  } else if (warn.length) {
    setHero('warn', t('warnTitle'), warnSummary(warn));
  } else {
    setHero('', t('okTitle'), t('okDetail'));
  }
  $('state-time').hidden = !ctx.checked;
  lastCheckedAt = ctx.checked ? data.checkedAt : null;
  renderClock();
  const gatewayChecks = data.gateway?.checks || [];
  tile('public', { up: data.targets.filter((item) => item.up).length, total: data.targets.length, slow: data.targets.filter((item) => item.up && item.degraded).length });
  tile('docker', { up: data.services.filter((item) => item.up).length, total: data.services.length });
  tile('remote', { up: remote.filter((item) => item.up).length, total: remote.length });
  tile('gateway', { up: gatewayChecks.filter((check) => check.up).length, total: gatewayChecks.length });
}

// ---------- nav ----------
const navLinks = [...document.querySelectorAll('.site-nav a')];
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    navLinks.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${entry.target.id}`));
  }
}, { rootMargin: '-30% 0px -60% 0px' });
navLinks.forEach((link) => { const section = document.querySelector(link.getAttribute('href')); if (section) observer.observe(section); });

// Hide links to sections that are not rendered, and mark each with its worst open issue.
function renderNav(issues) {
  for (const link of navLinks) {
    const href = link.getAttribute('href');
    link.hidden = Boolean(document.querySelector(href)?.hidden);
    const related = issues.filter((issue) => issue.href === href);
    const state = related.some((issue) => issue.level === 'down') ? 'down' : related.length ? 'warn' : '';
    if (state) link.dataset.state = state; else delete link.dataset.state;
  }
}

// ---------- load ----------
function render(data) {
  const checkedAt = Date.parse(data.checkedAt || '');
  const ctx = { checked: Number.isFinite(checkedAt) && checkedAt > 0, anchor: Number.isFinite(checkedAt) && checkedAt > 0 ? checkedAt : Date.now() };
  const remote = remoteItems(data.agents);
  renderProducts(data, ctx);
  renderInfrastructure(data, remote, ctx);
  renderJobs(data);
  renderCertificates(data, ctx);
  renderGateway(data);
  const issues = collectIssues(data, remote, ctx);
  renderAttention(issues);
  renderGlobal(data, remote, issues, ctx);
  renderNav(issues);
}

async function load() {
  const response = await fetch('/api/status', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Status API returned ${response.status}`);
  lastData = await response.json();
  render(lastData);
  $('last-check').querySelector('.live-dot').classList.remove('offline');
}

function offline() {
  if (!lastData) setHero('offline', t('offlineTitle'), t('offlineDetail'));
  $('last-check').querySelector('.live-dot').classList.add('offline');
}

$('lang-toggle').addEventListener('click', () => {
  lang = lang === 'en' ? ZH : 'en';
  store.set(LANG_KEY, lang);
  applyStaticText();
  if (lastData) render(lastData); else if ($('global-state').classList.contains('offline')) offline();
});
applyStaticText();

// Poll once a minute while the tab is visible; a hidden tab stops polling and
// refreshes immediately when it comes back.
let pollTimer = null;
let inflight = null;
function refresh() {
  inflight ||= load().catch(offline).finally(() => { inflight = null; });
  return inflight;
}
function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}
function schedule() {
  stopPolling();
  if (document.hidden) return;
  pollTimer = setTimeout(() => refresh().then(schedule), POLL_MS);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPolling();
  else refresh().then(schedule);
});
refresh().then(schedule);
setInterval(() => { if (!document.hidden) renderClock(); }, 15_000);
