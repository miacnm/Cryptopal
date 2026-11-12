// CryptoPal: pay with crypto in a tap, with AI picking the smartest way to pay
// and guarding every send. One Durable Object ("world") per demo session holds
// the accounts, so every judge gets their own sandbox.
import { DurableObject } from 'cloudflare:workers';

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const STT = '@cf/openai/whisper-large-v3-turbo';
const FEE = 0.01;        // sell 1% under market: CryptoPal's cut
const LTV = 0.5;         // borrow up to half of what the crypto is worth today
const WARN_LTV = 0.8;    // warn when a loan reaches 80% of the crypto's value
const APR = 0.08;
const HOUR = 3600e3, DAY = 24 * HOUR;
const STABLE = ['USDC', 'USDT', 'PYUSD', 'DAI'];
const FALLBACK = { BTC: 80000, ETH: 2400, SOL: 150, DOGE: 0.18, USDC: 1, PYUSD: 1 };

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const err = (m, status = 400) => Object.assign(new Error(m), { status });
const r2 = n => Math.round(n * 100) / 100;
const money = n => '$' + (Math.round(n * 100) / 100).toFixed(2);
const units = n => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(4)).replace(/\.?0+$/, '');

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/.well-known/apple-app-site-association' && env.APPLE_APP_ID) // the iPhone app opens CryptoPal links
      return new Response(JSON.stringify({ applinks: { details: [{ appIDs: [env.APPLE_APP_ID], components: [{ '/': '/*' }] }] } }), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/api/config') return json({ paypalClientId: env.PAYPAL_CLIENT_ID || '', paypal: payPalReady(env) });
    if (url.pathname === '/api/currencies') return json(await currencies());
    if (url.pathname === '/manifest.webmanifest') { // start_url keeps the demo session when installed
      const w = /^[a-z0-9-]{8,40}$/.test(url.searchParams.get('w') || '') ? url.searchParams.get('w') : '';
      return new Response(JSON.stringify({
        name: 'CryptoPal', short_name: 'CryptoPal', description: 'Pay with crypto in a tap. AI picks the smartest way to pay.',
        start_url: '/' + (w ? '?w=' + w : ''), scope: '/', display: 'standalone', background_color: '#07070c', theme_color: '#07070c',
        icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }]
      }), { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-store' } });
    }
    const m = url.pathname.match(/^\/api\/w\/([a-z0-9-]{8,40})\/([a-z/]+)$/);
    if (m) return env.WORLD.get(env.WORLD.idFromName(m[1])).fetch(new Request('https://w/' + m[2] + url.search, req));
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(req);
  }
};

