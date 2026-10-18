// Vercel version of the dashboard. The browser polls /api/blocks, applies the watchlist itself,
// and keeps the watchlist and alerts in localStorage (each viewer has their own).
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const ethFmt = (v) => `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 6 })} ETH`;
const timeFmt = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : '');
const txLink = (h) => `<a class="mono" href="https://sepolia.etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener">${esc(short(h))}</a>`;
const REASON = { sanctions: 'Sanctions match', watchlist: 'Watchlist' };
const STATUS = { open: 'Open', reviewed: 'Reviewed', escalated: 'Escalated', false_positive: 'False positive' };
const KIND = { 'top-level': 'Top-level', internal: 'Internal' };
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const POLL_MS = 6000;
const HIDDEN_POLL_MS = 30000;
const MAX_FEED = 500;
const MAX_ALERTS = 500;
const STORE_KEY = 'eth-flow-monitor:v1';

// ---------- per-viewer storage ----------
function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (s && Array.isArray(s.watch) && Array.isArray(s.alerts)) return s;
  } catch { /* storage unavailable or corrupt: start fresh */ }
  return freshStore();
}
function freshStore() {
  return { watch: [], alerts: [], nextId: 1, demoSeeded: false, introDismissed: false };
}
const store = loadStore();
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* private mode: keep in memory only */ }
}

// ---------- helpers ----------
async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

