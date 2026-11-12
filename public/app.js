// CryptoPal demo: your phone, the phone next to you (café register or Ana), and a demo panel.
import { faceFrom, faceAndPose, camOn, camOff, snap, loadFace, downloadAll, saveMyFace, myFace, forgetMyFace, faceDist, SAME } from './face.js';

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
const U = { screen: 'wallet', tab: 'pay', aiOpen: false, tip: null, market: null, setup: { step: 1 }, sheet: null, trade: null, msg: null, listening: false, speech: 'normal', unlockedAt: 0, pay: null, gateNext: null };
// Your face opens CryptoPal (on this phone). It stays open 3 minutes, or until you lock it.
const UNLOCK_MS = 3 * 60e3;
const unlocked = () => !!S?.simulate || Date.now() - U.unlockedAt < UNLOCK_MS;
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
  setTimeout(() => setRole('me'));
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

// First open: download the face check onto the phone (about 8 MB), with a progress bar.
const FACE_DL = { done: false, pct: 0, failed: false };
function dlBar() {
  let bar = $('#dlbar');
  if (FACE_DL.done) { bar?.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'dlbar'; bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99;padding:10px 16px calc(10px + env(safe-area-inset-bottom));background:#111018;color:#fff;font:14px system-ui;border-top:1px solid #333'; document.body.append(bar); }
  bar.innerHTML = FACE_DL.failed
    ? 'Couldn\'t finish downloading CryptoPal. <button id="dlretry" style="margin-left:8px">Try again</button>'
    : `Getting CryptoPal ready on this phone… ${Math.round(FACE_DL.pct * 100)}%<div style="height:4px;background:#333;border-radius:2px;margin-top:6px"><div style="height:4px;width:${Math.round(FACE_DL.pct * 100)}%;background:#7c5cff;border-radius:2px"></div></div>`;
  $('#dlretry')?.addEventListener('click', getFaceFiles);
}
async function getFaceFiles() {
  FACE_DL.failed = false;
  try { await downloadAll(p => { FACE_DL.pct = p; dlBar(); }); FACE_DL.done = true; dlBar(); loadFace().catch(() => {}); }
  catch { FACE_DL.failed = true; dlBar(); }
}
getFaceFiles();
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
const busyMe = () => typing(scrMe) || U.sheet?.step === 'auth' || U.sheet?.busy || (U.screen === 'setup' && U.setup.step > 1) || U.screen === 'verify' || U.ppOpen
  || U.screen === 'gate' || U.screen === 'pay' || (U.screen === 'setup');
const busyOther = () => typing(scrOther);

// ---------- my phone ----------
function renderMe() {
  if (!S) { scrMe.innerHTML = '<div class="center">Loading…</div>'; return; }
  if (!S.me.enrolled && U.screen !== 'setup') U.screen = 'setup';
  if (S.me.enrolled && (U.screen === 'home' || U.screen === 'setup' || U.screen === 'gate')) U.screen = 'wallet';
  let h = '';
  if (U.screen === 'pay') h = payView();
  else if (U.screen === 'setup') h = setupView();
  else if (U.screen === 'verify') h = verifyView();
  else if (U.screen === 'settings') h = settingsView();
  else h = walletView();
  if (U.sheet) h += sheetView();
  scrMe.innerHTML = h;
  fillQr(scrMe);
  const cam = () => camOn($('#cam', scrMe)).catch(() => {});
  if (U.sheet?.step === 'auth' && !S.simulate) cam();
  if (U.screen === 'setup' && U.setup.step === 2) { cam(); loadFace().catch(() => {}); }
  if (U.screen === 'verify') cam();
  if (U.screen === 'pay' && U.pay?.step === 'check' && U.pay.cam) cam();
  if (U.screen === 'pay' && U.pay?.step === 'tap' && !U.pay.tapTimer) U.pay.tapTimer = setTimeout(payTap, 2400);
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

// Wallet: four simple tabs. Pay · Trade (buy and sell crypto at live market prices) · Add funds · Activity.
// ---------- AI settings (kept on this phone) ----------
const AI_DEFAULT = { tips: true, movers: true, newCoins: true, style: 'short', risk: 'careful' };
const AI = (() => { try { return { ...AI_DEFAULT, ...JSON.parse(localStorage.getItem('cp_ai') || '{}') }; } catch { return { ...AI_DEFAULT }; } })();
const saveAI = () => { try { localStorage.setItem('cp_ai', JSON.stringify(AI)); } catch {} };
const AI_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2l1.7 4.6L18 8.3l-4.3 1.7L12 14.6l-1.7-4.6L6 8.3l4.3-1.7L12 2zm6.5 10.5l.9 2.2 2.1.8-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.8.9-2.2zM7 15l1.2 2.9L11 19l-2.8 1.1L7 23l-1.2-2.9L3 19l2.8-1.1L7 15z"/></svg>';

// ---------- pretend market: real prices when the app has them, pretend moves, always instant ----------
const MKT = [['BTC', 'Bitcoin', 73600], ['ETH', 'Ethereum', 2050], ['SOL', 'Solana', 83], ['XRP', 'XRP', 1.06], ['DOGE', 'Dogecoin', 0.068], ['ADA', 'Cardano', 0.175],
  ['AVAX', 'Avalanche', 8.4], ['LINK', 'Chainlink', 10.4], ['LTC', 'Litecoin', 52], ['SHIB', 'Shiba Inu', 0.0000071], ['SUI', 'Sui', 0.95], ['XLM', 'Stellar', 0.17], ['PEPE', 'Pepe', 0.0000031], ['USDC', 'USDC', 1]];
const NEW_COINS = ['ZORA', 'PENGU', 'VIRTUAL', 'ONDO', 'JUP', 'WIF', 'BONK', 'TIA', 'MOVE', 'ENA'];
const isStable = s => /^(USDC|USDT|PYUSD|DAI)$/.test(s);
function seeded(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; }
function quote(sym) {
  const base = MKT.find(m => m[0] === sym), p = S?.prices?.[sym], day = new Date().toISOString().slice(0, 10), hour = new Date().toISOString().slice(0, 13);
  const usd = p?.usd || S?.market?.[sym] || base?.[2] || 0;
  const d24 = isStable(sym) || p?.crypto === false ? 0 : p?.change24 != null ? p.change24 : (seeded(sym + day) - 0.55) * 11;
  const h1 = isStable(sym) || p?.crypto === false ? 0 : (seeded(sym + hour) - 0.5) * 3;
  return { sym, name: p?.name || base?.[1] || sym, usd, d24, h1, crypto: p ? !!p.crypto : true };
}
const px$ = n => (n >= 1 ? money(n) : n > 0 ? '$' + (+n).toPrecision(3) : '—');
const pctTxt = p => `${p >= 0 ? '+' : ''}${(+p).toFixed(1)}%`;
function localTip() {
  const m = S.me, own = Object.keys(m.assets).filter(s => (m.assets[s] || 0) > 0 && !isStable(s) && quote(s).crypto);
  const pool = own.length ? own : ['BTC', 'ETH', 'SOL'], s = pool[Math.floor(Math.random() * pool.length)], q = quote(s);
  if (q.d24 < -0.3) return `${q.name} is down ${Math.abs(q.d24).toFixed(1)}% today. Paying with cash avoids locking in that drop; borrowing against your ${s} keeps it, but costs interest and gets riskier if it keeps falling.`;
  if (q.d24 > 0.3) return `${q.name} is up ${q.d24.toFixed(1)}% today. Selling a little ${s} to pay would take some profit (1% fee).`;
  return `${q.name} is flat today. Cash and USDC are the steadiest ways to pay.`;
}
function moversText() {
  const rows = MKT.map(m => quote(m[0])).filter(r => !isStable(r.sym)).sort((a, b) => Math.abs(b.h1) - Math.abs(a.h1)).slice(0, 2);
  const hour = new Date().toISOString().slice(0, 13), n = NEW_COINS.filter(c => seeded(c + hour) > 0.7).slice(0, 2);
  return (AI.movers ? `Biggest moves this hour: ${rows.map(r => `${r.name} ${pctTxt(r.h1)}`).join(' and ')}.` : '') + (AI.newCoins && n.length ? ` New and buzzing: ${n.join(', ')}.` : '');
}
// The AI tip shows instantly, and the server's AI tip replaces it when it arrives (never more than 5 seconds).
function loadTip() {
  U.tip = localTip(); const el = $('#tip', scrMe); if (el) el.textContent = U.tip;
  if (!AI.tips) return;
  Promise.race([api('insight', { style: AI.style, risk: AI.risk }), sleep(5000).then(() => null)])
    .then(r => { if (r?.text) { U.tip = r.text; const e = $('#tip', scrMe); if (e) e.textContent = r.text; } }).catch(() => {});
}
function loadMarket() { }

// ---------- what you pay with (saved on this phone) ----------
const PAYSEL = (() => { try { return { asset: 'USD', method: 'cash', ...JSON.parse(localStorage.getItem('cp_paysel') || '{}') }; } catch { return { asset: 'USD', method: 'cash' }; } })();
const savePaySel = () => { try { localStorage.setItem('cp_paysel', JSON.stringify(PAYSEL)); } catch {} };
const METHODS = { sell: 'Sell asset', borrow: 'Borrow against', cash: 'Use cash' };
function selOption() {
  if (PAYSEL.method === 'cash' || PAYSEL.asset === 'USD') return 'cash';
  return `${PAYSEL.method}:${PAYSEL.asset}`;
}
function assetLabel(sym) { return sym === 'USD' ? 'Cash' : quote(sym).name; }
function selButtons() {
  const a = PAYSEL.asset, q = a === 'USD' ? null : quote(a), have = a === 'USD' ? S.me.cash : (S.me.assets[a] || 0) * q.usd;
  return `<button class="selbtn" data-a="pickAsset"><span class="cico ${a === 'USD' ? 'usd' : ''}">${a === 'USD' ? '$' : esc(a.slice(0, 4))}</span>
      <span class="cn"><small>Pay with</small><b>${esc(assetLabel(a))}</b><small>${a === 'USD' ? 'US dollars' : `${px$(q.usd)} · today ${pctTxt(q.d24)}`} · you have ${money(have)}</small></span><span class="chev">›</span></button>
    <label class="selbtn wheel"><span class="cico how">${PAYSEL.method === 'borrow' ? '🏦' : PAYSEL.method === 'sell' ? '💱' : '💵'}</span>
      <span class="cn"><small>How</small><b>${esc(METHODS[a === 'USD' ? 'cash' : PAYSEL.method])}</b><small>${PAYSEL.method === 'borrow' && a !== 'USD' ? 'Keep it, 8% a year' : PAYSEL.method === 'sell' && a !== 'USD' ? 'Sell just enough, 1% fee' : 'No fee'}</small></span><span class="chev">⌄</span>
      <select data-sel="method" aria-label="How to pay">${Object.entries(METHODS).map(([k, v]) => `<option value="${k}" ${(a === 'USD' ? 'cash' : PAYSEL.method) === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`;
}

// Three tabs: Pay · Market (pretend) · Portfolio
const TABS = [['pay', '💳', 'Pay'], ['market', '📈', 'Market'], ['portfolio', '💼', 'Portfolio']];
function walletView() {
  const tab = U.tab || 'pay';
  if (U.picker) return pickerView();
  const head = `<div class="bar topbar"><span class="brand"><i>c</i>CryptoPal</span><span class="demochip">Demo · pretend money</span><button class="link gear" data-a="settings" aria-label="Settings">⚙︎</button></div>`;
  const body = tab === 'market' ? marketTab() : tab === 'portfolio' ? portfolioTab() : payTab();
  return `<div class="app tabbed">${head}${body}</div>
    <nav class="tabbar three">${TABS.map(([k, i, l]) => `<button class="${tab === k ? 'on' : ''}" data-a="tab" data-t="${k}"><span>${i}</span>${l}</button>`).join('')}</nav>${U.aiOpen ? aiSheet() : ''}${U.pad ? padView() : ''}`;
}
const aiBubble = (id, text) => `<div class="bubble"><button class="aiicon" data-a="aiOpen" aria-label="What the AI does">${AI_ICON}</button><p id="${id}">${esc(text)}</p></div>`;
function payTab() {
  return `${AI.tips ? aiBubble('tip', U.tip || localTip()) : ''}${msg()}
    <h4>Ready to pay</h4>${selButtons()}
    <button class="cta bigpay" data-a="pay">Pay</button><p class="hint2">or double-tap anywhere on this screen</p>`;
}
function pickLabel(id) {
  if (id === 'cash') return 'Use cash';
  const [m, a] = id.split(':'), n = assetLabel(a);
  return m === 'borrow' ? `Use ${n}, borrow against it` : `Use ${n}, sell a little`;
}
function localPick(usd) {
  const m = S.me, owned = Object.keys(m.assets).filter(s => (m.assets[s] || 0) > 0 && !isStable(s) && quote(s).crypto).map(quote);
  const worth = q => (m.assets[q.sym] || 0) * q.usd;
  const up = owned.filter(q => q.d24 > 1 && worth(q) >= usd).sort((a, b) => b.d24 - a.d24)[0];
  if (up) return { id: `sell:${up.sym}`, text: `${pickLabel('sell:' + up.sym)}. It's up ${up.d24.toFixed(1)}% today, so selling a little takes some profit (1% fee).` };
  if (m.cash >= usd) { const down = owned.filter(q => q.d24 < -0.5).sort((a, b) => a.d24 - b.d24)[0];
    return { id: 'cash', text: `Use cash. No fee${down ? `, and you don't sell ${down.name} while it's down ${Math.abs(down.d24).toFixed(1)}% today` : ''}.` }; }
  const st = Object.keys(m.assets).find(s => isStable(s) && (m.assets[s] || 0) >= usd * 1.02);
  if (st) return { id: `sell:${st}`, text: `${pickLabel('sell:' + st)}. It stays about $1, so you're not selling at a low (1% fee).` };
  const big = owned.sort((a, b) => worth(b) - worth(a))[0];
  if (big) return { id: `borrow:${big.sym}`, text: `${pickLabel('borrow:' + big.sym)}. You keep it, but it costs 8% a year and gets riskier if the price falls.` };
  return { id: 'cash', text: 'Add funds in Portfolio to pay.' };
}
function loadPickTip() {
  const usd = U.pay?.req?.usd || 20;
  U.pickTip = localPick(usd);
  Promise.race([api('suggest', { to: 'cafe', usd }), sleep(5000).then(() => null)]).then(g => {
    if (!g?.pick || !U.picker) return;
    U.pickTip = { id: g.pick.startsWith('give:') ? 'sell:' + g.pick.slice(5) : g.pick, text: `${pickLabel(g.pick.startsWith('give:') ? 'sell:' + g.pick.slice(5) : g.pick)}. ${g.reason}` };
    const e = $('#pickTip', scrMe), b = $('#pickUse', scrMe);
    if (e) e.textContent = U.pickTip.text; if (b) b.dataset.id = U.pickTip.id;
  }).catch(() => {});
}
// Page with everything you can pay with: price, today's move, how much you have and what it's worth.
function pickerView() {
  const m = S.me;
  const rows = [['USD', m.cash, 1]].concat(Object.entries(m.assets).filter(([s, u]) => u > 0 && quote(s).crypto).map(([s, u]) => [s, u, quote(s).usd]));
  const tip = U.pickTip || localPick(U.pay?.req?.usd || 20);
  return `<div class="app picker"><div class="bar"><button class="link" data-a="pickClose">‹ Back</button><b>Pay with</b><span></span></div>
    <div class="bubble"><span class="aiicon">${AI_ICON}</span><p id="pickTip">${esc(tip.text)}</p><button class="link usepick" id="pickUse" data-a="usePick" data-id="${esc(tip.id)}">Use this</button></div>
    ${rows.map(([s, u, p]) => { const q = s === 'USD' ? null : quote(s);
      return `<button class="prow ${PAYSEL.asset === s ? 'sel' : ''}" data-a="pickSet" data-s="${esc(s)}"><span class="cico ${s === 'USD' ? 'usd' : ''}">${s === 'USD' ? '$' : esc(s.slice(0, 4))}</span>
        <span class="cn"><b>${esc(assetLabel(s))}</b><small>${s === 'USD' ? 'US dollars' : `${px$(p)} each · today <span class="${q.d24 < 0 ? 'down' : 'up'}">${pctTxt(q.d24)}</span>`}</small></span>
        <span class="cv"><b>${money(u * p)}</b><small>${s === 'USD' ? 'cash' : `${amt(u)} ${esc(s)}`}</small></span></button>`; }).join('')}
    <p class="fine">Buy more coins in Market. Pretend money.</p></div>`;
}
const tradeForm = () => `<form data-f="trade" class="inline"><input name="usd" type="number" min="1" step="0.01" placeholder="${U.trade.side === 'buy' ? 'Buy' : 'Sell'} how many dollars?" required><button>${U.trade.side === 'buy' ? 'Buy' : 'Sell'}</button><button type="button" data-a="tradeX" class="ghost">×</button></form>`;
function marketTab() {
  const rows = MKT.map(m => quote(m[0])).map(r => `<div class="row mk"><div><b>${esc(r.name)}</b><small>${esc(r.sym)} · 1h <span class="${r.h1 < 0 ? 'down' : 'up'}">${pctTxt(r.h1)}</span> · 24h <span class="${r.d24 < 0 ? 'down' : 'up'}">${pctTxt(r.d24)}</span></small></div>
      <div class="r"><b>${px$(r.usd)}</b><span class="mini"><button data-a="trade" data-s="${esc(r.sym)}" data-side="buy">Buy</button><button data-a="trade" data-s="${esc(r.sym)}" data-side="sell">Sell</button></span></div></div>${U.trade?.sym === r.sym ? tradeForm() : ''}`).join('');
  return `${AI.movers || AI.newCoins ? aiBubble('movers', moversText()) : ''}${msg()}<h4>Crypto market · pretend trading</h4>${rows}
    <p class="fine">Pretend market for the demo. Prices are close to real; the moves are made up. Not financial advice.</p>`;
}
const ALLOC = ['#c6ff3d', '#8b5cff', '#ff4fd8', '#3de0ff', '#ffb547', '#7cffc4', '#ff8a5c', '#9fb4ff'];
function portfolioTab() {
  const m = S.me, px = S.prices;
  const items = [{ s: 'USD', u: m.cash, v: m.cash, n: 'Cash', crypto: false, ch: null }]
    .concat(Object.entries(m.assets).map(([s, u]) => { const q = quote(s); return { s, u, v: u * q.usd, n: q.name, crypto: q.crypto, ch: q.crypto ? q.d24 : null }; }));
  const sum = items.reduce((t, x) => t + x.v, 0) || 1;
  const bar = items.filter(x => x.v > 0).map((x, i) => `<span title="${esc(x.s)}" style="width:${(x.v / sum * 100).toFixed(2)}%;background:${ALLOC[i % ALLOC.length]}"></span>`).join('');
  const rows = items.map(x => `<div class="row"><div><b>${esc(x.n)}</b><small>${x.s === 'USD' ? 'US dollars' : `${amt(x.u)} ${esc(x.s)}${x.crypto ? '' : ' · money'}`} ${x.ch != null ? `<span class="${x.ch < 0 ? 'down' : 'up'}">${pctTxt(x.ch)}</span>` : ''}</small></div>
      <div class="r"><b>${money(x.v)}</b>${x.s === 'USD' ? '' : `<span class="mini"><button data-a="trade" data-s="${esc(x.s)}" data-side="buy">Buy</button><button data-a="trade" data-s="${esc(x.s)}" data-side="sell">Sell</button></span>`}</div></div>${U.trade?.sym === x.s ? tradeForm() : ''}`).join('');
  const loans = m.loans.map(l => `<div class="row ${l.warn ? 'warnrow' : ''}"><div><b>Loan on ${esc(l.asset)}</b><small>Owe ${money(l.owe)} · ${Math.round(l.ltv * 100)}% of its value</small></div><div class="r"><button data-a="repay" data-id="${l.id}">Repay</button></div></div>`).join('');
  return `<div class="total"><small>Your portfolio</small><div>${money(total())}</div></div><div class="alloc">${bar}</div>
    <div class="acts three"><button data-a="padOpen" data-k="add">＋ Add funds</button><button data-a="padOpen" data-k="send">↑ Send</button><button data-a="padOpen" data-k="receive">↓ Receive</button></div>${msg()}
    <h4>What you have</h4>${rows}
    <form data-f="asset" class="inline"><input name="sym" list="curlist" placeholder="Add crypto or any country's money (EUR, MXN, JPY…)" aria-label="Add a crypto or currency"><button>Add</button></form>
    <datalist id="curlist">${Object.entries(CUR).slice(0, 600).map(([k, v]) => `<option value="${esc(k)}">${esc(v.name)}</option>`).join('')}</datalist>
    ${loans ? `<h4>Loans</h4>${loans}` : ''}<h4>Activity</h4>${activity(8)}`;
}

// ---------- number pad: Add funds (pick where from), Send (pick who), Receive (get paid) ----------
const SOURCES = [['🏦', 'Bank account ••4021'], ['💳', 'Debit card ••7788'], ['', 'Apple Pay'], ['🅿️', 'PayPal']];
const PEOPLE = [['A', 'Ana'], ['M', 'Mom'], ['J', 'Jake'], ['R', 'Rosa']];
function padView() {
  const P = U.pad, title = { add: 'Add funds', send: 'Send', receive: 'Receive' }[P.kind], amtNum = +P.amt || 0;
  let body;
  if (P.step === 'amount') body = `<div class="padamt">$${esc(P.amt)}</div>
      <div class="keys">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map(k => `<button data-a="padKey" data-k="${k}">${k}</button>`).join('')}</div>
      <button class="cta" data-a="padNext" ${amtNum > 0 ? '' : 'disabled'}>${P.kind === 'add' ? 'Choose where from' : P.kind === 'send' ? 'Choose who' : 'Get paid'}</button>`;
  else if (P.step === 'pick') body = `<p class="padsum">${money(amtNum)}</p><p class="muted center2">${P.kind === 'add' ? 'Add from' : 'Send to'}</p>
      ${(P.kind === 'add' ? SOURCES : PEOPLE).map(([i, n]) => `<button class="prow" data-a="padPick" data-n="${esc(n)}"><span class="cico how">${esc(i)}</span><span class="cn"><b>${esc(n)}</b></span><span class="chev">›</span></button>`).join('')}`;
  else if (P.step === 'wait') body = `<p class="padsum">${money(amtNum)}</p><div class="qr" data-qr="${esc(location.origin + '/?w=' + W)}"></div><p class="status center2">Waiting for Ana to tap… (pretend)</p><div class="spin"></div>`;
  else if (P.step === 'busy') body = `<p class="padsum">${money(amtNum)}</p><div class="spin"></div><p class="status center2">${P.kind === 'add' ? 'Adding…' : 'Sending…'}</p>`;
  else body = `<div class="result ok"><div class="big">✓</div><b>${P.kind === 'add' ? `Added ${money(amtNum)}` : P.kind === 'send' ? `Sent ${money(amtNum)}` : `Got ${money(amtNum)}`}</b><p class="muted">${esc(P.done || '')}</p><button data-a="padClose">Done</button></div>`;
  return `<div class="sheet padsheet"><div class="grab"></div><div class="bar"><b>${title}</b><button class="link" data-a="padClose">Cancel</button></div>${P.err ? `<p class="note err">${esc(P.err)}</p>` : ''}${body}</div>`;
}

function aiSheet() {
  const tg = (k, t) => `<label class="tog"><input type="checkbox" data-ai="${k}" ${AI[k] ? 'checked' : ''}> ${t}</label>`;
  const opt = (k, v, t) => `<button class="${AI[k] === v ? 'on' : ''}" data-a="aiSet" data-k="${k}" data-v="${v}">${t}</button>`;
  return `<div class="sheet aisheet"><div class="grab"></div><div class="bar"><b class="aih">${AI_ICON} What the AI does</b><button class="link" data-a="aiClose">Done</button></div>
    ${tg('tips', 'Payment tips on the Pay tab')}${tg('movers', 'Big movers this hour on Market')}${tg('newCoins', 'Trending and new coins')}
    <p class="muted">How it talks</p><div class="seg">${opt('style', 'short', 'Short')}${opt('style', 'detailed', 'More detail')}</div>
    <p class="muted">Your style</p><div class="seg">${opt('risk', 'careful', 'Careful')}${opt('risk', 'bold', 'Bolder')}</div>
    <p class="fine">AI tips are news and ideas, not financial advice. CryptoPal and its AI aren't responsible for gains or losses. Every choice is yours.</p></div>`;
}

function activity(limit = 12) {
  if (!S.tx.length) return '<p class="muted">Nothing yet.</p>';
  const label = { done: 'Done', held: 'Waiting 24 h', processing: 'Processing', blocked: 'Blocked', canceled: 'Canceled', undone: 'Undone', sending: 'Sending' };
  return S.tx.slice(0, limit).map(t => {
    const out = t.from === 'me' && t.to !== 'me', inn = t.to === 'me' && t.from !== 'me';
    const what = t.kind === 'topup' ? (t.source ? `Added from ${esc(t.source)}` : t.from === 'demo' ? 'Added demo money' : 'Added with PayPal') : t.kind === 'buy' ? `Bought ${esc(t.asset)}` : t.kind === 'sell' ? `Sold ${esc(t.asset)}` : out ? `To ${esc(t.toName)}` : `From ${esc(t.fromName)}`;
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
    <div class="bar"><button class="link" data-a="wallet">‹ Back</button><b>Settings</b><span></span></div>
    <div class="card"><b>${AI_ICON} AI</b><p class="muted">Choose what the AI tells you about.</p><button class="ghost" data-a="aiOpenSettings">What the AI does</button></div>
    <div class="card"><b>Demo</b><p class="muted">Everything in this demo is pretend money in a sandbox. Start over any time.</p><button class="ghost" data-a="resetDemo">Reset demo</button></div>
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

// Face setup: one look per angle. Each angle is saved (on this phone only) so any angle unlocks later,
// and a photo held up to the camera can't turn its head.
const FACE_LOOKS = [
  { id: 'straight', say: 'Look straight at the camera', tip: 'Look straight at the camera.', ok: r => Math.abs(r.yaw) < 0.15 },
  { id: 'side1', say: 'Slowly turn your head to one side', tip: 'Turn your head a little more to the side.', ok: (r, b) => Math.abs(r.yaw - b.yaw) > 0.22 },
  { id: 'side2', say: 'Now turn to the other side', tip: 'Keep turning the other way.', ok: (r, b, s) => (r.yaw - b.yaw) * s < -0.22 },
  { id: 'up', say: 'Tilt your head up', tip: 'Tilt your chin up a little more.', ok: (r, b) => r.pitch - b.pitch < -0.1 },
  { id: 'down', say: 'Tilt your head down', tip: 'Tilt your chin down a little more.', ok: (r, b) => r.pitch - b.pitch > 0.12 }
];

function setupView() {
  const st = U.setup;
  if (st.step === 1) return `<form class="app setup" data-f="setup1"><span class="brand"><i>c</i>CryptoPal</span><h3>Set up CryptoPal</h3><p class="muted">A demo with pretend money.</p>
    <label>Your name<input name="name" value="${esc(st.name || '')}" placeholder="Michael" required maxlength="24"></label>
    <label>Phrase you'll say to pay<input name="phrase" value="${esc(st.phrase || 'pay the man')}" required></label>
    <button>Next</button>${msg()}</form>`;
  if (st.step === 2) return `<div class="app setup"><h3>Your face</h3><div class="scan ${st.faceDone ? 'ok' : ''}"><video id="cam" class="cam" playsinline muted></video></div>
    <p class="phrase" id="look">${st.faceDone ? 'Face saved ✓' : 'Look at the camera'}</p><p class="muted">Saved on this phone only.</p>
    <button data-a="faceSave">${st.faceDone ? 'Next' : 'Save my face'}</button><p id="note" class="note"></p></div>`;
  return `<div class="app setup"><h3>Your voice</h3><p>Say your phrase once so CryptoPal saves your voice print:</p><p class="phrase">“${esc(st.phrase)}”</p>
    <button class="mic big ${U.listening ? 'on' : ''}" data-a="voiceSave">${ICON.mic}<span>${U.listening ? 'Listening… tap when done' : 'Tap and say it'}</span></button><p id="note" class="note"></p></div>`;
}

function verifyView() {
  const k = U.verify?.kind || 'unlock';
  return `<div class="app setup"><div class="bar"><button class="link" data-a="wallet">‹ Back</button><b>${k === 'unlock' ? 'Verify it\'s you' : 'Change security'}</b><span></span></div>
    <p class="muted">This phone compares your photo ID with a live selfie and your saved face. Your photos stay on this phone; CryptoPal only gets how well they match, and a person reviews it. ${k === 'unlock' ? 'In real life you also call in.' : 'Changes start 24 hours after approval.'}</p>
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
  if (r.status === 'error') return `<div class="result bad"><div class="big">✕</div><b>Didn't go through</b><p>${esc(r.message)}</p><button data-a="close">OK</button></div>`;
  return `<div class="result"><b>${esc(r.status)}</b><button data-a="close">OK</button></div>`;
}

// ---------- open CryptoPal with your face (checked on this phone) ----------
function gateView() {
  return `<div class="flow gate">
    <div class="flow-top"><span class="brand"><i>c</i>CryptoPal</span><button class="link" data-a="lock">Cancel</button></div>
    ${S.simulate ? '<div class="scan"><div class="face-ph">🙂</div></div>' : '<div class="scan"><video id="cam" class="cam" playsinline muted></video></div>'}
    <h2>${U.gateNext === 'pay' ? 'Look to pay' : 'Look to open'}</h2>
    <p class="status" id="note">${S.simulate ? 'Demo mode: the face check is simulated.' : 'Hold your phone like a mirror.'}</p>
    ${S.simulate ? '<button class="cta" data-a="gateSim">Continue</button>' : '<button class="ghost skipface" data-a="gateSim" hidden>Skip face check</button>'}</div>`;
}
let gateRun = 0;
async function runGate() {
  const run = ++gateRun, saved = myFace(W);
  // Never get stuck: after 6 seconds without a match, offer to skip.
  setTimeout(() => { if (run === gateRun && U.screen === 'gate') { const b = $('.skipface', scrMe); if (b) b.hidden = false; } }, 6000);
  if (!saved) { $('.skipface', scrMe)?.removeAttribute('hidden'); return note("This phone doesn't have your face saved yet. You can skip for now.", true); }
  note(FACE_DL.done ? 'Looking for you…' : 'Getting the face check ready…');
  const started = Date.now();
  let misses = 0;
  try {
    await loadFace();
    while (run === gateRun && U.screen === 'gate') {
      const v = $('#cam', scrMe); if (!v) return;
      const f = await faceFrom(v, 1).catch(() => null);
      if (run !== gateRun || U.screen !== 'gate') return;
      if (f && faceDist(f, saved) <= SAME) return gateOpen();
      if (f && ++misses >= 6) note("That's not the owner's face.", true);
      else if (!f) note(Date.now() - started > 4000 ? "I can't see your face. Get closer, with light on your face." : 'Looking for you…');
      await new Promise(r => setTimeout(r, 120));
    }
  } catch { note("The face check didn't load. Check your connection.", true); }
}
function gateOpen() {
  U.unlockedAt = Date.now(); gateRun++;
  const next = U.gateNext; U.gateNext = null;
  $('.scan', scrMe)?.classList.add('ok');
  setTimeout(() => { camOff(); U.screen = next === 'pay' ? 'pay' : 'wallet'; if (next === 'pay' && !U.pay) U.pay = { step: 'how' }; renderMe(); }, 500);
}

// ---------- pay: double-tap → Face ID, CryptoPal face, voice (hands-free) → your saved choice + AI tip → Pay now → hold near the reader ----------
// A demo: any face and any voice pass. Everything is pretend money in a sandbox.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SHOPS = [['Latte + croissant', 6.5], ['Groceries', 23.75], ['Gas', 42.18], ['Lunch', 14.2], ['Movie tickets', 31]];
const CHECKS = ['iPhone Face ID', 'CryptoPal face', 'Voice ID'];
function nativeFaceID() { // iPhone Face ID: only inside the CryptoPal iPhone app (null in a browser)
  const h = window.webkit?.messageHandlers?.cp;
  if (!h) return Promise.resolve(null);
  return new Promise(res => {
    const id = Math.random().toString(36).slice(2);
    (window.__cpWait ||= {})[id] = res;
    h.postMessage({ type: 'faceid', id });
    setTimeout(() => { if (window.__cpWait[id]) { delete window.__cpWait[id]; res(null); } }, 30000);
  });
}
window.__cpNative = (id, ok) => { const f = window.__cpWait?.[id]; if (f) { delete window.__cpWait[id]; f(ok); } };
// iPhone only lets a page hear the microphone level if sound was started by a tap, so this runs during the double-tap.
function unlockAudio() { try { window.__cpAC ||= new (window.AudioContext || window.webkitAudioContext)(); window.__cpAC.resume(); } catch { } }
// Listens on its own: stops 2 seconds after you stop talking (14 seconds at most). Any voice passes.
async function autoListen(onLevel, streamP) {
  const stream = await (streamP || navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null));
  if (!stream) { await sleep(800); return false; }
  const ac = window.__cpAC;
  if (!ac || ac.state !== 'running') { await sleep(3000); stream.getTracks().forEach(t => t.stop()); return true; }
  const an = ac.createAnalyser(); an.fftSize = 1024; const src = ac.createMediaStreamSource(stream); src.connect(an);
  const buf = new Float32Array(an.fftSize), t0 = Date.now();
  let floor = 0.01, spoke = false, last = 0, n = 0;
  return new Promise(res => {
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let sum = 0; for (const x of buf) sum += x * x;
      const rms = Math.sqrt(sum / buf.length), now = Date.now();
      if (now - t0 < 400) floor = Math.max(floor, rms * 2.5); // learn the room noise first
      else if (rms > Math.max(0.02, floor)) { spoke = true; last = now; }
      if (++n % 3 === 0) onLevel(Math.min(1, rms * 8));
      if ((spoke && now - last > 2000) || now - t0 > 14000 || (!spoke && now - t0 > 10000)) {
        src.disconnect(); stream.getTracks().forEach(t => t.stop()); res(spoke);
      } else setTimeout(tick, 50);
    };
    tick();
  });
}

function openPay() {
  if (!S?.me.enrolled) return;
  unlockAudio();
  U.sheet = null; U.msg = null; U.trade = null; U.aiOpen = false; U.picker = false; U.pad = null;
  U.pay = { step: 'check', checks: [0, 0, 0], notes: [] };
  // Open the microphone right away (while Face ID and the face scan run), so the voice step starts instantly.
  U.pay.micP = navigator.mediaDevices?.getUserMedia ? navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null) : Promise.resolve(null);
  U.screen = 'pay'; renderMe(); runChecks(U.pay);
}
async function runChecks(P) {
  const live = () => U.pay === P && P.step === 'check';
  const set = (i, v, n) => { P.checks[i] = v; if (n) P.notes[i] = n; if (live()) renderMe(); };
  const [memo, usd] = SHOPS[Math.floor(Math.random() * SHOPS.length)]; // the register rings you up (pretend)
  P.reqP = api('request', { by: 'cafe', usd, memo }).then(r => { P.req = r.request; }).catch(() => {});
  // All three start together: listening for your voice runs while iPhone Face ID and the face scan happen.
  set(0, 1); set(2, 1, 'Listening… say your phrase');
  const voiceP = autoListen(l => { const b = $('.lvl', scrMe); if (b) b.style.transform = `scaleX(${0.15 + l})`; }, P.micP)
    .then(spoke => { if (live()) set(2, 2, spoke ? 'Voice print matched' : 'Voice matched'); });
  const fid = await nativeFaceID();
  if (!live()) return;
  if (fid === false) { set(0, 0, "Face ID didn't work. Tap Cancel and try again."); return; }
  set(0, 2, 'Matched');
  P.cam = true; set(1, 1);
  await sleep(250);
  await Promise.race([faceFrom($('#cam', scrMe), 3).catch(() => null), sleep(1000)]);
  if (!live()) return;
  set(1, 2, 'Face matched');
  await voiceP;
  if (!live()) return;
  await sleep(400); camOff();
  if (!live()) return;
  P.step = 'confirm'; P.cam = false; renderMe(); payOptions(P);
}
async function payOptions(P) { // the AI looks at your saved choice (in the background; never blocks Pay now)
  await P.reqP;
  if (!P.req) { P.error = "Couldn't reach the register. Tap Cancel and try again."; if (U.pay === P) renderMe(); return; }
  if (U.pay === P) renderMe();
  try {
    const g = await Promise.race([api('suggest', { to: 'cafe', usd: P.req.usd }), sleep(6000).then(() => null)]);
    if (g) { P.sug = g; if (U.pay === P && P.step === 'confirm') renderMe(); }
  } catch { }
}
const WAY_ICON = { cash: '💵', sell: '💱', give: '🪙', borrow: '🏦' };
function payView() {
  const P = U.pay, top = `<div class="flow-top"><span class="brand"><i>c</i>CryptoPal</span><button class="link" data-a="payX">Cancel</button></div>`;
  if (U.picker) return pickerView();
  if (P.step === 'check') {
    const cls = i => (P.checks[i] === 2 ? 'done' : P.checks[i] === 1 ? 'now' : '');
    return `<div class="flow">${top}<div class="scan ${P.checks[1] === 2 ? 'ok' : ''}">${P.cam ? '<video id="cam" class="cam" playsinline muted></video>' : '<div class="face-ph">🔒</div>'}</div>
      <h2>Checking it's you</h2>
      <ol class="checks">${CHECKS.map((c, i) => `<li class="${cls(i)}"><span class="dot">${P.checks[i] === 2 ? '✓' : i + 1}</span><span class="ct"><b>${c}</b>${P.notes[i] ? `<small>${esc(P.notes[i])}</small>` : ''}${i === 2 && P.checks[2] === 1 ? '<span class="lvlbox"><span class="lvl"></span></span>' : ''}</span></li>`).join('')}</ol></div>`;
  }
  if (P.step === 'confirm') {
    if (P.error) return `<div class="flow">${top}<h2>Something went wrong</h2><p class="status err">${esc(P.error)}</p><button class="cta" data-a="payX">Back</button></div>`;
    const g = P.sug, pick = g?.options.find(o => o.id === g.pick), mine = selOption();
    const tip = !g ? 'Looking at the smartest way to pay…' : pick && pick.id !== mine ? `Smartest move: ${pick.label}. ${g.reason}` : `Good choice. ${g.reason}`;
    return `<div class="flow">${top}<div class="shop"><small>Corner Café · ${esc(P.req?.memo || '')}</small><p class="amount">${P.req ? money(P.req.usd) : '…'}</p></div>
      <div class="bubble"><span class="aiicon">${AI_ICON}</span><p>${esc(tip)}</p>${pick && pick.id !== mine ? `<button class="link usepick" data-a="usePick" data-id="${esc(pick.id)}">Use the AI pick</button>` : ''}</div>
      ${selButtons()}
      <p class="fine">AI picks are ideas, not financial advice. CryptoPal and its AI aren't responsible for gains or losses. Every choice is yours.</p>
      <button class="cta" data-a="payNow" ${P.req ? '' : 'disabled'}>Pay now</button></div>`;
  }
  const opt = selOption(), label = opt === 'cash' ? 'Cash' : `${METHODS[PAYSEL.method]} · ${assetLabel(PAYSEL.asset)}`;
  if (P.step === 'tap') return `<div class="flow tapflow">${top}
    <div class="ripple"><span></span><span></span><span></span>${ICON.tap}</div>
    <h2>Hold near the reader</h2><p class="amount sm">${money(P.req.usd)}<small>${esc(label)} → Corner Café</small></p>
    <p class="status" id="authStatus">${P.busy ? 'Paying… the AI watchdog is checking it.' : 'Keep your phone close to the register.'}</p>
    <button class="ghost" data-a="payX">Cancel</button></div>`;
  return `<div class="flow">${top}${resultView(P.result).replaceAll('data-a="close"', 'data-a="payX"')}</div>`;
}
async function payTap() {
  const P = U.pay;
  if (!P || P.step !== 'tap' || P.busy || P.sent) return;
  P.busy = true; P.sent = true; renderMe();
  try {
    P.result = await api('send', { auth: { demo: true }, to: 'cafe', usd: P.req.usd, option: selOption(), requestId: P.req.id });
  } catch (e) { P.result = { status: 'error', message: /way to pay|option/i.test(e.message) ? `You don't have enough ${assetLabel(PAYSEL.asset)} for that. Pick something else.` : e.message }; }
  P.step = 'result'; P.busy = false;
  await refresh(true); if (U.pay === P) renderMe();
}
// Face check for the old send / cancel / undo screens: 6 seconds at most.
async function quickFace() {
  if (S.simulate) return { ok: false, dist: null, skipped: false };
  const saved = myFace(W), video = $('#cam', scrMe);
  if (!saved || !video) return { ok: false, dist: null, skipped: true };
  const face = await Promise.race([faceFrom(video, 12).catch(() => null), sleep(6000).then(() => null)]);
  if (!face) return { ok: false, dist: null, skipped: true };
  const dist = faceDist(face, saved);
  return dist > SAME ? { mismatch: true } : { ok: true, dist, skipped: false };
}

function openSheet(mode, extra = {}) {
  if (!S?.me.enrolled) return;
  if (mode === 'pay') return openPay();
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
    const v = await api('voice', { purpose: 'phrase', ...spoken });
    setAuth(`Heard “${v.text}”. Checking your face…`);
    // Compared on this phone. Only "it matched" and how close goes to CryptoPal, never the face.
    const fc = await quickFace();
    if (fc.mismatch) throw new Error("That face doesn't match the owner.");
    setAuth('AI watchdog is checking this payment…');
    const auth = { checkId: v.checkId, faceOk: fc.ok, faceDist: fc.dist, faceSkipped: fc.skipped, faceSim: !!S.simulate };
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
  aiOpenSettings: () => { U.screen = 'wallet'; U.aiOpen = true; renderMe(); },
  resetDemo: async () => { if (!confirm('Start the demo over?')) return; await api('demo', { reset: true }); forgetMyFace(W); Object.assign(U, { screen: 'setup', setup: { step: 1 }, sheet: null, pay: null, msg: null, tip: null, tab: 'pay' }); camOff(); await refresh(true); renderMe(); },
  lock: () => { U.screen = 'home'; U.sheet = null; U.pay = null; U.msg = null; U.unlockedAt = 0; gateRun++; camOff(); renderMe(); },
  gateSim: () => gateOpen(),
  payX: () => { clearTimeout(U.pay?.tapTimer); U.pay?.micP?.then(st => st?.getTracks().forEach(t => t.stop())); U.pay = null; U.listening = false; U.screen = 'wallet'; U.tab = 'pay'; camOff(); renderMe(); loadTip(); },
  payRetry: () => { U.pay = { step: 'how', reqId: U.pay?.reqId }; renderMe(); },
  payPick: el => { U.pay.option = el.dataset.id; scrMe.querySelectorAll('.way').forEach(b => b.classList.toggle('sel', b === el)); },
  payGo: () => { Object.assign(U.pay, { step: 'say', error: null }); renderMe(); },
  paySay: async () => {
    const p = listen(on => { U.listening = on; const b = $('[data-a=paySay] span', scrMe); if (b) b.textContent = on ? 'Listening… tap to stop' : 'Got it'; $('[data-a=paySay]', scrMe)?.classList.toggle('on', on); });
    if (!p) return;
    try { const audio = await p; await paySay({ audio }); } catch (e) { setAuth(e.message, true); }
  },
  payTap: () => { clearTimeout(U.pay?.tapTimer); payTap(); },
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
  tab: el => { U.tab = el.dataset.t; U.trade = null; U.msg = null; U.aiOpen = false; U.pad = null; U.picker = false; if (U.tab === 'pay') loadTip(); renderMe(); scrMe.scrollTop = 0; },
  pay: () => openPay(),
  pickAsset: () => { U.picker = true; loadPickTip(); renderMe(); scrMe.scrollTop = 0; },
  pickClose: () => { U.picker = false; renderMe(); },
  pickSet: el => { PAYSEL.asset = el.dataset.s; if (PAYSEL.asset === 'USD') PAYSEL.method = 'cash'; else if (PAYSEL.method === 'cash') PAYSEL.method = 'sell'; savePaySel(); U.picker = false; renderMe(); },
  usePick: el => { const id = el.dataset.id; if (id === 'cash') { PAYSEL.asset = 'USD'; PAYSEL.method = 'cash'; } else { const [m, a] = id.split(':'); PAYSEL.asset = a; PAYSEL.method = m === 'give' ? 'sell' : m; } savePaySel(); U.picker = false; renderMe(); },
  padOpen: el => { U.pad = { kind: el.dataset.k, step: 'amount', amt: '0' }; renderMe(); },
  padClose: () => { U.pad = null; renderMe(); },
  padKey: el => { const P = U.pad, k = el.dataset.k; let a = P.amt;
    if (k === '⌫') a = a.length > 1 ? a.slice(0, -1) : '0';
    else if (k === '.') { if (!a.includes('.')) a += '.'; }
    else if (!(a.includes('.') && a.split('.')[1].length >= 2) && a.replace('.', '').length < 7) a = a === '0' ? k : a + k;
    P.amt = a; P.err = null; renderMe(); },
  padNext: async () => { const P = U.pad;
    if (P.kind === 'receive') { P.step = 'wait'; renderMe(); await sleep(2500); if (U.pad !== P) return;
      try { await api('pretend', { kind: 'receive', usd: +P.amt, who: 'Ana' }); P.done = 'From Ana (pretend)'; P.step = 'done'; } catch (e) { P.err = e.message; P.step = 'amount'; }
      await refresh(true); renderMe(); return; }
    P.step = 'pick'; renderMe(); },
  padPick: async el => { const P = U.pad, who = el.dataset.n; P.step = 'busy'; renderMe();
    try {
      if (P.kind === 'add') { await api('addcash', { usd: +P.amt, source: who }); P.done = `From ${who} (pretend)`; }
      else { await api('pretend', { kind: 'send', usd: +P.amt, who }); P.done = `To ${who} (pretend)`; }
      await sleep(600); P.step = 'done';
    } catch (e) { P.err = e.message; P.step = 'amount'; }
    await refresh(true); renderMe(); },
  payNow: () => { if (!U.pay?.req) return; Object.assign(U.pay, { step: 'tap', busy: false, tapTimer: null }); renderMe(); },
  aiOpen: () => { U.aiOpen = true; renderMe(); },
  aiClose: () => { U.aiOpen = false; renderMe(); if ((U.tab || 'pay') === 'pay') loadTip(); },
  aiSet: el => { AI[el.dataset.k] = el.dataset.v; saveAI(); renderMe(); },
  faceSave: async () => {
    const st = U.setup;
    if (st.faceDone) { camOff(); st.step = 3; renderMe(); return; }
    note('Scanning your face…');
    const seen = await Promise.race([faceFrom($('#cam', scrMe), 4).catch(() => null), sleep(1600).then(() => null)]);
    st.faceDone = true; st.faceSeen = !!seen; renderMe();
  },
  voiceSave: async () => {
    const p = listen(on => { U.listening = on; const b = $('[data-a=voiceSave] span', scrMe); if (b) b.textContent = on ? 'Listening… tap when done' : 'Saving your voice print…'; $('[data-a=voiceSave]', scrMe)?.classList.toggle('on', on); });
    if (!p) return;
    await Promise.race([p.catch(() => null), sleep(8000)]); // any voice works in the demo (a blocked mic never gets you stuck)
    try {
      await api('setup', { demo: true, name: U.setup.name, phrase: U.setup.phrase });
      U.setup = { step: 1 }; U.screen = 'wallet'; U.tab = 'pay'; U.msg = { t: 'All set. Tap Pay, or double-tap anywhere on the Pay tab.' };
      await refresh(true); renderMe(); loadTip();
    } catch (e) { note(e.message, true); }
  },
  demoCash: async el => { try { const r = await api('addcash', { usd: +el.dataset.usd }); U.msg = { t: `Added ${money(r.usd)} (demo money).` }; } catch (e) { U.msg = { t: e.message, bad: 1 }; } await refresh(true); renderMe(); },
  repay: async el => { try { await api('repay', { loanId: el.dataset.id }); U.msg = { t: 'Loan repaid.' }; } catch (e) { U.msg = { t: e.message, bad: 1 }; } await refresh(true); renderMe(); },
  addcash: () => addCash(),
  verify: el => { U.verify = { kind: el.dataset.k }; U.sheet = null; U.screen = 'verify'; renderMe(); },
  talk: async () => {
    const p = listen(on => { U.listening = on; const b = $('[data-a=talk] span', scrMe); if (b) b.textContent = on ? 'Listening… tap to stop' : 'Thinking…'; $('[data-a=talk]', scrMe)?.classList.toggle('on', on); });
    if (!p) return;
    try { const audio = await p; await command({ audio }); } catch (e) { U.msg = { t: e.message, bad: 1 }; renderMe(); }
  },
  faceEnroll: async () => {
    if (S.simulate) { U.setup.faces = null; U.setup.step = 3; renderMe(); return; }
    if (U.setup.capturing) return;
    U.setup.capturing = true;
    const video = $('#cam', scrMe), btn = $('[data-a=faceEnroll]', scrMe), skip = $('[data-a=faceSkip]', scrMe);
    if (btn) btn.hidden = true;
    note(FACE_DL.done ? 'Looking for your face…' : 'Finishing the download first…');
    const faces = [];
    let base = null, side = 0, last = null;
    // If the face check is slow to start on this phone, offer to skip face setup after 10 seconds.
    const slow = setTimeout(() => { if (skip && U.setup.capturing) { skip.textContent = 'Skip face setup'; skip.dataset.all = '1'; skip.hidden = false; note('The face check is slow on this phone. You can skip it for now.', true); } }, 10000);
    try {
      await loadFace();
      clearTimeout(slow); if (U.setup.step !== 2) return; if (skip) { skip.textContent = 'Skip this angle'; delete skip.dataset.all; skip.hidden = true; }
      for (let i = 0; i < FACE_LOOKS.length; i++) {
        const step = FACE_LOOKS[i], started = Date.now();
        $('#look', scrMe).textContent = step.say;
        U.setup.skip = false;
        for (;;) {
          if (!$('#cam', scrMe)) return; // left the screen
          if (Date.now() - started > 12e3 && skip) skip.hidden = false;
          const r = await faceAndPose(video).catch(() => null);
          if (r) last = r;
          const ok = r && step.ok(r, base, side);
          if (ok || (U.setup.skip && last)) {
            const got = ok ? r : last;
            if (i === 0) base = got;
            if (step.id === 'side1') side = Math.sign(got.yaw - base.yaw) || 1;
            faces.push(got.face);
            $('#lookDots', scrMe).textContent = FACE_LOOKS.map((_, k) => (k <= i ? '●' : '○')).join(' ');
            note(i < FACE_LOOKS.length - 1 ? 'Got it.' : 'All angles saved.');
            if (skip) skip.hidden = true;
            break;
          }
          if (!r) note("I can't see your face. Get closer, with light on your face.", true);
          else note(step.tip);
          await new Promise(res => setTimeout(res, 150));
        }
      }
      U.setup.faces = faces; camOff(); U.setup.step = 3; renderMe();
    } catch { note("The face check didn't load. Check your connection and try again.", true); if (btn) btn.hidden = false; }
    finally { U.setup.capturing = false; }
  },
  faceSkip: el => { if (el.dataset.all) { U.setup.capturing = false; U.setup.faces = null; U.setup.noFace = true; camOff(); U.setup.step = 3; renderMe(); } else U.setup.skip = true; },
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
    if (!V.selfieFace) return note('No face in the selfie. Take it again with more light.', true);
    // The photos and faces stay on this phone. CryptoPal only gets how well they match.
    const saved = myFace(W);
    const body = {
      kind: V.kind, photosOnDevice: true, idFaceFound: !!V.idFace,
      idVsSelfie: V.idFace ? faceDist(V.idFace, V.selfieFace) : null,
      selfieVsOwner: saved ? faceDist(V.selfieFace, saved) : null,
      idVsOwner: saved && V.idFace ? faceDist(V.idFace, saved) : null
    };
    if (V.kind === 'change') Object.assign(body, { night: $('#vNight', scrMe).value, hold: $('#vHold', scrMe).value, phrase: $('#vPhrase', scrMe).value, panic: $('#vPanic', scrMe).value });
    try { await api('verify', body); camOff(); U.verify = null; U.screen = 'wallet'; U.msg = { t: 'Sent. A person at CryptoPal will review the match. Your photos never left this phone.' }; await refresh(true); renderMe(); }
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
    // The face stays on this phone: the server only learns that one was saved here.
    await api('setup', { name: st.name, phrase: st.phrase, panic: st.panic, faceOnDevice: !!st.faces?.length, faceSkipped: !!st.noFace, faceSim: !!S.simulate, checkId: v.checkId });
    if (st.faces?.length) saveMyFace(W, st.faces);
    U.setup = { step: 1 }; U.screen = 'wallet'; U.unlockedAt = Date.now(); U.msg = { t: SOLO ? 'All set. Double-tap the lock screen (or hold your Action Button) to pay.' : 'All set. Double-click the side button to pay.' };
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

let lastTap = 0;
scrMe.addEventListener('click', e => {
  if (U.screen !== 'wallet' || (U.tab || 'pay') !== 'pay' || U.aiOpen || U.picker || U.pad || e.target.closest('button, input, select, label, summary, details, a, form, .bubble')) return;
  const now = Date.now();
  if (now - lastTap < 400) { lastTap = 0; openPay(); } else lastTap = now;
});
// Buttons press in while your finger is down, and the next page opens only after you lift it
// (with a short beat so the press shows clearly in a screen recording).
const PRESSABLE = 'button, .selbtn, .prow, a.btn, summary';
let pressedEl = null;
document.addEventListener('pointerdown', e => { const b = e.target.closest(PRESSABLE); if (!b || b.disabled) return; pressedEl = b; b.classList.add('pressed'); }, { passive: true });
const unpress = () => { const b = pressedEl; pressedEl = null; if (b) setTimeout(() => b.classList.remove('pressed'), 160); };
document.addEventListener('pointerup', unpress, { passive: true });
document.addEventListener('pointercancel', unpress, { passive: true });
scrMe.addEventListener('click', e => {
  const a = e.target.closest('[data-a]');
  if (!a || !actions[a.dataset.a]) return;
  e.preventDefault();
  if (a.dataset.a === 'pay') unlockAudio(); // the microphone level needs sound started during the tap itself
  a.classList.add('pressed');
  setTimeout(() => { a.classList.remove('pressed'); actions[a.dataset.a](a); }, 150);
});
scrMe.addEventListener('change', async e => {
  if (e.target.dataset.ai) { AI[e.target.dataset.ai] = e.target.checked; saveAI(); return; }
  if (e.target.dataset.sel === 'method') { PAYSEL.method = e.target.value; if (PAYSEL.method !== 'cash' && PAYSEL.asset === 'USD') { const own = Object.keys(S.me.assets).find(s => S.me.assets[s] > 0 && quote(s).crypto); if (own) PAYSEL.asset = own; } if (PAYSEL.method === 'cash') PAYSEL.asset = 'USD'; savePaySel(); renderMe(); return; }
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
    case 'payTyped': await paySay({ text: d.t, speech: U.speech }); break;
    case 'send': Object.assign(sh, { to: d.to, usd: +d.usd, prefer: d.prefer || null, memo: d.memo, toName: d.to === 'ana' ? 'Ana' : 'Corner Café' }); await suggest(sh); break;
    case 'receive':
      try { const r = await api('request', { by: 'me', usd: +d.usd, asset: d.asset || null }); Object.assign(sh, { req: r.request, step: 'code', error: null }); await refresh(true); renderMe(); }
      catch (er) { sh.error = er.message; renderMe(); } break;
    case 'asset': try { await api('asset', { symbol: d.sym }); U.msg = { t: `${d.sym.toUpperCase()} added.` }; } catch (er) { U.msg = { t: er.message, bad: 1 }; } await refresh(true); renderMe(); break;
    case 'trade': try { if (!(U.trade.sym in S.me.assets)) await api('asset', { symbol: U.trade.sym }); await api('trade', { asset: U.trade.sym, side: U.trade.side, usd: +d.usd }); U.msg = { t: 'Done.' }; U.trade = null; } catch (er) { U.msg = { t: er.message, bad: 1 }; } await refresh(true); renderMe(); break;
    case 'lower': try { await api('limits', { night: +d.night, hold: +d.hold }); U.msg = { t: 'Saved.' }; } catch (er) { U.msg = { t: er.message, bad: 1 }; } await refresh(true); renderMe(); break;
  }
});

// Side button: double-click opens CryptoPal ready to pay, like Apple Pay.
let lastSide = 0;
$('#side').addEventListener('click', () => {
  const now = Date.now();
  if (now - lastSide < 450) { lastSide = 0; openPay(); }
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
    <p class="muted">Same demo, real camera and mic.</p>
    <h4>Hold the Action Button to pay</h4>
    <p class="muted">In the Shortcuts app, make a Shortcut with “Open URLs” and this link. Then Settings → Action Button → Shortcut → pick it. Holding the button opens CryptoPal ready to pay (it opens in Safari, so set up your face in Safari too).</p>
    <input class="paylink" readonly value="${esc(location.origin + '/?w=' + W + '&pay=1')}" onclick="this.select()" aria-label="Pay link for the Action Button">
    <button class="ghost" data-d="copypay">Copy pay link</button>
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
  if (k === 'copypay') { const i = $('.paylink', demo); try { await navigator.clipboard.writeText(i.value); e.target.textContent = 'Copied'; } catch { i.select(); } return; }
  if (k === 'skip') { await api('demo', { skipHours: 24 }); await refresh(true); renderMe(); }
  if (k === 'reset' && confirm('Start the demo over?')) { await api('demo', { reset: true }); forgetMyFace(W); Object.assign(U, { screen: 'home', setup: { step: 1 }, sheet: null, msg: null }); O.reqId = null; camOff(); await refresh(true); renderMe(); renderOther(); }
});

// ---------- start ----------
(async () => {
  renderMe();
  // Show your money right away; the long list of currencies (for Add) loads in the background.
  fetch('/api/currencies').then(r => r.json()).then(c => { CUR = c || {}; }).catch(() => {});
  CFG = await fetch('/api/config').then(r => r.json()).catch(() => ({}));
  await refresh(true);
  const req = params.get('req');
  if (req && S.me.enrolled) {
    const r = S.requests.find(x => x.id === req);
    if (r && r.by !== 'me') openPay();
  } else if (params.get('pay') && S.me.enrolled) openPay(); // the Action Button / Shortcut link opens straight into paying
  if (S.me.enrolled && U.screen === 'wallet') loadTip();
  setInterval(() => document.visibilityState === 'visible' && refresh(), 3000);
  setInterval(() => { const c = $('.clock', scrMe); if (c && S) c.textContent = new Date(Date.now() + (S.now - Date.now())).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M/, ''); }, 30000);
})();
