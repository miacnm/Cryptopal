// CryptoPal demo: your phone, the phone next to you (café register or Ana), and a demo panel.
import { faceFrom, camOn, camOff, snap, loadFace } from './face.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + (+n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const amt = n => { n = +n || 0; return (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(4)).replace(/\.?0+$/, ''); };
const pct = p => (p == null ? '' : `<span class="${p < 0 ? 'down' : 'up'}">${p >= 0 ? '+' : ''}${p.toFixed(1)}%</span>`);
const hhmm = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const ICON = {
  mic: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg>',
  tap: '<svg viewBox="0 0 48 48" width="56" height="56" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M18 14c4 4 4 16 0 20M25 9c7 7 7 23 0 30M32 4c10 10 10 30 0 40"/></svg>'
};

const params = new URLSearchParams(location.search);
let W = params.get('w') || (() => { try { return localStorage.getItem('cp_w'); } catch { return null; } })();
if (!/^[a-z0-9-]{8,40}$/.test(W || '')) W = crypto.randomUUID();
try { localStorage.setItem('cp_w', W); } catch {}
if (params.get('w') !== W) history.replaceState(null, '', `?w=${W}` + (params.get('req') ? `&req=${params.get('req')}` : ''));

async function api(path, body) {
  const r = await fetch(`/api/w/${W}/${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tz: TZ, ...body }) } : { cache: 'no-store' });
  const d = await r.json().catch(() => ({ error: 'Network problem. Try again.' }));
  if (!r.ok) throw new Error(d.error || 'Something went wrong.');
  return d;
}

let S = null, CFG = { paypal: false }, CUR = {};
const U = { screen: 'home', setup: { step: 1 }, sheet: null, trade: null, msg: null, listening: false, speech: 'normal' };
const O = { screen: 'idle', reqId: null, msg: null }; // the other phone
const scrMe = $('#scrMe'), scrOther = $('#scrOther'), demo = $('#demo'), who = $('#who');
// Phone or installed app: show one screen at a time, with a switcher at the top.
const SOLO = matchMedia('(max-width: 720px)').matches || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function setRole(r) {
  if (!['me', 'cafe', 'ana', 'demo'].includes(r)) r = 'me';
  document.body.dataset.role = r;
  try { localStorage.setItem('cp_role', r); } catch {}
  document.querySelectorAll('#roles button').forEach(b => b.classList.toggle('on', b.dataset.role === r));
  if (r === 'cafe' || r === 'ana') { who.value = r; renderOther(); }
}
if (SOLO) {
  document.body.classList.add('solo');
  let saved = null; try { saved = localStorage.getItem('cp_role'); } catch {}
  setTimeout(() => setRole(params.get('role') || saved || 'me'));
  $('#roles').addEventListener('click', e => { const b = e.target.closest('[data-role]'); if (b) setRole(b.dataset.role); });
  let taps = [];
  document.addEventListener('click', e => { // 3 quick taps on the top edge bring the switcher back
    if (e.clientY > 40 || !document.body.classList.contains('hide-roles')) return;
    taps = taps.filter(t => Date.now() - t < 900).concat(Date.now());
    if (taps.length >= 3) { document.body.classList.remove('hide-roles'); taps = []; }
  });
}
$('#manifest').href = '/manifest.webmanifest?w=' + W;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
const myName = () => (S?.me.name && S.me.name !== 'You' ? S.me.name : 'you');

// ---------- voice ----------
let rec = null;
async function toWav16k(blob) {
  const ac = new (window.AudioContext || window.webkitAudioContext)();
  const audio = await ac.decodeAudioData(await blob.arrayBuffer());
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(audio.duration * 16000)), 16000);
  const src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
  const d = (await off.startRendering()).getChannelData(0); ac.close();
  const b = new ArrayBuffer(44 + d.length * 2), v = new DataView(b);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + d.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, d.length * 2, true);
  for (let i = 0; i < d.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, d[i])) * 0x7fff, true);
  let s = ''; const u = new Uint8Array(b);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
// Tap once to start, tap again (or wait 6 s) to stop. Resolves with base64 WAV.
function listen(onState) {
  if (rec) { rec.stop(); return null; }
  return new Promise(async (res, rej) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [], mr = new MediaRecorder(stream);
      mr.ondataavailable = e => e.data.size && chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop()); rec = null; onState(false);
        try { res(await toWav16k(new Blob(chunks, { type: mr.mimeType }))); } catch (e) { rej(new Error("Couldn't read the recording. Try again.")); }
      };
      mr.start(); rec = mr; onState(true);
      setTimeout(() => rec === mr && mr.stop(), 6000);
    } catch { rej(new Error('Microphone blocked. Allow it, or switch on "No camera or mic" in the demo panel.')); }
  });
}

// ---------- QR ----------
let QR = null;
async function fillQr(root) {
  for (const el of root.querySelectorAll('[data-qr]')) {
    try {
      QR = QR || (await import('https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.mjs')).default;
      const q = QR(0, 'M'); q.addData(el.dataset.qr); q.make();
      el.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch { el.textContent = el.dataset.qr; }
  }
}
const link = reqId => `${location.origin}/?w=${W}&req=${reqId}`;

// ---------- state ----------
let lastKey = '';
async function refresh(force) {
  try { S = await api('state'); } catch (e) { return; }
  const key = JSON.stringify([S.me.cash, S.me.assets, S.me.loans.length, S.me.frozen, S.me.enrolled, S.me.limits, S.me.pending.length, S.tx.map(t => t.id + t.status), S.requests.map(r => r.id), S.night, S.simulate, S.backstage, S.others.map(o => o.cash)]);
  if (!force && key === lastKey) return;
  lastKey = key;
  if (!busyMe()) renderMe();
  if (!busyOther()) renderOther();
  renderDemo();
}
const typing = el => el.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
const busyMe = () => typing(scrMe) || U.sheet?.step === 'auth' || U.sheet?.busy || (U.screen === 'setup' && U.setup.step > 1) || U.screen === 'verify' || U.ppOpen;
const busyOther = () => typing(scrOther);

// ---------- my phone ----------
function renderMe() {
  if (!S) { scrMe.innerHTML = '<div class="center">Loading…</div>'; return; }
  if (!S.me.enrolled && U.screen !== 'setup') U.screen = 'setup';
  let h = '';
  if (U.screen === 'setup') h = setupView();
  else if (U.screen === 'verify') h = verifyView();
  else if (U.screen === 'settings') h = settingsView();
  else if (U.screen === 'wallet') h = walletView();
  else h = lockView();
  if (U.sheet) h += sheetView();
  scrMe.innerHTML = h;
  fillQr(scrMe);
  if (U.sheet?.step === 'auth' && !S.simulate) camOn($('#cam', scrMe)).catch(() => setAuth('Camera blocked. Allow it, or switch on "No camera or mic" in the demo panel.', true));
  if (U.screen === 'setup' && U.setup.step === 2 && !S.simulate) { camOn($('#cam', scrMe)).catch(() => note('Camera blocked. Allow it, or use "No camera or mic" in the demo panel.')); loadFace().catch(() => {}); }
  if (U.screen === 'verify') camOn($('#cam', scrMe)).catch(() => {});
}
const note = (t, bad) => { const el = $('#note', scrMe); if (el) { el.textContent = t; el.className = 'note' + (bad ? ' err' : ''); } };
const setAuth = (t, bad) => { const el = $('#authStatus', scrMe); if (el) { el.textContent = t; el.className = 'status' + (bad ? ' err' : ''); } };
const msg = () => (U.msg ? `<p class="note ${U.msg.bad ? 'err' : 'ok'}">${esc(U.msg.t)}</p>` : '');

function micBlock() {
  return `<div class="talk"><button class="mic ${U.listening ? 'on' : ''}" data-a="talk">${ICON.mic}<span>${U.listening ? 'Listening… tap to stop' : 'Say “CryptoPal pay bitcoin”'}</span></button>
  <form data-f="cmd" class="cmd"><input name="cmd" placeholder="or type: CryptoPal send 20 to Ana" aria-label="Type a command"><button>Go</button></form></div>`;
}

function lockView() {
  const d = new Date(S.now);
  return `<div class="lock">
    <div class="clock">${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M/, '')}</div>
    <div class="date">${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}${S.night ? ' · night' : ''}</div>
    <button class="appicon" data-a="wallet"><span>C</span>CryptoPal</button>
    <p class="hint">${SOLO ? 'Double-tap anywhere to pay' : 'Double-click the side button to pay'}</p>
    ${micBlock()}${msg()}
  </div>`;
}

function total() {
  let t = S.me.cash;
  for (const [s, u] of Object.entries(S.me.assets)) t += u * (S.prices[s]?.usd || 0);
  for (const l of S.me.loans) t -= l.owe;
  return t;
}

function walletView() {
  const m = S.me, px = S.prices;
  const assets = Object.entries(m.assets).map(([s, u]) => {
    const p = px[s] || {}, tr = U.trade?.sym === s;
    return `<div class="row"><div><b>${esc(p.name || s)}</b><small>${amt(u)} ${esc(s)} · ${p.usd ? money(p.usd) : '—'} ${pct(p.change24)}</small></div>
      <div class="r"><b>${money(u * (p.usd || 0))}</b><span class="mini"><button data-a="trade" data-s="${esc(s)}" data-side="buy">Buy</button><button data-a="trade" data-s="${esc(s)}" data-side="sell">Sell</button></span></div></div>
      ${tr ? `<form data-f="trade" class="inline"><input name="usd" type="number" min="1" step="0.01" placeholder="${U.trade.side === 'buy' ? 'Buy' : 'Sell'} how many dollars?" required><button>${U.trade.side === 'buy' ? 'Buy' : 'Sell'}</button><button type="button" data-a="tradeX" class="ghost">×</button></form>` : ''}`;
  }).join('');
  const loans = m.loans.map(l => `<div class="row ${l.warn ? 'warnrow' : ''}"><div><b>Loan on ${esc(l.asset)}</b><small>Owe ${money(l.owe)} · ${Math.round(l.ltv * 100)}% of its value${l.warn ? ' · price dropped, repay or add more' : ''}</small></div><div class="r"><button data-a="repay" data-id="${l.id}">Repay</button></div></div>`).join('');
  return `<div class="app">
    <div class="bar"><button class="link" data-a="lock">‹ Lock</button><b>CryptoPal</b><button class="link" data-a="settings">Settings</button></div>
    ${m.frozen ? `<div class="banner bad"><b>Frozen for your safety.</b> ${esc(m.frozen)} <button data-a="verify" data-k="unlock">Verify with ID + selfie</button></div>` : ''}
    <div class="total"><small>Total</small><div>${money(total())}</div>${S.night ? `<span class="pill">Night limit: ${money(m.nightLeft)} left until 6 AM</span>` : ''}</div>
    <div class="acts"><button data-a="sheet" data-m="pay">Pay</button><button data-a="sheet" data-m="send">Send</button><button data-a="sheet" data-m="receive">Receive</button></div>
    ${micBlock()}${msg()}
    <h4>Balances</h4>
    <div class="row"><div><b>Cash</b><small>US dollars</small></div><div class="r"><b>${money(m.cash)}</b></div></div>
    ${assets}
    <form data-f="asset" class="inline"><input name="sym" list="curlist" placeholder="Add any crypto or currency (ADA, EUR…)" aria-label="Add a crypto or currency"><button>Add</button></form>
    <datalist id="curlist">${Object.entries(CUR).slice(0, 400).map(([k, v]) => `<option value="${esc(k)}">${esc(v.name)}</option>`).join('')}</datalist>
    <button class="pp" data-a="addcash">Add cash with PayPal</button><div id="ppbox"></div>
    ${loans ? `<h4>Loans</h4>${loans}` : ''}
    <h4>Activity</h4>${activity()}
  </div>`;
}

function activity() {
  if (!S.tx.length) return '<p class="muted">Nothing yet.</p>';
  const label = { done: 'Done', held: 'Waiting 24 h', processing: 'Processing', blocked: 'Blocked', canceled: 'Canceled', undone: 'Undone', sending: 'Sending' };
  return S.tx.slice(0, 12).map(t => {
    const out = t.from === 'me' && t.to !== 'me', inn = t.to === 'me' && t.from !== 'me';
    const what = t.kind === 'topup' ? 'Added with PayPal' : t.kind === 'buy' ? `Bought ${esc(t.asset)}` : t.kind === 'sell' ? `Sold ${esc(t.asset)}` : out ? `To ${esc(t.toName)}` : `From ${esc(t.fromName)}`;
    const how = t.method === 'borrow' ? `borrowed against ${esc(t.asset)}` : t.method === 'sell' ? `sold ${amt(t.units)} ${esc(t.asset)}` : t.method === 'give' ? `${amt(t.units)} ${esc(t.asset)}` : '';
    const canUndo = out && t.status === 'done' && t.to === 'ana' && S.now - (t.doneAt || t.t) < 864e5;
    return `<div class="row tx s-${t.status}"><div><b>${what}</b><small>${hhmm(t.t)}${how ? ' · ' + how : ''} · ${label[t.status] || t.status}${t.status === 'held' ? ' until ' + hhmm(t.releaseAt) : ''}</small>
      ${t.reason && t.status !== 'done' ? `<small class="why">${esc(t.reason)}</small>` : ''}${t.paypal?.payout ? `<small>PayPal payout ${esc(t.paypal.payout)}</small>` : ''}</div>
      <div class="r"><b>${out ? '−' : inn ? '+' : ''}${money(t.usd)}</b>${t.status === 'held' ? `<button data-a="cancel" data-id="${t.id}">Cancel</button>` : ''}${canUndo ? `<button data-a="undo" data-id="${t.id}">Undo</button>` : ''}</div></div>`;
  }).join('');
}

function settingsView() {
  const m = S.me;
  return `<div class="app">
    <div class="bar"><button class="link" data-a="wallet">‹ Back</button><b>Security</b><span></span></div>
    <div class="card"><b>Your rules</b><ul class="rules">
      <li>Unlocking the phone never opens CryptoPal. Every send needs your face and your voice.</li>
      <li>Night limit: ${money(m.limits.night)} total from 10 PM to 6 AM.</li>
      <li>Sends over ${money(m.limits.hold)} wait 24 hours. You can cancel until then.</li>
      <li>The AI watchdog checks every send and freezes CryptoPal if something looks wrong, like your voice sounding slurred.</li>
      <li>Your panic phrase quietly locks everything and alerts a person at CryptoPal.</li></ul></div>
    ${m.pending.map(p => `<p class="note">Coming ${new Date(p.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}: ${esc(p.what)}</p>`).join('')}
    <form data-f="lower" class="card"><b>Lower a limit (instant)</b>
      <label>Night limit $<input name="night" type="number" min="0" step="1" value="${m.limits.night}"></label>
      <label>Wait 24 h over $<input name="hold" type="number" min="0" step="1" value="${m.limits.hold}"></label><button>Save</button></form>
    <div class="card"><b>Raise a limit or change a phrase</b><p class="muted">Needs a photo of your ID and a live selfie, checked by a person. Then it waits 24 hours.</p>
      <button data-a="verify" data-k="change">Start</button></div>
    <div class="card"><b>Locked out?</b><p class="muted">Call CryptoPal and verify with your photo ID and a live selfie.</p><button data-a="verify" data-k="unlock">Verify it's me</button></div>
    ${msg()}</div>`;
}

function setupView() {
  const st = U.setup;
  if (st.step === 1) return `<form class="app setup" data-f="setup1"><h3>Set up CryptoPal</h3>
    <label>Your name<input name="name" value="${esc(st.name || '')}" placeholder="Michael" required maxlength="24"></label>
    <label>Secret phrase (3+ words you say for every send)<input name="phrase" value="${esc(st.phrase || '')}" placeholder="purple tacos on sunday" required></label>
    <label>Panic phrase (say it if someone forces you)<input name="panic" value="${esc(st.panic || '')}" placeholder="call my grandma" required></label>
    <p class="muted">The panic phrase looks like it works, but it quietly locks everything until you prove it's you with your ID and a selfie.</p>
    <button>Next</button>${msg()}</form>`;
  if (st.step === 2) return `<div class="app setup"><h3>Your face</h3>
    ${S.simulate ? '<p class="muted">Demo mode without a camera: the face check is simulated.</p>' : '<video id="cam" class="cam" playsinline muted></video><p class="muted">This face is CryptoPal\'s own. Someone who unlocks your phone still can\'t use it.</p>'}
    <button data-a="faceEnroll">${S.simulate ? 'Next' : 'Save my face'}</button><p id="note" class="note"></p></div>`;
  return `<div class="app setup"><h3>Your voice</h3><p>Say your secret phrase once so CryptoPal learns how you normally sound:</p><p class="phrase">“${esc(st.phrase)}”</p>
    ${S.simulate ? `<form data-f="enrollTyped" class="inline"><input name="t" placeholder="Type it (demo mode)" required><button>Done</button></form>` : `<button class="mic big ${U.listening ? 'on' : ''}" data-a="voiceEnroll">${ICON.mic}<span>${U.listening ? 'Listening… tap to stop' : 'Tap and say it'}</span></button>`}
    <p id="note" class="note"></p></div>`;
}

function verifyView() {
  const k = U.verify?.kind || 'unlock';
  return `<div class="app setup"><div class="bar"><button class="link" data-a="wallet">‹ Back</button><b>${k === 'unlock' ? 'Verify it\'s you' : 'Change security'}</b><span></span></div>
    <p class="muted">A person at CryptoPal checks your photo ID against a live selfie. ${k === 'unlock' ? 'In real life you also call in.' : 'Changes start 24 hours after approval.'}</p>
    ${k === 'change' ? `<label>New night limit $<input id="vNight" type="number" min="0" value="${S.me.limits.night}"></label>
      <label>Wait 24 h over $<input id="vHold" type="number" min="0" value="${S.me.limits.hold}"></label>
      <label>New secret phrase (optional)<input id="vPhrase"></label><label>New panic phrase (optional)<input id="vPanic"></label>` : ''}
    <label>Photo of your ID<input id="idFile" type="file" accept="image/*" capture="environment"></label><img id="idPrev" class="prev" alt="" hidden>
    <video id="cam" class="cam" playsinline muted></video><button data-a="selfie" class="ghost">Take live selfie</button><img id="selfPrev" class="prev" alt="" hidden>
    <button data-a="sendVerify">Send for review</button><p id="note" class="note"></p></div>`;
}

// ---------- the pay / send / receive sheet ----------
function sheetView() {
  const sh = U.sheet, tabs = ['pay', 'send', 'receive'].map(m => `<button class="${sh.mode === m ? 'on' : ''}" data-a="mode" data-m="${m}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('');
  let body = '';
  if (sh.step === 'find') body = `<div class="find"><div class="nfc">${ICON.tap}</div><b>Hold near the reader</b>
      <button data-a="tap">Tap phones</button><p class="muted">Or scan the register's QR code with your camera.</p>${sh.error ? `<p class="note err">${esc(sh.error)}</p>` : ''}</div>`;
  else if (sh.step === 'form' && sh.mode === 'send') body = `<form data-f="send" class="form">
      <label>To<select name="to"><option value="ana">Ana</option><option value="cafe">Corner Café</option></select></label>
      <label>Amount ($)<input name="usd" type="number" min="0.01" step="0.01" value="${esc(sh.usd || '')}" required></label>
      <label>Pay with<select name="prefer"><option value="">Let the AI pick</option>${coinOptions(sh.prefer)}</select></label>
      <label>Note (optional)<input name="memo" maxlength="80" placeholder="Dinner"></label>
      <button>Next</button>${sh.error ? `<p class="note err">${esc(sh.error)}</p>` : ''}</form>`;
  else if (sh.step === 'form') body = `<form data-f="receive" class="form">
      <label>Get paid in<select name="asset"><option value="">Dollars</option>${coinOptions(sh.prefer)}</select></label>
      <label>Amount ($)<input name="usd" type="number" min="0.01" step="0.01" value="${esc(sh.usd || '')}" required></label>
      <button>Show my code</button>${sh.error ? `<p class="note err">${esc(sh.error)}</p>` : ''}</form>`;
  else if (sh.step === 'code') {
    const paid = S.tx.find(t => t.req === sh.req.id);
    body = paid ? `<div class="result ok"><div class="big">✓</div><b>You got ${money(paid.usd)}</b><p>${paid.method === 'give' ? `${amt(paid.units)} ${esc(paid.asset)} from ${esc(paid.fromName)}` : `from ${esc(paid.fromName)}`}</p><button data-a="close">Done</button></div>`
      : `<div class="find"><b>${money(sh.req.usd)}${sh.req.asset ? ' in ' + esc(sh.req.asset) : ''}</b><div class="qr" data-qr="${esc(link(sh.req.id))}"></div>
         <p class="muted">Tap phones with Ana (switch "Next to you" to Ana's phone) or let them scan this code.</p></div>`;
  }
  else if (sh.step === 'choose') body = chooseView(sh);
  else if (sh.step === 'auth') body = `<div class="auth">
      ${S.simulate ? '<p class="muted">Demo mode: face check simulated, phrase typed.</p>' : '<video id="cam" class="cam small" playsinline muted></video>'}
      <p>${sh.action === 'send' ? `Pay <b>${money(sh.usd)}</b> to <b>${esc(sh.toName)}</b>` : sh.action === 'cancel' ? 'Cancel this payment' : 'Undo this payment'}</p>
      ${S.simulate ? `<form data-f="authTyped" class="inline"><input name="t" placeholder="Type your secret phrase" required autocomplete="off"><button>Confirm</button></form>`
        : `<button class="mic big ${U.listening ? 'on' : ''}" data-a="authVoice">${ICON.mic}<span>${U.listening ? 'Listening… tap to stop' : 'Tap and say your secret phrase'}</span></button>`}
      <p id="authStatus" class="status">${sh.error ? esc(sh.error) : 'Look at the camera while you speak.'}</p></div>`;
  else if (sh.step === 'result') body = resultView(sh.result);
  return `<div class="sheet"><div class="grab"></div><div class="tabs">${tabs}<button class="x" data-a="close" aria-label="Close">×</button></div>${body}</div>`;
}
function coinOptions(sel) {
  return Object.keys(S.me.assets).filter(s => S.me.assets[s] > 0).map(s => `<option value="${esc(s)}" ${s === sel ? 'selected' : ''}>${esc(S.prices[s]?.name || s)}</option>`).join('');
}
function chooseView(sh) {
  const g = sh.sug, pick = g.options.find(o => o.id === g.pick), chosen = sh.option || g.pick;
  const other = g.options.filter(o => o.id !== g.pick);
  return `<div class="choose"><p class="amount">${money(g.usd)} <small>to ${esc(g.toName)}</small></p>
    <label class="opt ai ${chosen === pick.id ? 'sel' : ''}"><input type="radio" name="opt" value="${pick.id}" ${chosen === pick.id ? 'checked' : ''}>
      <span class="badge">✨ AI pick</span><b>${esc(pick.label)}</b><small>${esc(pick.detail)}</small><em>${esc(g.reason)}</em>
      <button type="button" class="q" data-a="why" aria-label="Why">?</button></label>
    ${sh.why ? `<div class="whybox"><b>Why the AI picked this</b><ul>${(g.why || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${other.map(o => `<label class="opt ${chosen === o.id ? 'sel' : ''}"><input type="radio" name="opt" value="${o.id}" ${chosen === o.id ? 'checked' : ''}><b>${esc(o.label)}</b><small>${esc(o.detail)}${o.change24 != null ? ' · today ' + pct(o.change24) : ''}</small></label>`).join('')}
    <button data-a="confirm">Confirm with face + voice</button></div>`;
}
function resultView(r) {
  if (r.status === 'done') return `<div class="result ok"><div class="big">✓</div><b>Paid ${money(r.tx.usd)}</b><p class="muted">AI watchdog: ${esc(r.reason || 'looks normal')}</p>${r.tx.paypal?.payout ? `<small>PayPal payout ${esc(r.tx.paypal.payout)}</small>` : r.tx.paypal?.simulated ? '<small>PayPal payout simulated (sandbox not connected)</small>' : ''}<button data-a="close">Done</button></div>`;
  if (r.status === 'held') return `<div class="result warn"><div class="big">⏳</div><b>Waiting 24 hours</b><p>${esc(r.reason)}</p><p class="muted">You can cancel it from Activity until ${hhmm(r.tx.releaseAt)} tomorrow.</p><button data-a="close">OK</button></div>`;
  if (r.status === 'frozen') return `<div class="result bad"><div class="big">🔒</div><b>CryptoPal froze this</b><p>${esc(r.reason)}</p><p class="muted">Nothing was sent. To unlock, verify with your photo ID and a live selfie.</p><button data-a="verify" data-k="unlock">Verify it's me</button></div>`;
  if (r.status === 'processing') return `<div class="result"><div class="spin"></div><b>Processing</b><p>${esc(r.message)}</p><button data-a="close">OK</button></div>`;
  if (r.status === 'canceled') return `<div class="result ok"><div class="big">✓</div><b>Canceled. Your money is back.</b><button data-a="close">Done</button></div>`;
  if (r.status === 'undone') return `<div class="result ok"><div class="big">✓</div><b>Undone. Your money is back.</b><button data-a="close">Done</button></div>`;
  return `<div class="result"><b>${esc(r.status)}</b><button data-a="close">OK</button></div>`;
}

function openSheet(mode, extra = {}) {
  if (!S?.me.enrolled) return;
  U.screen = U.screen === 'home' ? 'wallet' : U.screen;
  U.msg = null;
  U.sheet = { mode, step: mode === 'pay' ? 'find' : 'form', ...extra };
  renderMe();
}
async function suggest(sh) {
  sh.busy = true; renderMe();
  try { sh.sug = await api('suggest', { to: sh.to, usd: sh.usd, prefer: sh.prefer }); sh.option = null; sh.step = 'choose'; sh.error = null; }
  catch (e) { sh.error = e.message; if (sh.step === 'choose') sh.step = sh.mode === 'pay' ? 'find' : 'form'; }
  sh.busy = false; renderMe();
}
function findRequest(sh) {
  const r = S.requests.filter(x => x.by === who.value).sort((a, b) => b.t - a.t)[0];
  if (!r) { sh.error = who.value === 'cafe' ? 'Nothing to pay yet. Type an amount on the café register and press Charge.' : 'Ana isn\'t asking for money. Use "Ask" on Ana\'s phone.'; renderMe(); return; }
  Object.assign(sh, { req: r, to: r.by, usd: r.usd, toName: r.by === 'cafe' ? 'Corner Café' : 'Ana', error: null });
  suggest(sh);
}

async function runAuth(spoken) {
  const sh = U.sheet; sh.busy = true; sh.error = null;
  try {
    setAuth('Checking your voice…');
    const video = $('#cam', scrMe);
    const faceP = S.simulate ? Promise.resolve(null) : faceFrom(video, 12).catch(() => null);
    const v = await api('voice', { purpose: 'phrase', ...spoken });
    setAuth(`Heard “${v.text}”. Checking your face…`);
    const face = await faceP;
    if (!face && !S.simulate) throw new Error("I couldn't see your face. Look at the camera and try again.");
    setAuth('AI watchdog is checking this payment…');
    const auth = { checkId: v.checkId, face, faceSim: !!S.simulate };
    let r;
    if (sh.action === 'send') r = await api('send', { auth, to: sh.to, usd: sh.usd, option: sh.option, requestId: sh.req?.id, memo: sh.memo });
    else r = await api(sh.action, { auth, txId: sh.txId });
    sh.result = r; sh.step = 'result'; camOff();
  } catch (e) { sh.error = e.message; setAuth(e.message, true); }
  sh.busy = false;
  await refresh(true);
  if (sh.step === 'result') renderMe();
}

// ---------- clicks on my phone ----------
const actions = {
  wallet: () => { U.screen = 'wallet'; U.msg = null; camOff(); renderMe(); },
  lock: () => { U.screen = 'home'; U.sheet = null; U.msg = null; renderMe(); },
  settings: () => { U.screen = 'settings'; U.msg = null; renderMe(); },
  sheet: el => openSheet(el.dataset.m),
  mode: el => { if (U.sheet.step === 'auth') camOff(); openSheet(el.dataset.m); },
  close: () => { U.sheet = null; camOff(); renderMe(); },
  tap: () => findRequest(U.sheet),
  why: () => { U.sheet.why = !U.sheet.why; renderMe(); },
  confirm: () => {
    const sh = U.sheet, sel = $('input[name=opt]:checked', scrMe);
    sh.option = sel ? sel.value : sh.sug.pick; sh.action = 'send'; sh.toName = sh.sug.toName; sh.step = 'auth'; sh.error = null; renderMe();
  },
  authVoice: async () => {
    const p = listen(on => { U.listening = on; const b = $('[data-a=authVoice] span', scrMe); if (b) b.textContent = on ? 'Listening… tap to stop' : 'Got it'; $('[data-a=authVoice]', scrMe)?.classList.toggle('on', on); });
    if (!p) return;
    try { const audio = await p; await runAuth({ audio }); } catch (e) { setAuth(e.message, true); }
  },
  cancel: el => { U.sheet = { mode: 'send', step: 'auth', action: 'cancel', txId: el.dataset.id }; renderMe(); },
  undo: el => { U.sheet = { mode: 'send', step: 'auth', action: 'undo', txId: el.dataset.id }; renderMe(); },
  trade: el => { U.trade = { sym: el.dataset.s, side: el.dataset.side }; renderMe(); $('form[data-f=trade] input', scrMe)?.focus(); },
  tradeX: () => { U.trade = null; renderMe(); },
  repay: async el => { try { await api('repay', { loanId: el.dataset.id }); U.msg = { t: 'Loan repaid.' }; } catch (e) { U.msg = { t: e.message, bad: 1 }; } await refresh(true); renderMe(); },
  addcash: () => addCash(),
  verify: el => { U.verify = { kind: el.dataset.k }; U.sheet = null; U.screen = 'verify'; renderMe(); },
  talk: async () => {
    const p = listen(on => { U.listening = on; const b = $('[data-a=talk] span', scrMe); if (b) b.textContent = on ? 'Listening… tap to stop' : 'Thinking…'; $('[data-a=talk]', scrMe)?.classList.toggle('on', on); });
    if (!p) return;
    try { const audio = await p; await command({ audio }); } catch (e) { U.msg = { t: e.message, bad: 1 }; renderMe(); }
  },
  faceEnroll: async () => {
    if (S.simulate) { U.setup.face = null; U.setup.step = 3; renderMe(); return; }
    note('Looking for your face…');
    try { const f = await faceFrom($('#cam', scrMe), 15); if (!f) return note("I couldn't see a face. Get closer to the camera, with light on your face.", true); U.setup.face = f; camOff(); U.setup.step = 3; renderMe(); }
    catch { note("The face check didn't load. Check your connection.", true); }
  },
  voiceEnroll: async () => {
    const p = listen(on => { U.listening = on; const b = $('[data-a=voiceEnroll] span', scrMe); if (b) b.textContent = on ? 'Listening… tap to stop' : 'Checking…'; });
    if (!p) return;
    try { const audio = await p; await finishSetup({ audio }); } catch (e) { note(e.message, true); }
  },
  selfie: async () => {
    const v = $('#cam', scrMe); if (!v?.srcObject) return note('Camera blocked. Allow it to take a selfie.', true);
    const c = snap(v); U.verify.selfie = c.toDataURL('image/jpeg', 0.8);
    U.verify.selfieFace = await faceFrom(c, 1).catch(() => null);
    const img = $('#selfPrev', scrMe); img.src = U.verify.selfie; img.hidden = false;
    note(U.verify.selfieFace ? 'Selfie taken.' : 'Selfie taken, but no face found. Try again with more light.', !U.verify.selfieFace);
  },
  sendVerify: async () => {
    const V = U.verify;
    if (!V.idPhoto || !V.selfie) return note('Add a photo of your ID and take a live selfie.', true);
    const body = { kind: V.kind, idPhoto: V.idPhoto, selfie: V.selfie, idFace: V.idFace, selfieFace: V.selfieFace };
    if (V.kind === 'change') Object.assign(body, { night: $('#vNight', scrMe).value, hold: $('#vHold', scrMe).value, phrase: $('#vPhrase', scrMe).value, panic: $('#vPanic', scrMe).value });
    try { await api('verify', body); camOff(); U.screen = 'wallet'; U.msg = { t: 'Sent. A person at CryptoPal will check your ID and selfie.' }; await refresh(true); renderMe(); }
    catch (e) { note(e.message, true); }
  }
};

async function command(spoken) {
  try {
    const v = await api('voice', { purpose: 'command', ...spoken });
    const i = v.intent || {};
    U.msg = { t: `Heard “${v.text}”` };
    if (i.action === 'pay') openSheet('pay', { prefer: i.asset });
    else if (i.action === 'send') {
      const to = /ana/i.test(i.to || '') ? 'ana' : /caf/i.test(i.to || '') ? 'cafe' : null;
      openSheet('send', { prefer: i.asset, usd: i.amountUsd });
      if (to && i.amountUsd) Object.assign(U.sheet, { to, usd: i.amountUsd, toName: to === 'ana' ? 'Ana' : 'Corner Café' }) && suggest(U.sheet);
    } else if (i.action === 'receive') openSheet('receive', { prefer: i.asset, usd: i.amountUsd });
    else { U.screen = 'wallet'; U.msg = { t: `Heard “${v.text}”. Try “CryptoPal pay bitcoin” or “send 20 to Ana”.` }; renderMe(); }
  } catch (e) { U.msg = { t: e.message, bad: 1 }; renderMe(); }
}

async function finishSetup(spoken) {
  const st = U.setup;
  try {
    note('Learning your voice…');
    const v = await api('voice', { purpose: 'enroll', ...spoken });
    await api('setup', { name: st.name, phrase: st.phrase, panic: st.panic, face: st.face, faceSim: !!S.simulate, checkId: v.checkId });
    U.setup = { step: 1 }; U.screen = 'wallet'; U.msg = { t: 'All set. Double-click the side button to pay.' };
    await refresh(true); renderMe();
  } catch (e) { note(e.message, true); }
}

async function addCash() {
  U.ppOpen = true;
  const box = $('#ppbox', scrMe);
  if (!CFG.paypal) { box.innerHTML = '<p class="note">PayPal sandbox isn\'t connected on this server yet.</p>'; U.ppOpen = false; return; }
  box.innerHTML = '<div class="inline"><input id="ppamt" type="number" min="1" max="500" value="25" aria-label="Dollars to add"><button data-a="ppclose" class="ghost">×</button></div><div id="ppbtn"></div>';
  try {
    if (!window.paypal) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(CFG.paypalClientId)}&currency=USD&intent=capture&components=buttons`; s.onload = res; s.onerror = rej; document.head.append(s); });
    window.paypal.Buttons({
      style: { height: 40, label: 'pay' },
      createOrder: async () => (await api('paypal/order', { usd: +$('#ppamt', scrMe).value })).id,
      onApprove: async d => { const r = await api('paypal/capture', { orderId: d.orderID }); U.ppOpen = false; U.msg = { t: `Added ${money(r.usd)} with PayPal (sandbox).` }; await refresh(true); renderMe(); },
      onCancel: () => { U.ppOpen = false; },
      onError: e => { U.ppOpen = false; box.insertAdjacentHTML('beforeend', `<p class="note err">${esc(e?.message || 'PayPal error')}</p>`); }
    }).render('#ppbtn');
  } catch { U.ppOpen = false; box.innerHTML = '<p class="note err">PayPal didn\'t load.</p>'; }
}
actions.ppclose = () => { U.ppOpen = false; renderMe(); };

scrMe.addEventListener('dblclick', e => {
  if (U.screen === 'home' && !U.sheet && S?.me.enrolled && !e.target.closest('button, input, form')) { U.screen = 'wallet'; openSheet('pay'); }
});
scrMe.addEventListener('click', e => {
  const a = e.target.closest('[data-a]');
  if (a && actions[a.dataset.a]) { e.preventDefault(); actions[a.dataset.a](a); }
});
scrMe.addEventListener('change', async e => {
  if (e.target.name === 'opt') { U.sheet.option = e.target.value; scrMe.querySelectorAll('.opt').forEach(l => l.classList.toggle('sel', l.contains(e.target))); }
  if (e.target.id === 'idFile' && e.target.files[0]) {
    const img = new Image(); img.src = URL.createObjectURL(e.target.files[0]); await img.decode().catch(() => {});
    const s = Math.min(1, 900 / Math.max(img.width, img.height)), c = document.createElement('canvas');
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    U.verify.idPhoto = c.toDataURL('image/jpeg', 0.8); U.verify.idFace = await faceFrom(c, 1).catch(() => null);
    const p = $('#idPrev', scrMe); p.src = U.verify.idPhoto; p.hidden = false;
  }
});
scrMe.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, d = Object.fromEntries(new FormData(f)), sh = U.sheet;
  switch (f.dataset.f) {
    case 'cmd': if (d.cmd.trim()) await command({ text: d.cmd }); break;
    case 'setup1': Object.assign(U.setup, d, { step: 2 }); renderMe(); break;
    case 'enrollTyped': await finishSetup({ text: d.t, speech: 'normal' }); break;
    case 'authTyped': await runAuth({ text: d.t, speech: U.speech }); break;
    case 'send': Object.assign(sh, { to: d.to, usd: +d.usd, prefer: d.prefer || null, memo: d.memo, toName: d.to === 'ana' ? 'Ana' : 'Corner Café' }); await suggest(sh); break;
    case 'receive':
      try { const r = await api('request', { by: 'me', usd: +d.usd, asset: d.asset || null }); Object.assign(sh, { req: r.request, step: 'code', error: null }); await refresh(true); renderMe(); }
      catch (er) { sh.error = er.message; renderMe(); } break;
    case 'asset': try { await api('asset', { symbol: d.sym }); U.msg = { t: `${d.sym.toUpperCase()} added.` }; } catch (er) { U.msg = { t: er.message, bad: 1 }; } await refresh(true); renderMe(); break;
    case 'trade': try { await api('trade', { asset: U.trade.sym, side: U.trade.side, usd: +d.usd }); U.msg = { t: 'Done.' }; U.trade = null; } catch (er) { U.msg = { t: er.message, bad: 1 }; } await refresh(true); renderMe(); break;
    case 'lower': try { await api('limits', { night: +d.night, hold: +d.hold }); U.msg = { t: 'Saved.' }; } catch (er) { U.msg = { t: er.message, bad: 1 }; } await refresh(true); renderMe(); break;
  }
});

// Side button: double-click opens CryptoPal ready to pay, like Apple Pay.
let lastSide = 0;
$('#side').addEventListener('click', () => {
  const now = Date.now();
  if (now - lastSide < 450) { lastSide = 0; if (S?.me.enrolled) { U.screen = 'wallet'; openSheet('pay'); } }
  else lastSide = now;
});

// ---------- the other phone ----------
function renderOther() {
  if (!S) return;
  const isCafe = who.value === 'cafe', ana = S.others.find(o => o.id === 'ana');
  let h = '';
  if (isCafe) {
    const r = O.reqId && S.requests.find(x => x.id === O.reqId), paid = O.reqId && S.tx.find(t => t.req === O.reqId);
    if (paid) h = `<div class="reg"><div class="bar"><b>Corner Café</b><small>Register</small></div><div class="result ok"><div class="big">✓</div>
      <b>${paid.status === 'held' ? 'Payment waiting 24 h' : 'Paid ' + money(paid.usd)}</b><p>${esc(paid.method === 'borrow' ? 'Customer borrowed against crypto' : paid.method === 'sell' ? 'Customer paid with crypto' : 'Customer paid')}. The café gets dollars.</p>
      <small>${paid.paypal?.payout ? 'PayPal payout ' + esc(paid.paypal.payout) : paid.paypal?.simulated ? 'PayPal payout simulated (sandbox not connected)' : paid.paypal?.error ? esc(paid.paypal.error) : ''}</small>
      <button data-o="newsale">New sale</button></div></div>`;
    else if (r) h = `<div class="reg"><div class="bar"><b>Corner Café</b><small>Register</small></div><p class="amount">${money(r.usd)}</p>
      <p class="muted">Customer: double-click your side button, then tap phones.</p><div class="qr" data-qr="${esc(link(r.id))}"></div><button class="ghost" data-o="newsale">Cancel</button></div>`;
    else h = `<form class="reg" data-of="charge"><div class="bar"><b>Corner Café</b><small>Register</small></div>
      <label class="amt">$<input name="usd" type="number" min="0.5" step="0.01" value="6.50" aria-label="Amount to charge"></label>
      <label>Note<input name="memo" maxlength="60" value="Latte + croissant"></label><button>Charge</button>
      <p class="muted">Takes CryptoPal. The café always gets dollars through PayPal.</p>${O.msg ? `<p class="note err">${esc(O.msg)}</p>` : ''}</form>`;
  } else {
    const myReq = S.requests.filter(x => x.by === 'me').sort((a, b) => b.t - a.t)[0];
    const anaReq = S.requests.find(x => x.by === 'ana');
    h = `<div class="app ana"><div class="bar"><b>Ana</b><small>CryptoPal</small></div>
      <div class="total"><small>Ana's money</small><div>${money(ana.cash)}</div><small>${Object.entries(ana.assets).map(([s, u]) => `${amt(u)} ${esc(s)}`).join(' · ')}</small></div>
      ${myReq ? `<div class="card"><b>${esc(myName())} is asking for ${money(myReq.usd)}${myReq.asset ? ' in ' + esc(myReq.asset) : ''}</b><button data-o="anaPay" data-id="${myReq.id}">Tap to pay</button></div>` : ''}
      <form data-of="anaSend" class="card"><b>Send to ${esc(myName())}</b><div class="inline"><input name="usd" type="number" min="1" step="0.01" placeholder="$" required aria-label="Amount">
        <select name="asset" aria-label="Currency"><option value="USD">Dollars</option>${Object.keys(ana.assets).map(s => `<option>${esc(s)}</option>`).join('')}</select><button>Send</button></div></form>
      <form data-of="anaAsk" class="card"><b>Ask ${esc(myName())} for money</b><div class="inline"><input name="usd" type="number" min="1" step="0.01" placeholder="$" required aria-label="Amount"><button>Ask</button></div>
        ${anaReq ? `<small>Asking for ${money(anaReq.usd)}. ${esc(myName())}: double-click your side button and tap.</small>` : ''}</form>
      ${O.msg ? `<p class="note">${esc(O.msg)}</p>` : ''}<p class="muted">Ana is a demo person, so her phone skips the face and voice check.</p></div>`;
  }
  scrOther.innerHTML = h;
  fillQr(scrOther);
}
scrOther.addEventListener('click', async e => {
  const a = e.target.closest('[data-o]'); if (!a) return;
  e.preventDefault(); O.msg = null;
  if (a.dataset.o === 'newsale') { O.reqId = null; renderOther(); }
  if (a.dataset.o === 'anaPay') { try { await api('npcpay', { from: 'ana', requestId: a.dataset.id }); O.msg = 'Paid.'; } catch (er) { O.msg = er.message; } await refresh(true); renderOther(); }
});
scrOther.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, d = Object.fromEntries(new FormData(f));
  try {
    if (f.dataset.of === 'charge') { const r = await api('request', { by: 'cafe', usd: +d.usd, memo: d.memo }); O.reqId = r.request.id; }
    if (f.dataset.of === 'anaSend') { await api('npcsend', { from: 'ana', usd: +d.usd, asset: d.asset }); O.msg = 'Sent.'; }
    if (f.dataset.of === 'anaAsk') { await api('request', { by: 'ana', usd: +d.usd }); O.msg = 'Asked.'; }
  } catch (er) { O.msg = er.message; }
  await refresh(true); renderOther();
});
who.addEventListener('change', () => { O.msg = null; renderOther(); });

// ---------- demo panel ----------
function renderDemo() {
  const b = S.backstage;
  demo.innerHTML = `<h3>Demo controls</h3>
    <label class="tog"><input type="checkbox" data-d="night" ${S.demoNight ? 'checked' : ''}> Pretend it's 2 AM (night limit)</label>
    <label class="tog"><input type="checkbox" data-d="simulate" ${S.simulate ? 'checked' : ''}> No camera or mic (type the phrase)</label>
    ${S.simulate ? `<label>Typed phrase sounds<select data-d="speech"><option value="normal" ${U.speech === 'normal' ? 'selected' : ''}>like me</option><option value="slurred" ${U.speech === 'slurred' ? 'selected' : ''}>slurred (drunk or drugged)</option></select></label>` : ''}
    <button data-d="skip">Skip ahead 24 hours</button>
    ${SOLO ? '<button class="ghost" data-d="clean">Hide the top menu for recording</button><p class="muted">Tap the very top of the screen 3 times to get it back.</p>' : ''}
    <a class="btn" href="/review?w=${W}" target="_blank" rel="noopener">Human review desk</a>
    <h4>Behind the scenes</h4>
    <p>Account: <b class="${b.locked ? 'bad' : ''}">${b.locked === 'panic' ? 'LOCKED by panic phrase (the phone doesn\'t show it)' : b.locked === 'freeze' ? 'Frozen by AI watchdog' : 'Normal'}</b></p>
    <p>Waiting for a person: <b>${b.openReviews}</b></p>
    <p>PayPal sandbox: <b>${b.paypal ? 'connected' : 'not connected (payouts simulated)'}</b></p>
    <h4>Open on your phone</h4><div class="qr" data-qr="${esc(location.origin + '/?w=' + W)}"></div>
    <p class="muted">Same demo, real camera and mic. On iPhone, a Shortcut named CryptoPal that opens this link makes “Hey Siri, CryptoPal” work, and the Action Button can run it too.</p>
    <button class="ghost" data-d="reset">Reset demo</button>`;
  fillQr(demo);
}
demo.addEventListener('change', async e => {
  const k = e.target.dataset.d;
  if (k === 'speech') { U.speech = e.target.value; return; }
  if (k === 'night' || k === 'simulate') { await api('demo', { [k]: e.target.checked }).catch(() => {}); camOff(); await refresh(true); renderMe(); }
});
demo.addEventListener('click', async e => {
  const k = e.target.dataset?.d;
  if (k === 'clean') { document.body.classList.add('hide-roles'); setRole('me'); return; }
  if (k === 'skip') { await api('demo', { skipHours: 24 }); await refresh(true); renderMe(); }
  if (k === 'reset' && confirm('Start the demo over?')) { await api('demo', { reset: true }); Object.assign(U, { screen: 'home', setup: { step: 1 }, sheet: null, msg: null }); O.reqId = null; camOff(); await refresh(true); renderMe(); renderOther(); }
});

// ---------- start ----------
(async () => {
  renderMe();
  [CFG, CUR] = await Promise.all([fetch('/api/config').then(r => r.json()).catch(() => ({})), fetch('/api/currencies').then(r => r.json()).catch(() => ({}))]);
  await refresh(true);
  const req = params.get('req');
  if (req && S.me.enrolled) {
    const r = S.requests.find(x => x.id === req);
    if (r && r.by !== 'me') { who.value = r.by; renderOther(); U.screen = 'wallet'; openSheet('pay'); findRequest(U.sheet); }
  }
  setInterval(() => document.visibilityState === 'visible' && refresh(), 3000);
  setInterval(() => { const c = $('.clock', scrMe); if (c && S) c.textContent = new Date(Date.now() + (S.now - Date.now())).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M/, ''); }, 30000);
})();