function toWei(eth) {
  const s = String(eth ?? '').trim();
  if (!s) return 0n;
  if (!/^\d*(\.\d{0,18})?$/.test(s) || s === '.') throw new Error(`Minimum must be a number of ETH: ${s}`);
  const [i, f = ''] = s.split('.');
  return BigInt(i || '0') * 10n ** 18n + BigInt(f.padEnd(18, '0'));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function downloadCsv(filename, header, rows) {
  const cell = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const text = [header, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const transferCsvRows = (list) => list.map((t) => [
  t.block_number, t.timestamp ? new Date(t.timestamp * 1000).toISOString() : '', t.tx_hash, t.log_index,
  t.from_addr, t.to_addr, t.value_eth, t.value_wei, t.kind,
]);
const TRANSFER_CSV_HEADER = ['block_number', 'timestamp_utc', 'tx_hash', 'log_index', 'from', 'to', 'value_eth', 'value_wei', 'kind'];

// ---------- live data ----------
const feed = [];
const seen = new Set();
const session = { transfers: 0, internal: 0, since: Date.now() };
let nextBlock = null;
let lastBlock = null;

function watchMatches(t) {
  const out = [];
  for (const side of new Set([t.from_addr, t.to_addr])) {
    const w = store.watch.find((x) => x.address === side);
    if (w && BigInt(t.value_wei) >= BigInt(w.min_wei)) {
      out.push({ reason: 'watchlist', matchedAddress: side, matchedEntry: w.label || side, listVersion: null });
    }
  }
  return out;
}

/** Records an alert for each sanctions or watchlist match on transfer t. */
function raiseAlerts(t) {
  const raised = [];
  for (const m of [...t.matches, ...watchMatches(t)]) {
    const a = {
      id: store.nextId++, reason: m.reason, matched_address: m.matchedAddress, matched_entry: m.matchedEntry,
      list_version: m.listVersion, status: 'open', note: '', created_at: Math.floor(Date.now() / 1000),
      tx_hash: t.tx_hash, block_number: t.block_number, from_addr: t.from_addr, to_addr: t.to_addr,
      value_wei: t.value_wei, value_eth: t.value_eth, kind: t.kind, timestamp: t.timestamp,
    };
    store.alerts.unshift(a);
    raised.push(a);
  }
  return raised;
}

// First-visit demo: watch the address that received the most ETH transfers in the latest blocks,
// so a visitor sees real watchlist alerts within seconds without setting anything up.
const DEMO_LABEL = 'Demo: most active address (auto-added)';
function seedDemo(transfers) {
  const counts = new Map();
  for (const t of transfers) counts.set(t.to_addr, (counts.get(t.to_addr) ?? 0) + 1);
  const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!busiest) return false;
  addWatch(busiest[0], DEMO_LABEL, '');
  store.demoSeeded = true;
  save();
  return true;
}

function resetDemo() {
  Object.assign(store, freshStore());
  // Seed from what this page has already seen, so alerts show up straight away.
  if (seedDemo(feed)) {
    for (const t of [...feed].reverse()) raiseAlerts(t);
    if (store.alerts.length > MAX_ALERTS) store.alerts.length = MAX_ALERTS;
  }
  selectedId = null;
  alertFilter = '';
  save();
  live.textContent = 'Demo reset: watchlist and alerts cleared, and a busy address added to the watchlist again.';
}

function ingest(transfers) {
  if (!store.demoSeeded && transfers.length) seedDemo(transfers);
  const fresh = [];
  const newAlerts = [];
  for (const t of transfers) {
    const key = `${t.tx_hash}:${t.log_index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(t);
    feed.unshift(t);
    session.transfers++;
    if (t.kind === 'internal') session.internal++;
    newAlerts.push(...raiseAlerts(t));
  }
  if (feed.length > MAX_FEED) feed.length = MAX_FEED;
  if (store.alerts.length > MAX_ALERTS) store.alerts.length = MAX_ALERTS;
  if (newAlerts.length) save();
  return { fresh, newAlerts };
}

async function poll() {
  let delay = document.hidden ? HIDDEN_POLL_MS : POLL_MS;
  try {
    const r = await getJson(`/api/blocks${nextBlock === null ? '' : `?from=${nextBlock}`}`);
    nextBlock = r.toBlock + 1;
    if (r.toBlock >= r.fromBlock) lastBlock = r.toBlock;
    $('#net').textContent = `Network: Sepolia (live) · block ${lastBlock ?? r.safeHead}`;
    const { fresh, newAlerts } = ingest(r.transfers);
    if (r.skipped) live.textContent = `Skipped ${r.skipped} blocks while this tab was in the background.`;
    if (newAlerts.length) {
      const a = newAlerts[0];
      live.textContent = `New alert: ${REASON[a.reason]}, ${a.matched_entry}, ${ethFmt(a.value_eth)}${newAlerts.length > 1 ? ` (+${newAlerts.length - 1} more)` : ''}.`;
    }
    onData(fresh);
    if (r.toBlock < r.safeHead) delay = 500; // still catching up
  } catch (e) {
    live.textContent = `Could not reach Sepolia (${e.message}). Retrying…`;
  }
  setTimeout(poll, delay);
}

function onData(fresh) {
  if (current === 'alerts') refreshAlertsSoon();
  if (current !== 'feed' || !fresh.length) return;
  const body = $('#feed-rows');
  if (!body) return;
  if (body.querySelector('td[colspan]')) body.innerHTML = '';
  for (const t of fresh) if (matchesFeedFilter(t)) body.insertAdjacentHTML('afterbegin', feedRow(t));
  while (body.rows.length > 200) body.deleteRow(-1);
}

// ---------- views ----------
const main = $('#main');
const live = $('#live');
let current = 'alerts';
let alertFilter = '';
let selectedId = null;
let feedQuery = { address: '', min: '' };

const views = { alerts: renderAlerts, feed: renderFeed, watchlist: renderWatchlist, sanctions: renderSanctions, inspect: renderInspect };

function route() {
  const [name, arg] = (location.hash.slice(1) || 'alerts').split('/');
  current = views[name] ? name : 'alerts';
  document.querySelectorAll('nav a').forEach((a) => {
    if (a.getAttribute('href') === `#${current}`) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  Promise.resolve(views[current](arg ? decodeURIComponent(arg) : undefined)).catch((e) => {
    main.innerHTML = `<p class="error" role="alert">${esc(e.message)}</p>`;
  });
}

$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) location.hash = `#inspect/${q}`;
  else if (ADDR_RE.test(q)) location.hash = `#feed/${q.toLowerCase()}`;
  else live.textContent = 'Enter a 0x address (42 characters) or a transaction hash (66 characters).';
});

