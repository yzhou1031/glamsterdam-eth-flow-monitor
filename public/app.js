const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const ethFmt = (v) => `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 6 })} ETH`;
const timeFmt = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : '');
const txLink = (h) => `<a class="mono" href="https://sepolia.etherscan.io/tx/${esc(h)}" target="_blank" rel="noopener">${esc(short(h))}</a>`;
const REASON = { sanctions: 'Sanctions match', watchlist: 'Watchlist' };
const STATUS = { open: 'Open', reviewed: 'Reviewed', escalated: 'Escalated', false_positive: 'False positive' };
const KIND = { 'top-level': 'Top-level', internal: 'Internal' };

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `${res.status} ${res.statusText}`);
  return res.status === 204 ? null : res.json();
}

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
  views[current](arg ? decodeURIComponent(arg) : undefined).catch((e) => {
    main.innerHTML = `<p class="error" role="alert">${esc(e.message)}</p>`;
  });
}

$('#search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(q)) location.hash = `#inspect/${q}`;
  else if (/^0x[0-9a-fA-F]{40}$/.test(q)) location.hash = `#feed/${q}`;
  else live.textContent = 'Enter a 0x address (42 characters) or a transaction hash (66 characters).';
});

const tile = (label, value) => `<div class="tile"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;

// New alerts arrive often; batch the redraws and never wipe a note the analyst is still editing.
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
  refreshTimer = setTimeout(renderAlerts, 500);
}

async function renderAlerts() {
  refreshPending = false;
  const [s, alerts] = await Promise.all([api('/api/stats'), api(`/api/alerts${alertFilter ? `?status=${alertFilter}` : ''}`)]);
  const options = ['', 'open', 'escalated', 'reviewed', 'false_positive']
    .map((v) => `<option value="${v}" ${v === alertFilter ? 'selected' : ''}>${v ? STATUS[v] : 'All alerts'}</option>`).join('');
  const rows = alerts.map((a) => `
    <tr tabindex="0" data-id="${a.id}" aria-selected="${a.id === selectedId}">
      <td>${esc(timeFmt(a.timestamp))}</td><td class="mono">${esc(short(a.from_addr))}</td><td class="mono">${esc(short(a.to_addr))}</td>
      <td>${esc(ethFmt(a.value_eth))}</td><td>${esc(KIND[a.kind])}</td>
      <td><span class="badge ${esc(a.reason)}">${esc(REASON[a.reason])}</span></td><td>${esc(STATUS[a.status])}</td>
    </tr>`).join('');
  main.innerHTML = `
    <section class="tiles" aria-label="Summary">
      ${tile('Transfers today (UTC)', s.transfersToday)}${tile('Contract-internal today', s.internalToday)}
      ${tile('Open alerts', s.openAlerts)}${tile('Sanctions hits', s.sanctionsHits)}
    </section>
    <div class="bar"><h2>Alert queue</h2><label>Show <select id="filter">${options}</select></label></div>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Time</th><th>From</th><th>To</th><th>Amount</th><th>Type</th><th>Reason</th><th>Status</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">No alerts yet. Add a watched address, or wait for a sanctions hit.</td></tr>'}</tbody>
    </table></div>
    <section id="detail" class="detail" aria-live="polite"><p class="muted">Select an alert to see its detail.</p></section>
    <p class="muted">Last block processed: ${esc(s.lastBlock)}</p>`;
  $('#filter').addEventListener('change', (e) => { alertFilter = e.target.value; renderAlerts(); });
  main.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
    const open = () => {
      selectedId = Number(tr.dataset.id);
      main.querySelectorAll('tbody tr').forEach((r) => r.setAttribute('aria-selected', String(r === tr)));
      showDetail(alerts.find((a) => a.id === selectedId));
    };
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  const selected = alerts.find((a) => a.id === selectedId);
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
      <a href="/api/transfers.csv?address=${esc(a.matched_address)}" download>Export CSV for this address</a>
    </div>`;
  const note = $('#note');
  note.addEventListener('blur', () => { if (refreshPending && note.value === note.defaultValue) renderAlerts(); });
  d.querySelectorAll('button[data-status]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/api/alerts/${a.id}`, { method: 'PATCH', body: JSON.stringify({ status: b.dataset.status, note: $('#note').value }) });
      live.textContent = `Alert #${a.id} marked ${STATUS[b.dataset.status]}.`;
      renderAlerts();
    } catch (e) {
      live.textContent = e.message;
    }
  }));
}

const feedRow = (t) => `<tr>
  <td>${esc(timeFmt(t.timestamp))}</td><td>${esc(t.block_number)}</td>
  <td class="mono">${esc(short(t.from_addr))}</td><td class="mono">${esc(short(t.to_addr))}</td>
  <td>${esc(ethFmt(t.value_eth))}</td><td>${esc(KIND[t.kind])}</td><td>${txLink(t.tx_hash)}</td></tr>`;