// ---------- prices (Coinbase public data, no key) ----------
let CUR = null, CUR_T = 0, PX = { t: 0, usd: {} };
const CH = {};
async function currencies() {
  if (CUR && Date.now() - CUR_T < 6 * HOUR) return CUR;
  const get = u => fetch(u, { headers: { 'user-agent': 'cryptopal-demo' } }).then(r => r.json()).catch(() => ({ data: [] }));
  const [fiat, crypto] = await Promise.all([get('https://api.coinbase.com/v2/currencies'), get('https://api.coinbase.com/v2/currencies/crypto')]);
  const out = {};
  for (const x of fiat.data || []) out[x.id] = { name: x.name, crypto: false };
  for (const x of crypto.data || []) out[x.code] = { name: x.name, crypto: true };
  if (Object.keys(out).length > 50) { CUR = out; CUR_T = Date.now(); }
  return Object.keys(out).length ? out : { USD: { name: 'US Dollar', crypto: false }, BTC: { name: 'Bitcoin', crypto: true }, ETH: { name: 'Ethereum', crypto: true }, SOL: { name: 'Solana', crypto: true }, USDC: { name: 'USDC', crypto: true }, DOGE: { name: 'Dogecoin', crypto: true } };
}
async function prices(symbols) {
  if (Date.now() - PX.t > 60e3) {
    const r = await fetch('https://api.coinbase.com/v2/exchange-rates?currency=USD', { headers: { 'user-agent': 'cryptopal-demo' } }).then(r => r.json()).catch(() => null);
    if (r?.data?.rates) {
      const usd = {};
      for (const [k, v] of Object.entries(r.data.rates)) if (+v > 0) usd[k] = 1 / +v;
      PX = { t: Date.now(), usd };
    }
  }
  const cur = await currencies();
  await Promise.all(symbols.filter(s => cur[s]?.crypto && !STABLE.includes(s) && !(CH[s] && Date.now() - CH[s].t < 120e3)).map(async s => {
    const st = await fetch(`https://api.exchange.coinbase.com/products/${s}-USD/stats`, { headers: { 'user-agent': 'cryptopal-demo' } }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    CH[s] = { t: Date.now(), pct: st && +st.open > 0 ? (+st.last / +st.open - 1) * 100 : null };
  }));
  const out = {};
  for (const s of symbols) out[s] = {
    usd: s === 'USD' ? 1 : PX.usd[s] ?? FALLBACK[s] ?? null,
    change24: STABLE.includes(s) || !cur[s]?.crypto ? 0 : CH[s]?.pct ?? null,
    crypto: !!cur[s]?.crypto, name: cur[s]?.name || s
  };
  return out;
}

// ---------- helpers ----------
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function sim(a, b) { // 1 = same words, 0 = nothing alike
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  let p = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const c = [i];
    for (let j = 1; j <= b.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    p = c;
  }
  return 1 - p[b.length] / Math.max(a.length, b.length);
}
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const SCAM = /urgent|gift ?card|irs|bail|warrant|wire|verify your|crypto ?atm|investment|double your|guaranteed|customer support|refund/i;

function payPalReady(env) { return !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET); }
async function paypal(env, path, body) { // sandbox only: never real money
  const base = 'https://api-m.sandbox.paypal.com';
  const tok = await fetch(base + '/v1/oauth2/token', {
    method: 'POST', body: 'grant_type=client_credentials',
    headers: { authorization: 'Basic ' + btoa(env.PAYPAL_CLIENT_ID + ':' + env.PAYPAL_SECRET), 'content-type': 'application/x-www-form-urlencoded' }
  }).then(r => r.json()).catch(() => ({}));
  if (!tok.access_token) throw err('PayPal sandbox sign-in failed.');
  const r = await fetch(base + path, {
    method: 'POST', body: JSON.stringify(body || {}),
    headers: { authorization: 'Bearer ' + tok.access_token, 'content-type': 'application/json', 'PayPal-Request-Id': crypto.randomUUID() }
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw err('PayPal: ' + (d.details?.[0]?.description || d.message || d.name || r.status));
  return d;
}

function seed(tz) {
  return {
    tz: tz || 'America/Los_Angeles', clock: 0, night: false, simulate: false, seq: 1, facesOff: true,
    acct: {
      me: { id: 'me', name: 'You', cash: 15, assets: { BTC: 0.004, ETH: 0.15, SOL: 2, USDC: 40 }, loans: [], limits: { night: 100, hold: 500 }, pending: [], locked: null, enrolled: null, voice: null, contacts: ['cafe'] },
      ana: { id: 'ana', name: 'Ana', cash: 120, assets: { BTC: 0.002, ETH: 0.1, DOGE: 600 }, loans: [], npc: true, cryptoOk: true },
      cafe: { id: 'cafe', name: 'Corner Café', cash: 0, assets: {}, loans: [], npc: true, merchant: true, cryptoOk: false }
    },
    tx: [], req: {}, checks: {}, reviews: [], paid: []
  };
}

// ---------- AI prompts ----------
const INTENT = {
  type: 'object', required: ['action'], properties: {
    action: { type: 'string', enum: ['pay', 'send', 'receive', 'open', 'unknown'] },
    asset: { type: ['string', 'null'] }, amountUsd: { type: ['number', 'null'] }, to: { type: ['string', 'null'] }
  }
};
const INTENT_SYS = 'You turn a spoken CryptoPal command into JSON. action: "pay" = pay a store or register, "send" = send money to a person, "receive" = get paid or ask for money, "open" = just open the app, "unknown" = anything else. asset = the ticker the user named (bitcoin=BTC, ethereum/ether=ETH, solana=SOL, dogecoin=DOGE, dollars/cash=USD, euros=EUR, pesos=MXN unless they say Colombian=COP), else null. amountUsd = the dollar amount if said, else null. to = the person\'s name if said, else null.';
const ADVISE = {
  type: 'object', required: ['pick', 'reason', 'why'], properties: {
    pick: { type: 'string' }, reason: { type: 'string' }, why: { type: 'array', items: { type: 'string' } }
  }
};
const ADVISE_SYS = 'You are CryptoPal\'s payment advisor. Choose the single most efficient way to pay from the options given (use the option id exactly). Think like a careful friend: selling crypto that dropped today locks in the loss, so borrowing against it can be smarter for small amounts; borrowing costs interest, so it is a poor choice when the coin is up or the amount is big; selling crypto that rose takes profit; selling costs a 1% fee; giving crypto directly avoids that fee when the receiver accepts crypto; stablecoins (USDC, PYUSD) and cash are steady. Talk to the user as "you". Follow the task line. reason: one plain sentence, max 22 words, no jargon, that names the choice and compares it to the next best option with a number, for example "Cash costs nothing, and selling Bitcoin today would lock in its 1.9% drop." Write money with a $ sign (like $0.31). Only compare two options if their costs differ. why: 3 or 4 short lines that explain the choice with the exact numbers given and compare it to the next best option. Never invent numbers.';
const WATCH = {
  type: 'object', required: ['verdict', 'reason'], properties: {
    verdict: { type: 'string', enum: ['ok', 'hold', 'freeze'] }, reason: { type: 'string' }
  }
};
const WATCH_SYS = 'You are CryptoPal\'s security watchdog. You protect the owner from phone thieves, scams, and people forcing or drugging the owner into sending money. Compare this send to the owner\'s normal behavior. verdict "ok" = normal. "hold" = delay it 24 hours so the owner can cancel when safe. "freeze" = lock the account until the owner verifies with photo ID and a live selfie. Use freeze only when several red flags stack up (for example night + new person + voice sounding different). Scam signs: urgency, gift cards, "verify your account", bail, investments. reason: one short sentence the owner will read, plain words.';

const TEXT = { type: 'object', required: ['text'], properties: { text: { type: 'string' } } };
const INSIGHT_SYS = 'You are CryptoPal\'s money coach inside a demo app with pretend money. Give the user one tip about paying for things today, about the focus coin, using only the numbers given. Facts you must respect: if a coin is down today, selling it to pay locks in that drop; borrowing against it instead keeps the coin, but costs 8% a year in interest and gets riskier if the price keeps falling (never call borrowing a sure thing and never say leverage). If a coin is up today, selling a little to pay takes some profit, with a 1% fee. Cash and stablecoins are steady. Whenever you mention borrowing, also say it costs interest and gets riskier if the price keeps falling. Only talk about selling or borrowing a coin the user owns (youOwnUsd above 0); never say to sell cash. Lead with the move and the useful idea, then the catch. Example: "Solana is down 4% today. Paying with cash avoids locking in that drop; borrowing against your SOL keeps it, but costs interest and gets riskier if it keeps falling." Talk to the user as "you", plain words, no hype, never promise gains.';
const MOVERS_SYS = 'You are CryptoPal\'s market watcher in a demo app. Using only the data given, tell the user the biggest crypto moves in the last hour and name any coins trending today. Plain words, exact numbers with one decimal, no buy or sell advice, no hype.';
function tipFallback(f) {
  const c = f.changeTodayPct;
  if (c == null) return 'Cash and stablecoins are the steadiest way to pay today.';
  if (c < 0) return `${f.name} is down ${Math.abs(c).toFixed(1)}% today. Selling it to pay would lock in that drop; borrowing against it keeps your ${f.coin} but costs interest.`;
  return `${f.name} is up ${c.toFixed(1)}% today. Selling a little to pay would take some profit (1% fee).`;
}
function moversFallback(movers, trend) {
  const m = movers.slice(0, 2).map(x => `${x.coin} ${x.changeLastHourPct >= 0 ? '+' : ''}${x.changeLastHourPct.toFixed(1)}%`).join(', ');
  return (m ? `Biggest moves this hour: ${m}.` : '') + (trend.length ? ` Trending today: ${trend.slice(0, 3).join(', ')}.` : '');
}
const MARKET = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'LTC', 'SHIB', 'SUI', 'XLM', 'PEPE', 'USDC'];
let MK = { t: 0, rows: [], trend: [], tt: 0 };
async function marketData() {
  if (Date.now() - MK.t < 120e3 && MK.rows.length) return MK;
  const ua = { headers: { 'user-agent': 'cryptopal-demo' } };
  const px = await prices(MARKET);
  const h1 = await Promise.all(MARKET.map(async s => { // change over the last hour, from hourly candles
    if (STABLE.includes(s) || !px[s]?.usd) return STABLE.includes(s) ? 0 : null;
    const c = await fetch(`https://api.exchange.coinbase.com/products/${s}-USD/candles?granularity=3600`, ua).then(r => (r.ok ? r.json() : null)).catch(() => null);
    return Array.isArray(c) && c.length > 1 && +c[1][4] > 0 ? (px[s].usd / +c[1][4] - 1) * 100 : null;
  }));
  const rows = MARKET.map((s, i) => ({ sym: s, name: px[s]?.name || s, usd: px[s]?.usd ?? null, h1: h1[i] == null ? null : r2(h1[i]), h24: px[s]?.change24 == null ? null : r2(px[s].change24) })).filter(r => r.usd);
  if (Date.now() - MK.tt > 600e3) { // trending coins today (CoinGecko, free), at most every 10 minutes
    const t = await fetch('https://api.coingecko.com/api/v3/search/trending', { headers: { 'user-agent': 'cryptopal-demo', accept: 'application/json' } }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (t?.coins) { MK.trend = t.coins.slice(0, 7).map(c => c.item?.symbol?.toUpperCase()).filter(Boolean); MK.tt = Date.now(); }
  }
  MK.rows = rows; MK.t = Date.now();
  return MK;
}

export class World extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.env = env; }
  now() { return Date.now() + (this.w.clock || 0); }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.slice(1);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    this.w = this.w || (await this.ctx.storage.get('w')) || seed(body.tz);
    if (!this.w.facesOff) await this.forgetFaces();
    try {
      await this.tick();
      const out = await this.route(path, body, url);
      await this.ctx.storage.put('w', this.w);
      return out;
    } catch (e) {
      await this.ctx.storage.put('w', this.w);
      if (!e.status) console.log('error', path, e.stack || e);
      return json({ error: e.status ? e.message : 'Something went wrong. Try again.' }, e.status || 500);
    }
  }

  // Older versions kept the owner's face numbers and the ID + selfie photos here. Delete them for good.
  // An owner whose face lived here sets up again; this time the face stays on their phone.
  async forgetFaces() {
    const me = this.w.acct.me;
    if (me.enrolled?.face) { me.enrolled = null; me.voice = null; }
    else if (me.enrolled && 'face' in me.enrolled) delete me.enrolled.face;
    const imgs = [...(await this.ctx.storage.list({ prefix: 'img:' })).keys()];
    for (let i = 0; i < imgs.length; i += 128) await this.ctx.storage.delete(imgs.slice(i, i + 128));
    this.w.facesOff = true;
    await this.ctx.storage.put('w', this.w);
  }

  async route(path, b, url) {
    const w = this.w, me = w.acct.me;
    switch (path) {
      case 'state': return json(await this.view());
      case 'setup': return json(await this.setup(b));
      case 'voice': return json(await this.voice(b));
      case 'suggest': return json(await this.suggest(b));
      case 'insight': return json(await this.insight(b));
      case 'market': return json(await this.marketView(b));
      case 'send': return json(await this.send(b));
      case 'cancel': return json(await this.cancel(b));
      case 'undo': return json(await this.undo(b));
      case 'request': {
        const by = b.by || 'me', usd = r2(+b.usd);
        if (!w.acct[by] || !(usd > 0 && usd <= 10000)) throw err('Enter an amount.');
        for (const r of Object.values(w.req)) if (r.by === by && r.status === 'open') r.status = 'replaced';
        const id = 'r' + w.seq++;
        w.req[id] = { id, by, usd, asset: b.asset && /^[A-Z0-9]{2,10}$/.test(b.asset) ? b.asset : null, memo: String(b.memo || '').slice(0, 80), t: this.now(), status: 'open' };
        return json({ request: w.req[id] });
      }
      case 'npcsend': { // Ana's phone (a demo person) sends you money
        const from = w.acct[b.from], usd = r2(+b.usd), asset = b.asset || 'USD';
        if (!from?.npc || !(usd > 0)) throw err('Enter an amount.');
        const t = await this.npcPay(from, 'me', usd, asset, null);
        return json({ tx: t });
      }
      case 'npcpay': { // Ana pays a request you made
        const r = w.req[b.requestId], from = w.acct[b.from];
        if (!r || r.status !== 'open' || !from?.npc) throw err('That request is gone.');
        const t = await this.npcPay(from, r.by, r.usd, r.asset || 'USD', r);
        return json({ tx: t });
      }
      case 'asset': {
        const s = String(b.symbol || '').toUpperCase().trim(), cur = await currencies();
        if (!cur[s]) throw err('No currency or crypto called ' + s + '.');
        if (!(s in me.assets) && s !== 'USD') me.assets[s] = 0;
        return json({ ok: true });
      }
      case 'trade': { // buy or sell inside your own account (money stays yours)
        const s = b.asset, usd = r2(+b.usd), px = (await prices([s]))[s];
        if (!px?.usd || !(usd > 0) || !(s in me.assets)) throw err('Enter an amount.');
        if (me.locked) throw err('CryptoPal is locked.', 423);
        if (b.side === 'buy') {
          if (me.cash < usd) throw err('Not enough cash.');
          me.cash = r2(me.cash - usd); me.assets[s] += usd / (px.usd * (1 + FEE));
        } else {
          const u = usd / (px.usd * (1 - FEE));
          if (me.assets[s] < u - 1e-12) throw err('Not enough ' + s + '.');
          me.assets[s] -= u; me.cash = r2(me.cash + usd);
        }
        w.tx.push({ id: 't' + w.seq++, t: this.now(), kind: b.side, from: 'me', to: 'me', asset: s, usd, status: 'done' });
        return json({ ok: true });
      }
      case 'repay': {
        const i = me.loans.findIndex(l => l.id === b.loanId);
        if (i < 0) throw err('Loan not found.');
        const owe = this.owed(me.loans[i]);
        if (me.cash < owe) throw err('You need ' + money(owe) + ' cash to repay.');
        me.cash = r2(me.cash - owe); me.loans.splice(i, 1);
        return json({ ok: true });
      }
      case 'limits': { // lowering is instant; raising needs ID + selfie + 24 hours
        const n = r2(+b.night), h = r2(+b.hold);
        if (!(n >= 0 && h >= 0)) throw err('Enter amounts.');
        if (n > me.limits.night || h > me.limits.hold) throw err('Raising a limit needs your ID and a selfie, then waits 24 hours.');
        me.limits = { night: n, hold: h };
        return json({ ok: true });
      }
      case 'verify': return json(await this.verify(b));
      case 'reviews': return json({ reviews: w.reviews.slice().reverse().map(r => ({ ...r, change: r.change ? { what: r.change.what } : null })), locked: me.locked });
      case 'decide': return json(this.decide(b));
      case 'demo': {
        if (b.reset) { this.w = seed(w.tz); await this.ctx.storage.deleteAll(); return json({ ok: true }); }
        if (typeof b.night === 'boolean') w.night = b.night;
        if (typeof b.simulate === 'boolean') w.simulate = b.simulate;
        if (b.skipHours > 0) { w.clock += Math.min(+b.skipHours, 72) * HOUR; await this.tick(); }
        return json({ ok: true });
      }
      case 'addcash': { // demo money when PayPal sandbox isn't connected
        if (payPalReady(this.env)) throw err('Use PayPal to add cash.');
        const usd = r2(+b.usd);
        if (!(usd >= 1 && usd <= 10000)) throw err('Add between $1 and $10,000.');
        me.cash = r2(me.cash + usd);
        w.tx.push({ id: 't' + w.seq++, t: this.now(), kind: 'topup', from: 'demo', to: 'me', asset: 'USD', usd, status: 'done', source: String(b.source || '').slice(0, 40) || null });
        return json({ ok: true, usd });
      }
      case 'pretend': { // Portfolio Send / Receive with pretend contacts
        const usd = r2(+b.usd), who = String(b.who || '').slice(0, 30) || 'Friend';
        if (!(usd > 0 && usd <= 10000)) throw err('Enter an amount.');
        if (b.kind === 'send') {
          if (me.cash < usd) throw err('Not enough cash. Add funds first.');
          me.cash = r2(me.cash - usd);
          w.tx.push({ id: 't' + w.seq++, t: this.now(), kind: 'send', from: 'me', to: 'contact', toName: who, asset: 'USD', method: 'cash', usd, status: 'done' });
        } else {
          me.cash = r2(me.cash + usd);
          w.tx.push({ id: 't' + w.seq++, t: this.now(), kind: 'receive', from: 'contact', fromName: who, to: 'me', asset: 'USD', usd, status: 'done' });
        }
        return json({ ok: true, usd });
      }
      case 'paypal/order': {
        if (!payPalReady(this.env)) throw err('PayPal sandbox is not connected yet.');
        const usd = r2(+b.usd);
        if (!(usd >= 1 && usd <= 500)) throw err('Add between $1 and $500.');
        const o = await paypal(this.env, '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [{ amount: { currency_code: 'USD', value: usd.toFixed(2) }, description: 'Add cash to CryptoPal (sandbox)' }] });
        return json({ id: o.id });
      }
      case 'paypal/capture': {
        if (!payPalReady(this.env)) throw err('PayPal sandbox is not connected yet.');
        if (!/^[A-Z0-9]{10,30}$/.test(b.orderId || '') || w.paid.includes(b.orderId)) throw err('Order already used.');
        const c = await paypal(this.env, `/v2/checkout/orders/${b.orderId}/capture`, {});
        const cap = c.purchase_units?.[0]?.payments?.captures?.[0];
        if (c.status !== 'COMPLETED' || !cap) throw err('PayPal did not complete the payment.');
        const usd = r2(+cap.amount.value);
        w.paid.push(b.orderId); me.cash = r2(me.cash + usd);
        w.tx.push({ id: 't' + w.seq++, t: this.now(), kind: 'topup', from: 'paypal', to: 'me', asset: 'USD', usd, status: 'done', paypal: { capture: cap.id } });
        return json({ ok: true, usd });
      }
    }
    throw err('Not found.', 404);
  }

  // ---------- state ----------
  async tick() {
    const w = this.w, now = this.now();
    for (const t of w.tx) if (t.status === 'held' && t.releaseAt <= now) await this.deliver(t);
    const me = w.acct.me;
    me.pending = (me.pending || []).filter(p => {
      if (p.at > now) return true;
      if (p.change.limits) me.limits = p.change.limits;
      if (p.change.phrase) me.enrolled.phrase = p.change.phrase;
      if (p.change.panic) me.enrolled.panic = p.change.panic;
      return false;
    });
    for (const id of Object.keys(w.checks)) if (now - w.checks[id].t > 10 * 60e3) delete w.checks[id];
  }

  isNight() {
    if (this.w.night) return true;
    const h = +new Intl.DateTimeFormat('en-US', { timeZone: this.w.tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(this.now()));
    return h >= 22 || h < 6;
  }
  owed(l) { return r2(l.usd * (1 + APR * Math.max(0, this.now() - l.t) / (365 * DAY))); }

  async view() {
    const w = this.w, me = w.acct.me;
    const syms = [...new Set(Object.values(w.acct).flatMap(a => Object.keys(a.assets)).concat(me.loans.map(l => l.asset), ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'USDC']))]; // + the coins on the Pay tab
    const px = await prices(syms);
    const pub = a => ({ id: a.id, name: a.name, cash: r2(a.cash), assets: a.assets, merchant: !!a.merchant, cryptoOk: !!a.cryptoOk });
    const nightUsed = this.nightUsed();
    return {
      now: this.now(), tz: w.tz, night: this.isNight(), demoNight: w.night, simulate: w.simulate, prices: px,
      me: {
        ...pub(me), enrolled: !!me.enrolled, limits: me.limits, nightLeft: r2(Math.max(0, me.limits.night - nightUsed)),
        loans: me.loans.map(l => { const v = (me.assets[l.asset] || 0) * (px[l.asset]?.usd || 0); const owe = this.owed(l); return { ...l, owe, ltv: v ? owe / v : 1, warn: !v || owe / v >= WARN_LTV }; }),
        pending: me.pending.map(p => ({ at: p.at, what: p.change.what })),
        frozen: me.locked?.kind === 'freeze' ? me.locked.reason : null // a panic lock stays invisible on the phone
      },
      others: [pub(w.acct.ana), pub(w.acct.cafe)],
      requests: Object.values(w.req).filter(r => r.status === 'open' && this.now() - r.t < 30 * 60e3),
      tx: w.tx.slice(-40).reverse().map(t => ({ ...t, fromName: w.acct[t.from]?.name || t.fromName || 'PayPal', toName: w.acct[t.to]?.name || t.toName || t.to })),
      market: Object.fromEntries(MARKET.map(s => [s, PX.usd[s] ?? null])), // real prices for the pretend market (no extra calls)
      backstage: { locked: me.locked ? me.locked.kind : null, openReviews: w.reviews.filter(r => r.status === 'open').length, paypal: payPalReady(this.env) }
    };
  }
  nightUsed() {
    const now = this.now();
    return this.w.tx.filter(t => t.from === 'me' && t.night && ['done', 'held'].includes(t.status) && now - t.t < 9 * HOUR).reduce((s, t) => s + t.usd, 0);
  }

  // ---------- setup & voice ----------
  async setup(b) {
    const w = this.w, me = w.acct.me;
    if (me.enrolled) throw err('Already set up. Use Reset demo to start over.');
    if (b.demo === true) { // pretend demo: any face and any voice pass; nothing biometric is kept
      me.name = String(b.name || 'You').slice(0, 24) || 'You';
      me.enrolled = { phrase: String(b.phrase || 'pay the man').trim() || 'pay the man', panic: String(b.panic || 'call my grandma').trim(), demo: true, at: this.now() };
      return { ok: true };
    }
    const phrase = String(b.phrase || '').trim(), panic = String(b.panic || '').trim();
    if (norm(phrase).split(' ').length < 3) throw err('Make your secret phrase at least 3 words.');
    if (norm(panic).split(' ').length < 2) throw err('Make your panic phrase at least 2 words.');
    if (sim(phrase, panic) > 0.6) throw err('Your panic phrase must sound different from your secret phrase.');
    const c = w.checks[b.checkId];
    if (!c || c.purpose !== 'enroll') throw err('Say your secret phrase once so CryptoPal learns your voice.');
    if (!c.simulated && sim(c.text, phrase) < 0.7) throw err(`I heard "${c.text}". Say your secret phrase exactly as you typed it.`);
    // The face is saved on the owner's phone only. The server never receives it.
    if (b.faceOnDevice !== true && b.faceSkipped !== true && !(b.faceSim && w.simulate)) throw err('Look at the camera so CryptoPal learns your face.');
    if (b.tz) try { new Intl.DateTimeFormat('en-US', { timeZone: b.tz }); w.tz = b.tz; } catch { }
    me.name = String(b.name || 'You').slice(0, 24) || 'You';
    me.enrolled = { phrase, panic, faceOnDevice: b.faceOnDevice === true, at: this.now() };
    me.voice = c.rate ? { rate: c.rate, clarity: c.clarity ?? -0.3 } : null;
    c.used = true;
    return { ok: true };
  }

  async voice(b) {
    const w = this.w, purpose = b.purpose;
    if (!['command', 'phrase', 'enroll'].includes(purpose)) throw err('Bad request.');
    let text = '', rate = null, clarity = null, simulated = false;
    if (b.audio) {
      if (b.audio.length > 2_000_000) throw err('That recording is too long.');
      const r = await this.env.AI.run(STT, { audio: b.audio, language: 'en', vad_filter: true });
      text = String(r.text || '').trim();
      const words = (r.segments || []).flatMap(s => s.words || []);
      if (words.length >= 2) { const span = words.at(-1).end - words[0].start; if (span > 0.3) rate = words.length / span; }
      const segs = r.segments || [];
      if (segs.length) clarity = segs.reduce((s, x) => s + (x.avg_logprob || 0), 0) / segs.length;
    } else if (w.simulate || purpose === 'command') { // typed instead of spoken (demo without a mic)
      text = String(b.text || '').slice(0, 200).trim(); simulated = true;
      const base = w.acct.me.voice || { rate: 2.6, clarity: -0.25 };
      rate = b.speech === 'slurred' ? base.rate * 0.6 : base.rate;
      clarity = b.speech === 'slurred' ? base.clarity - 0.5 : base.clarity;
    } else throw err('Turn on the microphone, or switch on "No camera or mic" in the demo panel.');
    if (!text) throw err("I didn't catch that. Try again.");
    const id = 'v' + w.seq++;
    w.checks[id] = { id, t: this.now(), purpose, text, rate, clarity, simulated };
    const out = { checkId: id, text };
    if (purpose === 'command') out.intent = await this.intent(text);
    return out;
  }

  async intent(text) {
    const cur = await currencies();
    let o = await this.ai(INTENT_SYS, { said: text }, INTENT, 120);
    if (!o || !o.action) { // simple backup if the AI is down
      const t = norm(text);
      o = { action: /receive|request|get paid/.test(t) ? 'receive' : /send|give/.test(t) ? 'send' : /pay|tap/.test(t) ? 'pay' : 'open' };
      const m = t.match(/(\d+(?:\.\d+)?)/); o.amountUsd = m ? +m[1] : null;
      o.asset = /bitcoin|btc/.test(t) ? 'BTC' : /ether|eth/.test(t) ? 'ETH' : /solana|sol\b/.test(t) ? 'SOL' : /doge/.test(t) ? 'DOGE' : null;
      o.to = /\bana\b/.test(t) ? 'Ana' : null;
    }
    const asset = String(o.asset || '').toUpperCase();
    return { action: o.action, asset: cur[asset] ? asset : null, amountUsd: +o.amountUsd > 0 ? r2(+o.amountUsd) : null, to: o.to || null };
  }

  async ai(system, input, schema, max = 300) {
    try {
      const r = await this.env.AI.run(MODEL, {
        messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }],
        response_format: { type: 'json_schema', json_schema: schema }, max_tokens: max, temperature: 0.2
      });
      let o = r?.response;
      if (typeof o === 'string') o = JSON.parse(o);
      return o && typeof o === 'object' ? o : null;
    } catch (e) { console.log('ai failed', e.message); return null; }
  }

  // ---------- AI tip on the Pay tab: a different coin each time ----------
  async insight(b) {
    const me = this.w.acct.me;
    const syms = [...new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', ...Object.keys(me.assets)])];
    const px = await prices(syms);
    const coins = syms.filter(s => px[s]?.usd && px[s].crypto && !STABLE.includes(s))
      .map(s => ({ coin: s, name: px[s].name, changeTodayPct: px[s].change24 == null ? null : r2(px[s].change24), youOwnUsd: r2((me.assets[s] || 0) * px[s].usd) }));
    if (!coins.length) return { text: 'Prices are loading. Check back in a minute.' };
    const ranked = coins.filter(c => c.changeTodayPct != null).sort((x, y) => Math.abs(y.changeTodayPct) - Math.abs(x.changeTodayPct));
    const owned = ranked.filter(c => c.youOwnUsd > 0).slice(0, 4); // talk about coins you own first
    const pool = owned.length ? owned : ranked.length ? ranked.slice(0, 4) : coins;
    const focus = pool[Math.floor(Math.random() * pool.length)];
    const sys = INSIGHT_SYS + (b.style === 'detailed' ? ' Length: two short sentences.' : ' Length: at most 32 words.')
      + (b.risk === 'bold' ? ' The user is fine with some risk.' : ' The user prefers careful choices.');
    const o = await this.ai(sys, { focus, cashUsd: r2(me.cash), hasLoans: me.loans.length > 0 }, TEXT, 120);
    return { text: String(o?.text || tipFallback(focus)).slice(0, 260), coin: focus.coin };
  }

  // ---------- Market tab: live prices, biggest moves this hour, trending coins ----------
  async marketView(b) {
    const m = await marketData();
    const movers = m.rows.filter(r => r.h1 != null && !STABLE.includes(r.sym)).sort((x, y) => Math.abs(y.h1) - Math.abs(x.h1)).slice(0, 4)
      .map(r => ({ coin: r.sym, changeLastHourPct: r2(r.h1), changeTodayPct: r.h24 == null ? null : r2(r.h24) }));
    const input = {};
    if (b.movers !== false) input.biggestMovesThisHour = movers;
    if (b.newCoins !== false && m.trend.length) input.trendingToday = m.trend.slice(0, 5);
    let bubble = '';
    if (Object.keys(input).length) {
      const o = await this.ai(MOVERS_SYS + (b.style === 'detailed' ? ' Two or three short sentences.' : ' At most two short sentences.'), input, TEXT, 140);
      bubble = String(o?.text || moversFallback(movers, m.trend)).slice(0, 300);
    }
    return { rows: m.rows, trend: m.trend, bubble };
  }

  // ---------- ways to pay + AI advice ----------
  async options(fromId, toId, usd) {
    const w = this.w, from = w.acct[fromId], to = w.acct[toId];
    const syms = Object.keys(from.assets).filter(s => from.assets[s] > 0);
    const px = await prices(syms), list = [];
    if (from.cash >= usd) list.push({ id: 'cash', method: 'cash', asset: 'USD', label: 'Cash', detail: `${money(from.cash - usd)} cash left after`, feeUsd: 0 });
    for (const s of syms) {
      const p = px[s]; if (!p?.usd) continue;
      const value = from.assets[s] * p.usd, name = p.name;
      if (value * (1 - FEE) >= usd) {
        const u = usd / (p.usd * (1 - FEE));
        list.push({ id: 'sell:' + s, method: 'sell', asset: s, label: `Sell ${name}`, detail: `${units(u)} ${s} at ${money(p.usd * (1 - FEE))} (1% under market)`, units: u, feeUsd: r2(u * p.usd - usd), change24: p.change24 });
      }
      if (p.crypto && !STABLE.includes(s)) {
        const owed = from.loans.filter(l => l.asset === s).reduce((t, l) => t + this.owed(l), 0);
        if (value * LTV - owed >= usd) list.push({ id: 'borrow:' + s, method: 'borrow', asset: s, label: `Borrow against ${name}`, detail: `Keep your ${s}. 8% a year, about ${money(usd * APR / 12)} a month`, feeUsd: 0, change24: p.change24, loanToValue: r2((owed + usd) / value) });
      }
      if (to.cryptoOk && value >= usd) {
        const u = usd / p.usd;
        list.push({ id: 'give:' + s, method: 'give', asset: s, label: `Give ${name}`, detail: `${units(u)} ${s} straight to ${to.name}, no fee`, units: u, feeUsd: 0, change24: p.change24 });
      }
    }
    return { list, px };
  }

  async suggest(b) {
    const w = this.w, to = w.acct[b.to], usd = r2(+b.usd);
    if (!to || b.to === 'me') throw err('Who are you paying?');
    if (!(usd > 0 && usd <= 100000)) throw err('Enter an amount.');
    const { list } = await this.options('me', b.to, usd);
    if (!list.length) throw err('Not enough money for ' + money(usd) + '. Add cash with PayPal or another coin.');
    const prefer = b.prefer && b.prefer !== 'USD' ? b.prefer : null;
    const facts = list.map(o => ({ id: o.id, way: o.label, detail: o.detail, feeUsd: o.feeUsd, coinChangeToday: o.change24 == null ? null : r2(o.change24) + '%', loanToValue: o.loanToValue }));
    const coin = prefer ? (await prices([prefer]))[prefer]?.name || prefer : null;
    const task = coin ? `You asked to pay with ${coin}. In the reason, say whether ${coin} is the smart choice, or what is better and why.` : 'Pick the best way to pay.';
    const a = await this.ai(ADVISE_SYS, { task, amountUsd: usd, payingTo: to.name, receiverTakesCrypto: !!to.cryptoOk, options: facts }, ADVISE, 350);
    let pick = list.find(o => o.id === a?.pick);
    let reason = a?.reason;
    if (coin && reason && !reason.toLowerCase().includes(coin.toLowerCase()) && !reason.includes(prefer)) reason = `Instead of ${coin}: ${reason[0].toLowerCase() + reason.slice(1)}`;
    let why = Array.isArray(a?.why) ? a.why.slice(0, 4).map(String) : null;
    if (!pick) { // backup rule if the AI is down
      const down = list.filter(o => o.method === 'borrow' && o.change24 < -2).sort((x, y) => x.change24 - y.change24)[0];
      const named = prefer && (list.find(o => o.id === 'give:' + prefer) || list.find(o => o.id === 'sell:' + prefer));
      pick = down || named || list.find(o => o.id === 'cash') || list[0];
      reason = down ? `${down.asset} is down today, so borrow instead of selling low.` : 'Simplest way to pay with no surprises.';
      why = [pick.detail];
    }
    const nice = t => String(t).replace(/\b(cash|(?:sell|borrow|give):[A-Z0-9]+)\b/g, id => list.find(o => o.id === id)?.label.toLowerCase() || id);
    reason = nice(reason || ''); why = (why || []).map(nice);
    return { usd, to: b.to, toName: to.name, pick: pick.id, reason: String(reason || '').slice(0, 140), why, options: list };
  }

  // ---------- security ----------
  authorize(a = {}) {
    const w = this.w, me = w.acct.me;
    if (!me.enrolled) throw err('Set up CryptoPal first.');
    if (a.demo === true) return { panic: false, c: null, phrase: 1, faceDist: 0.3, faceSkipped: false, voice: null, demo: true };
    const c = w.checks[a.checkId];
    if (!c || c.used || c.purpose !== 'phrase' || this.now() - c.t > 5 * 60e3) throw err('Say your secret phrase again.');
    c.used = true;
    if (sim(c.text, me.enrolled.panic) >= 0.8) return { panic: true, c };
    // The phone compares the live face with the face saved on it and sends only the result.
    let faceDist = null;
    if (a.faceOk === true && Number.isFinite(a.faceDist)) faceDist = r2(a.faceDist);
    else if (a.faceSkipped === true) faceDist = null; // the phone couldn't run the face check; the AI watchdog counts it as a risk
    else if (!(a.faceSim && w.simulate)) throw err('Look at the camera to confirm it is you.');
    const phrase = sim(c.text, me.enrolled.phrase);
    if (phrase < 0.8) throw err(`That secret phrase didn't match. I heard "${c.text}".`);
    if (faceDist !== null && faceDist > 0.55) throw err("That face doesn't match the owner.");
    let voice = null;
    if (me.voice && c.rate) {
      const speed = c.rate / me.voice.rate, drop = me.voice.clarity - (c.clarity ?? me.voice.clarity);
      voice = { speedVsNormal: r2(speed), clarityDrop: r2(drop), soundsDifferent: speed < 0.72 || drop > 0.35 };
    }
    return { panic: false, c, phrase, faceDist, faceSkipped: a.faceSkipped === true && faceDist == null, voice };
  }

  async panic(c, what) {
    const w = this.w, me = w.acct.me;
    me.locked = { kind: 'panic', t: this.now(), reason: 'Panic phrase used' };
    w.reviews.push({ id: 'k' + w.seq++, t: this.now(), kind: 'panic', status: 'open', note: `Panic phrase spoken while trying to ${what}. Account locked. Unlock only after the owner calls in with photo ID and a live selfie.` });
  }

  async send(b) {
    const w = this.w, me = w.acct.me;
    let toId = b.to, usd = r2(+b.usd), r = null;
    if (b.requestId) {
      r = w.req[b.requestId];
      if (!r || r.status !== 'open' || r.by === 'me') throw err('That payment request is gone.');
      toId = r.by; usd = r.usd;
    }
    const to = w.acct[toId];
    if (!to || toId === 'me') throw err('Who are you paying?');
    if (!(usd > 0 && usd <= 100000)) throw err('Enter an amount.');
    const looksFine = () => {
      const t = { id: 't' + w.seq++, t: this.now(), kind: r ? 'pay' : 'send', from: 'me', to: toId, usd, asset: 'USD', method: 'cash', status: 'processing' };
      w.tx.push(t); return { status: 'processing', tx: t, message: 'Processing. This can take a few minutes.' };
    };
    if (me.locked?.kind === 'panic') { this.authorize(b.auth); return looksFine(); } // thief sees nothing unusual
    if (me.locked) throw err('CryptoPal is frozen: ' + me.locked.reason + ' Verify with your photo ID and a live selfie to unlock.', 423);
    const a = this.authorize(b.auth);
    if (a.panic) { await this.panic(a.c, `send ${money(usd)} to ${to.name}`); return looksFine(); }

    const night = this.isNight();
    if (night && !a.demo) {
      const left = me.limits.night - this.nightUsed();
      if (usd > left) throw err(`Night limit: only ${money(Math.max(0, left))} more can go out until 6 AM. That protects you if someone forces you to send money at night.`);
    }
    const opt = (await this.options('me', toId, usd)).list.find(o => o.id === b.option);
    if (!opt) throw err('That way to pay is not available anymore. Pick another.');

    // AI watchdog, with hard rules underneath it
    const hist = w.tx.filter(t => t.from === 'me' && ['done', 'held'].includes(t.status) && t.kind !== 'buy' && t.kind !== 'sell');
    const typical = median(hist.slice(-10).map(t => t.usd)) || 25;
    const lastHour = hist.filter(t => this.now() - t.t < HOUR).length;
    const memo = r?.memo || String(b.memo || '').slice(0, 120);
    const isNew = !me.contacts.includes(toId);
    const f = {
      amountUsd: usd, typicalAmountUsd: typical, to: to.name, recipientIsNew: isNew, sendsInLastHour: lastHour,
      ownerLocalTime: new Intl.DateTimeFormat('en-US', { timeZone: w.tz, hour: 'numeric', minute: '2-digit' }).format(new Date(this.now())) + (w.night ? ' (demo: pretend 2 AM)' : ''),
      isNight: night, note: memo || null, way: opt.label,
      voice: a.voice || 'no voice baseline yet', secretPhraseMatch: r2(a.phrase),
      face: a.faceSkipped ? 'skipped (the phone could not run the face check)' : a.faceDist == null ? 'not checked (demo mode)' : a.faceDist < 0.45 ? 'strong match' : 'match'
    };
    const slur = !!a.voice?.soundsDifferent;
    const score = (isNew ? 1 : 0) + (usd > 3 * typical ? 1 : 0) + (lastHour >= 3 ? 1 : 0) + (night ? 1 : 0) + (slur ? 2 : 0) + (SCAM.test(memo) ? 2 : 0) + (a.faceSkipped ? 1 : 0);
    const ai = await this.ai(WATCH_SYS, f, WATCH, 120);
    let verdict = ['ok', 'hold', 'freeze'].includes(ai?.verdict) ? ai.verdict : score >= 4 ? 'freeze' : score >= 2 ? 'hold' : 'ok';
    if (score >= 4) verdict = 'freeze';
    else if ((slur || score >= 2) && verdict === 'ok') verdict = 'hold';
    let reason = String(ai?.reason || '').slice(0, 160) || (slur ? 'You sound different than usual, so this waits 24 hours.' : verdict === 'ok' ? 'Looks normal.' : 'This is unusual for you, so it waits 24 hours.');
    if (slur && !/sound|voice|speech/i.test(reason)) reason += ' Your voice sounds different than usual.';
    if (a.demo) { // live demo: the watchdog still checks and comments, but a demo payment always goes through
      if (verdict !== 'ok') reason = 'Checked: a normal purchase for you.';
      verdict = 'ok';
    }

    if (verdict === 'freeze') {
      me.locked = { kind: 'freeze', t: this.now(), reason };
      w.tx.push({ id: 't' + w.seq++, t: this.now(), kind: r ? 'pay' : 'send', from: 'me', to: toId, usd, asset: opt.asset, method: opt.method, status: 'blocked', reason, watchdog: f });
      return { status: 'frozen', reason };
    }
    const held = !a.demo && (verdict === 'hold' || usd > me.limits.hold);
    if (verdict === 'ok' && held) reason = `Over your ${money(me.limits.hold)} limit, so it waits 24 hours. You can cancel it until then.`;

    // take the money now (so it can't be spent twice); the receiver gets it now or after the hold
    const t = { id: 't' + w.seq++, t: this.now(), kind: r ? 'pay' : 'send', from: 'me', to: toId, usd, asset: opt.asset, method: opt.method, night, req: r?.id, status: held ? 'held' : 'sending', releaseAt: held ? this.now() + DAY : null, reason, watchdog: f };
    if (opt.method === 'cash') me.cash = r2(me.cash - usd);
    else if (opt.method === 'sell' || opt.method === 'give') { me.assets[opt.asset] -= opt.units; t.units = opt.units; t.feeUsd = opt.feeUsd; }
    else if (opt.method === 'borrow') { const l = { id: 'l' + w.seq++, asset: opt.asset, usd, t: this.now(), tx: t.id }; me.loans.push(l); t.loan = l.id; }
    w.tx.push(t);
    if (r) { r.status = 'paid'; r.tx = t.id; }
    if (!me.contacts.includes(toId)) me.contacts.push(toId);
    if (me.voice && a.c?.rate && !slur) { me.voice.rate = me.voice.rate * 0.8 + a.c.rate * 0.2; if (a.c.clarity != null) me.voice.clarity = me.voice.clarity * 0.8 + a.c.clarity * 0.2; }
    if (!held) await this.deliver(t);
    return { status: t.status, tx: t, reason };
  }

  async deliver(t) {
    const to = this.w.acct[t.to];
    if (t.method === 'give') to.assets[t.asset] = (to.assets[t.asset] || 0) + t.units;
    else to.cash = r2(to.cash + t.usd);
    t.status = 'done'; t.doneAt = this.now();
    if (to.merchant) { // the store gets real dollars through a PayPal sandbox payout
      if (payPalReady(this.env) && this.env.PAYPAL_MERCHANT_EMAIL) {
        try {
          const p = await paypal(this.env, '/v1/payments/payouts', {
            sender_batch_header: { sender_batch_id: 'cp-' + t.id + '-' + Date.now(), email_subject: 'CryptoPal payment' },
            items: [{ recipient_type: 'EMAIL', amount: { value: t.usd.toFixed(2), currency: 'USD' }, receiver: this.env.PAYPAL_MERCHANT_EMAIL, note: 'Paid with CryptoPal', sender_item_id: t.id }]
          });
          t.paypal = { payout: p.batch_header?.payout_batch_id, status: p.batch_header?.batch_status };
        } catch (e) { t.paypal = { error: e.message }; }
      } else t.paypal = { simulated: true };
    }
  }

  async npcPay(from, toId, usd, asset, r) {
    const w = this.w, px = (await prices([asset]))[asset];
    const t = { id: 't' + w.seq++, t: this.now(), kind: r ? 'pay' : 'send', from: from.id, to: toId, usd, asset, req: r?.id, status: 'sending' };
    if (asset !== 'USD' && from.assets[asset] > 0 && px?.usd) {
      const u = usd / px.usd;
      if (from.assets[asset] < u) throw err(`${from.name} doesn't have that much ${asset}.`);
      from.assets[asset] -= u; t.method = 'give'; t.units = u;
    } else {
      if (from.cash < usd) throw err(`${from.name} doesn't have that much cash.`);
      from.cash = r2(from.cash - usd); t.method = 'cash'; t.asset = 'USD';
    }
    w.tx.push(t);
    if (r) { r.status = 'paid'; r.tx = t.id; }
    await this.deliver(t);
    return t;
  }

  refund(t) {
    const me = this.w.acct.me;
    if (t.method === 'cash') me.cash = r2(me.cash + t.usd);
    else if (t.method === 'sell' || t.method === 'give') me.assets[t.asset] += t.units;
    else if (t.method === 'borrow') me.loans = me.loans.filter(l => l.id !== t.loan);
  }

  async cancel(b) {
    const t = this.w.tx.find(x => x.id === b.txId && x.from === 'me');
    if (!t || t.status !== 'held') throw err('Only a payment that is still waiting can be canceled.');
    if (this.w.acct.me.locked) throw err('CryptoPal is locked. Verify it is you first.', 423);
    const a = this.authorize(b.auth);
    if (a.panic) { await this.panic(a.c, 'cancel a payment'); return { status: 'processing', message: 'Processing. This can take a few minutes.' }; }
    this.refund(t); t.status = 'canceled';
    return { status: 'canceled' };
  }

  async undo(b) { // only CryptoPal-to-CryptoPal sends, within 24 hours, with phrase + face + voice
    const w = this.w, t = w.tx.find(x => x.id === b.txId && x.from === 'me');
    if (!t || t.status !== 'done' || !w.acct[t.to]?.cryptoOk || this.now() - (t.doneAt || t.t) > DAY) throw err('This payment can no longer be undone.');
    if (w.acct.me.locked) throw err('CryptoPal is locked. Verify it is you first.', 423);
    const a = this.authorize(b.auth);
    if (a.panic) { await this.panic(a.c, 'undo a payment'); return { status: 'processing', message: 'Processing. This can take a few minutes.' }; }
    const to = w.acct[t.to];
    if (t.method === 'give') { if ((to.assets[t.asset] || 0) < t.units) throw err(`${to.name} already spent it.`); to.assets[t.asset] -= t.units; }
    else { if (to.cash < t.usd) throw err(`${to.name} already spent it.`); to.cash = r2(to.cash - t.usd); }
    this.refund(t); t.status = 'undone';
    return { status: 'undone' };
  }

  async verify(b) { // photo ID + live selfie: compared on the owner's phone, the scores reviewed by a person
    const w = this.w, me = w.acct.me;
    const kind = b.kind === 'change' ? 'change' : 'unlock';
    // Photos and faces never come here. Only how well they matched (numbers like 0.42).
    const score = x => (Number.isFinite(x) && x >= 0 && x < 3 ? r2(x) : null);
    if (b.photosOnDevice !== true || score(b.selfieVsOwner) == null && score(b.idVsSelfie) == null) throw err('Add a photo of your ID and take a live selfie.');
    let change = null;
    if (kind === 'change') {
      const n = r2(+b.night), h = r2(+b.hold), p = String(b.phrase || '').trim(), q = String(b.panic || '').trim();
      change = { what: [] };
      if (n >= 0 && n !== me.limits.night || h >= 0 && h !== me.limits.hold) { change.limits = { night: n >= 0 ? n : me.limits.night, hold: h >= 0 ? h : me.limits.hold }; change.what.push(`limits: night ${money(change.limits.night)}, hold over ${money(change.limits.hold)}`); }
      if (p) { if (norm(p).split(' ').length < 3) throw err('Secret phrase needs 3+ words.'); change.phrase = p; change.what.push('new secret phrase'); }
      if (q) { if (sim(q, p || me.enrolled.phrase) > 0.6) throw err('Panic phrase must sound different.'); change.panic = q; change.what.push('new panic phrase'); }
      if (!change.what.length) throw err('Nothing to change.');
      change.what = change.what.join('; ');
    }
    const id = 'k' + w.seq++;
    w.reviews.push({
      id, t: this.now(), kind, status: 'open', change,
      selfieVsOwner: score(b.selfieVsOwner), idVsOwner: score(b.idVsOwner), idVsSelfie: score(b.idVsSelfie), idFaceFound: !!b.idFaceFound,
      note: kind === 'unlock' ? 'Owner asks to unlock CryptoPal. In real life they also call in.' : 'Owner asks to change security settings. Takes effect 24 hours after approval.'
    });
    return { ok: true, id };
  }

  decide(b) {
    const w = this.w, me = w.acct.me, r = w.reviews.find(x => x.id === b.id);
    if (!r || r.status !== 'open') throw err('Already decided.');
    if (r.kind === 'panic') throw err('A panic lock is only lifted by approving the owner\'s ID + selfie check.');
    r.status = b.approve ? 'approved' : 'rejected'; r.decidedAt = this.now();
    if (!b.approve) return { ok: true };
    if (r.kind === 'unlock') {
      me.locked = null;
      for (const x of w.reviews) if (x.kind === 'panic' && x.status === 'open') { x.status = 'closed'; x.decidedAt = this.now(); }
      for (const t of w.tx) if (t.status === 'processing') { t.status = 'canceled'; t.reason = 'Stopped by your panic phrase. Nothing was sent.'; }
    } else if (r.change) me.pending.push({ at: this.now() + DAY, change: r.change });
    return { ok: true };
  }
}