const tile = (label, value) => `<div class="tile"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;

// New data arrives every few seconds; batch the redraws and never wipe a note the analyst is still editing.
let refreshPending = false;
let refreshTimer;
function refreshAlertsSoon() {
  if (current !== 'alerts') return;
  const note = $('#note');
  if (note && (document.activeElement === note || note.value !== note.defaultValue)) {
    refreshPending = true;
    return;
  }
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(renderAlerts, 300);
}

function renderAlerts() {
  refreshPending = false;
  const alerts = alertFilter ? store.alerts.filter((a) => a.status === alertFilter) : store.alerts;
  const open = store.alerts.filter((a) => a.status === 'open').length;
  const hits = store.alerts.filter((a) => a.reason === 'sanctions').length;
  const options = ['', 'open', 'escalated', 'reviewed', 'false_positive']
    .map((v) => `<option value="${v}" ${v === alertFilter ? 'selected' : ''}>${v ? STATUS[v] : 'All alerts'}</option>`).join('');
  const rows = alerts.slice(0, 200).map((a) => `
    <tr tabindex="0" data-id="${a.id}" aria-selected="${a.id === selectedId}">
      <td>${esc(timeFmt(a.timestamp))}</td><td class="mono">${esc(short(a.from_addr))}</td><td class="mono">${esc(short(a.to_addr))}</td>
      <td>${esc(ethFmt(a.value_eth))}</td><td>${esc(KIND[a.kind])}</td>
      <td><span class="badge ${esc(a.reason)}">${esc(REASON[a.reason])}</span></td><td>${esc(STATUS[a.status])}</td>
    </tr>`).join('');
  const empty = store.watch.length
    ? 'No alerts yet. They appear when a watched or sanctioned address sends or receives ETH.'
    : 'No alerts yet. Tip: copy a "To" address from the Live feed into the Watchlist to see alerts arrive.';
  const intro = store.introDismissed ? '' : `
    <section class="intro" aria-labelledby="intro-title">
      <h2 id="intro-title">Welcome to the ETH Flow Monitor demo</h2>
      <p>This page reads live Sepolia blocks and shows every native ETH transfer through its new EIP-7708 log, including transfers made inside contracts.
        To show alerts straight away, it added the most active address in the latest blocks to your <a href="#watchlist">Watchlist</a>; each new transfer to or from it raises a real alert below.</p>
      <ol>
        <li>Select an alert and click <strong>Escalate</strong>, <strong>Mark reviewed</strong> or <strong>False positive</strong>.</li>
        <li>In <a href="#watchlist">Watchlist</a>, add an address of your own (any "To" address from the <a href="#feed">Live feed</a> works).</li>
        <li>In an alert, click <strong>inspect</strong> to compare the logs visible before EIP-7708 with the new ETH Transfer logs.</li>
      </ol>
      <p class="muted">Sanctions alerts: real sanctioned addresses almost never transact on a testnet, so the sanctions alert is shown live with a demo contract,
        and automated tests confirm that all 15 Lazarus Group and Garantex addresses are flagged. Everything you do here is saved only in your own browser.</p>
      <div class="actions"><button class="primary" id="dismiss-intro">Got it</button></div>
    </section>`;
  main.innerHTML = `${intro}
    <section class="tiles" aria-label="Summary">
      ${tile('Transfers seen this session', session.transfers)}${tile('Contract-internal this session', session.internal)}
      ${tile('Open alerts', open)}${tile('Sanctions hits', hits)}
    </section>
    <div class="bar"><h2>Alert queue</h2>
      <div class="actions" style="margin-top:0"><label>Show <select id="filter">${options}</select></label><button id="reset-demo">Reset demo</button></div></div>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Time</th><th>From</th><th>To</th><th>Amount</th><th>Type</th><th>Reason</th><th>Status</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="7" class="muted">${esc(empty)}</td></tr>`}</tbody>
    </table></div>
    <section id="detail" class="detail" aria-live="polite"><p class="muted">Select an alert to see its detail.</p></section>
    <p class="muted">Live from Sepolia since ${esc(new Date(session.since).toLocaleTimeString())}${lastBlock ? `; last block ${esc(lastBlock)}` : ''}. Alerts and the watchlist are saved in this browser only.</p>`;
  $('#filter').addEventListener('change', (e) => { alertFilter = e.target.value; renderAlerts(); });
  $('#reset-demo').addEventListener('click', () => { resetDemo(); renderAlerts(); });
  $('#dismiss-intro')?.addEventListener('click', () => { store.introDismissed = true; save(); renderAlerts(); });
  main.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
    const openRow = () => {
      selectedId = Number(tr.dataset.id);
      main.querySelectorAll('tbody tr').forEach((r) => r.setAttribute('aria-selected', String(r === tr)));
      showDetail(store.alerts.find((a) => a.id === selectedId));
    };
    tr.addEventListener('click', openRow);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openRow(); } });
  });
  const selected = store.alerts.find((a) => a.id === selectedId);
  if (selected) showDetail(selected);
}