async function renderFeed(address) {
  if (address !== undefined) feedQuery.address = address;
  const params = new URLSearchParams(Object.entries(feedQuery).filter(([, v]) => v));
  const rows = await api(`/api/transfers?${params}&limit=200`);
  main.innerHTML = `
    <div class="bar"><h2>Live feed</h2><a href="/api/transfers.csv?${params}" download>Export CSV</a></div>
    <form class="inline" id="ff">
      <label>Address<input name="address" value="${esc(feedQuery.address)}" size="44" placeholder="0x…"></label>
      <label>Minimum ETH<input name="min" value="${esc(feedQuery.min)}" size="8" inputmode="decimal"></label>
      <button>Filter</button>
    </form>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>Time</th><th>Block</th><th>From</th><th>To</th><th>Amount</th><th>Type</th><th>Tx</th></tr></thead>
      <tbody id="feed-rows">${rows.map(feedRow).join('') || '<tr><td colspan="7" class="muted">No transfers yet. New blocks arrive about every 12 seconds.</td></tr>'}</tbody>
    </table></div>`;
  $('#ff').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    feedQuery = { address: String(f.get('address')).trim(), min: String(f.get('min')).trim() };
    if (location.hash !== '#feed') location.hash = '#feed';
    else renderFeed();
  });
}

async function renderWatchlist() {
  const rows = await api('/api/watchlist');
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
      <tbody>${rows.map((w) => `<tr><td class="mono">${esc(w.address)}</td><td>${esc(w.label)}</td><td>${esc(ethFmt(Number(w.min_wei) / 1e18))}</td>
        <td>${esc(timeFmt(w.created_at))}</td><td><button data-del="${esc(w.address)}">Remove</button></td></tr>`).join('')
        || '<tr><td colspan="5" class="muted">No watched addresses yet.</td></tr>'}</tbody>
    </table></div>`;
  $('#wf').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/watchlist', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
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
    try {
      const r = await api('/api/watchlist/upload', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: await file.text() });
      live.textContent = `Added ${r.added} address(es).${r.errors.length ? ` Problems: ${r.errors.join('; ')}` : ''}`;
      renderWatchlist();
    } catch (err) {
      live.textContent = err.message;
    }
  });
  main.querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/watchlist/${b.dataset.del}`, { method: 'DELETE' });
    live.textContent = 'Address removed.';
    renderWatchlist();
  }));
}

async function renderSanctions() {
  const s = await api('/api/sanctions');
  const refresh = s.lastRefreshError
    ? `The last refresh failed (${esc(s.lastRefreshError)}), so the last good list is in use.`
    : s.lastRefresh
      ? `Refreshed from OFAC ${esc(new Date(s.lastRefresh).toLocaleString())}.`
      : 'Using the saved list. It refreshes from OFAC when it is more than a day old.';
  main.innerHTML = `
    <h2>Sanctions list</h2>
    <p>${esc(s.size)} ETH addresses: ${esc(s.ofacCount)} from the OFAC SDN list and ${esc(s.mockCount)} from the mock demo list.
      Version <span class="mono">${esc(s.version)}</span>, loaded ${esc(new Date(s.loadedAt).toLocaleString())}.</p>
    <p class="muted">${refresh} OFAC says its address listings are not exhaustive, so a clean result does not prove an address is safe.</p>
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
    <div id="ir"></div>`;
  $('#if').addEventListener('submit', (e) => {
    e.preventDefault();
    location.hash = `#inspect/${String(new FormData(e.target).get('tx')).trim()}`;
  });
  if (!hash) return;
  const r = $('#ir');
  r.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const d = await api(`/api/inspect/${hash}`);
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

const events = new EventSource('/api/stream');
events.addEventListener('alert', (e) => {
  const a = JSON.parse(e.data);
  live.textContent = `New alert: ${REASON[a.reason]}, ${a.matched_entry}, ${ethFmt(a.value_eth)}.`;
  refreshAlertsSoon();
});
events.addEventListener('alert-updated', refreshAlertsSoon);
events.addEventListener('transfer', (e) => {
  if (current !== 'feed') return;
  const t = JSON.parse(e.data);
  const a = feedQuery.address.toLowerCase();
  if (a && t.from_addr !== a && t.to_addr !== a) return;
  if (feedQuery.min && t.value_eth < Number(feedQuery.min)) return;
  const body = $('#feed-rows');
  if (!body) return;
  if (body.querySelector('td[colspan]')) body.innerHTML = '';
  body.insertAdjacentHTML('afterbegin', feedRow(t));
  while (body.rows.length > 200) body.deleteRow(-1);
});

window.addEventListener('hashchange', route);
route();