function showDetail(a) {
  const d = $('#detail');
  d.innerHTML = `
    <h2>Alert #${a.id}: ${esc(REASON[a.reason])}</h2>
    <dl>
      <dt>From</dt><dd class="mono">${esc(a.from_addr)}</dd>
      <dt>To</dt><dd class="mono">${esc(a.to_addr)}</dd>
      <dt>Amount</dt><dd>${esc(ethFmt(a.value_eth))}</dd>
      <dt>Transfer type</dt><dd>${esc(KIND[a.kind])}${a.kind === 'internal' ? ' (made inside a contract; seen through its EIP-7708 log)' : ''}</dd>
      <dt>Transaction</dt><dd>${txLink(a.tx_hash)} · block ${esc(a.block_number)} · <a href="#inspect/${esc(a.tx_hash)}">inspect</a></dd>
      <dt>Matched</dt><dd>${esc(a.matched_entry)} <span class="mono">(${esc(a.matched_address)})</span></dd>
      ${a.list_version ? `<dt>List version</dt><dd class="mono">${esc(a.list_version)}</dd>` : ''}
      <dt>Status</dt><dd>${esc(STATUS[a.status])}</dd>
    </dl>
    <label for="note">Analyst note</label><br>
    <textarea id="note" rows="2" cols="60">${esc(a.note)}</textarea>
    <div class="actions">
      <button class="primary" data-status="escalated">Escalate</button>
      <button data-status="reviewed">Mark reviewed</button>
      <button data-status="false_positive">False positive</button>
      <button id="export-addr">Export this address (CSV)</button>
    </div>`;
  const note = $('#note');
  note.addEventListener('blur', () => { if (refreshPending && note.value === note.defaultValue) renderAlerts(); });
  d.querySelectorAll('button[data-status]').forEach((b) => b.addEventListener('click', () => {
    a.status = b.dataset.status;
    a.note = note.value;
    save();
    live.textContent = `Alert #${a.id} marked ${STATUS[a.status]}.`;
    renderAlerts();
  }));
  $('#export-addr').addEventListener('click', () => {
    const list = feed.filter((t) => t.from_addr === a.matched_address || t.to_addr === a.matched_address);
    downloadCsv(`eth-transfers-${a.matched_address.slice(0, 10)}.csv`, TRANSFER_CSV_HEADER, transferCsvRows(list));
  });
}

const feedRow = (t) => `<tr>
  <td>${esc(timeFmt(t.timestamp))}</td><td>${esc(t.block_number)}</td>
  <td class="mono">${esc(short(t.from_addr))}</td><td class="mono">${esc(short(t.to_addr))}</td>
  <td>${esc(ethFmt(t.value_eth))}</td><td>${esc(KIND[t.kind])}</td><td>${txLink(t.tx_hash)}</td></tr>`;

function matchesFeedFilter(t) {
  const a = feedQuery.address.toLowerCase();
  if (a && t.from_addr !== a && t.to_addr !== a) return false;
  if (feedQuery.min && t.value_eth < Number(feedQuery.min)) return false;
  return true;
}

function renderFeed(address) {
  if (address !== undefined) feedQuery.address = address;
  const rows = feed.filter(matchesFeedFilter).slice(0, 200);
  main.innerHTML = `
    <div class="bar"><h2>Live feed</h2><button id="export-feed">Export CSV</button></div>
    <form class="inline" id="ff">
      <label>Address<input name="address" value="${esc(feedQuery.address)}" size="44" placeholder="0x…"></label>
      <label>Minimum ETH<input name="min" value="${esc(feedQuery.min)}" size="8" inputmode="decimal"></label>
      <button>Filter</button>
    </form>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Time</th><th>Block</th><th>From</th><th>To</th><th>Amount</th><th>Type</th><th>Tx</th></tr></thead>
      <tbody id="feed-rows">${rows.map(feedRow).join('') || '<tr><td colspan="7" class="muted">Waiting for the next Sepolia block (about every 12 seconds)…</td></tr>'}</tbody>
    </table></div>
    <p class="muted">Showing ETH transfers seen since this page was opened (up to ${MAX_FEED}).</p>`;
  $('#ff').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    feedQuery = { address: String(f.get('address')).trim().toLowerCase(), min: String(f.get('min')).trim() };
    if (location.hash !== '#feed') location.hash = '#feed';
    else renderFeed();
  });
  $('#export-feed').addEventListener('click', () => downloadCsv('eth-transfers.csv', TRANSFER_CSV_HEADER, transferCsvRows(feed.filter(matchesFeedFilter))));
}

function addWatch(address, label, minEth) {
  const a = String(address ?? '').trim();
  if (!ADDR_RE.test(a)) throw new Error(`not a valid address: ${a || '(empty)'}`);
  const minWei = toWei(minEth);
  const entry = { address: a.toLowerCase(), label: String(label ?? '').trim(), min_wei: minWei.toString(), created_at: Math.floor(Date.now() / 1000) };
  store.watch = [entry, ...store.watch.filter((w) => w.address !== entry.address)];
}

function renderWatchlist() {
  main.innerHTML = `
    <h2>Watchlist</h2>
    <form class="inline" id="wf">
      <label>Address<input name="address" required size="44" placeholder="0x…"></label>
      <label>Label<input name="label" size="20"></label>
      <label>Alert at or above (ETH)<input name="min_eth" size="8" placeholder="0" inputmode="decimal"></label>
      <button class="primary">Add</button>
    </form>
    <form class="inline" id="uf">
      <label>Upload CSV (columns: address, label, min_eth)<input type="file" id="csv" accept=".csv,text/csv"></label>
      <button>Upload</button>
    </form>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Address</th><th>Label</th><th>Minimum</th><th>Added</th><th><span class="sr-only">Actions</span></th></tr></thead>
      <tbody>${store.watch.map((w) => `<tr><td class="mono">${esc(w.address)}</td><td>${esc(w.label)}</td><td>${esc(ethFmt(Number(BigInt(w.min_wei)) / 1e18))}</td>
        <td>${esc(timeFmt(w.created_at))}</td><td><button data-del="${esc(w.address)}">Remove</button></td></tr>`).join('')
        || '<tr><td colspan="5" class="muted">No watched addresses yet.</td></tr>'}</tbody>
    </table></div>
    <p class="muted">Saved in this browser only. New transfers are checked against it from now on.</p>`;
  $('#wf').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      addWatch(f.get('address'), f.get('label'), f.get('min_eth'));
      save();
      live.textContent = 'Address added to the watchlist.';
      renderWatchlist();
    } catch (err) {
      live.textContent = err.message;
    }
  });
  $('#uf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('#csv').files[0];
    if (!file) return;
    const [head, ...rows] = parseCsv(await file.text());
    const col = (name) => (head ?? []).findIndex((h) => h.trim().toLowerCase() === name);
    const [ai, li, mi] = [col('address'), col('label'), col('min_eth')];
    if (ai < 0) { live.textContent = 'The CSV needs a header row with an "address" column.'; return; }
    let added = 0;
    const errors = [];
    rows.forEach((r, i) => {
      try { addWatch(r[ai], li >= 0 ? r[li] : '', mi >= 0 ? r[mi] : ''); added++; } catch (err) { errors.push(`row ${i + 2}: ${err.message}`); }
    });
    save();
    live.textContent = `Added ${added} address(es).${errors.length ? ` Problems: ${errors.join('; ')}` : ''}`;
    renderWatchlist();
  });
  main.querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', () => {
    store.watch = store.watch.filter((w) => w.address !== b.dataset.del);
    save();
    live.textContent = 'Address removed.';
    renderWatchlist();
  }));
}

async function renderSanctions() {
  const s = await getJson('/api/sanctions');
  main.innerHTML = `
    <h2>Sanctions list</h2>
    <p>${esc(s.size)} ETH addresses: ${esc(s.ofacCount)} from the OFAC SDN list and ${esc(s.mockCount)} from the mock demo list.
      Version <span class="mono">${esc(s.version)}</span>.</p>
    <p class="muted">This hosted demo uses an OFAC snapshot downloaded ${esc(s.retrieved ?? 'at deploy time')}; it is refreshed when the demo is redeployed
      (the local version refreshes daily). OFAC says its address listings are not exhaustive, so a clean result does not prove an address is safe.</p>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Address</th><th>Name</th><th>Program</th><th>Source</th></tr></thead>
      <tbody>${s.entries.map((e) => `<tr><td class="mono">${esc(e.address)}</td><td>${esc(e.name)}</td><td>${esc(e.program)}</td>
        <td>${e.source === 'mock' ? 'Mock (demo)' : 'OFAC SDN'}</td></tr>`).join('')}</tbody>
    </table></div>`;
}

async function renderInspect(hash) {
  main.innerHTML = `
    <h2>Tx inspector</h2>
    <p class="muted">Compare what a log-based tool could see before EIP-7708 with the ETH Transfer logs that Glamsterdam adds.</p>
    <form class="inline" id="if">
      <label>Transaction hash<input name="tx" size="70" value="${esc(hash ?? '')}" placeholder="0x…" required></label>
      <button class="primary">Inspect</button>
    </form>
    <div id="ir">${hash ? '' : '<p class="muted">Tip: open any transaction from the Live feed or an alert and choose "inspect".</p>'}</div>`;
  $('#if').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#inspect/${String(new FormData(e.target).get('tx')).trim()}`;
  });
  if (!hash) return;
  const r = $('#ir');
  r.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const d = await getJson(`/api/inspect?tx=${encodeURIComponent(hash)}`);
    const before = d.visibleBefore.length
      ? `<ul>${d.visibleBefore.map((l) => `<li><span class="mono">${esc(short(l.address))}</span> log #${esc(l.logIndex)}</li>`).join('')}</ul>`
      : '<p>No logs. Any ETH this transaction moved inside contracts left no record a log-based tool could read.</p>';
    const after = d.ethTransfers.length
      ? `<ul>${d.ethTransfers.map((t) => `<li><span class="mono">${esc(short(t.from))} → ${esc(short(t.to))}</span>: ${esc(ethFmt(t.valueEth))} (log #${esc(t.logIndex)})</li>`).join('')}</ul>`
      : '<p>This transaction moved no ETH.</p>';
    r.innerHTML = `
      <div class="cols">
        <section class="detail"><h2>Before 7708: other logs (${d.visibleBefore.length})</h2>${before}</section>
        <section class="detail"><h2>With 7708: ETH Transfer logs (${d.ethTransfers.length})</h2>${after}</section>
      </div>
      <p>${txLink(d.txHash)}</p>`;
  } catch (e) {
    r.innerHTML = `<p class="error" role="alert">${esc(e.message)}</p>`;
  }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && current === 'alerts') refreshAlertsSoon(); });
window.addEventListener('hashchange', route);
route();
poll();
