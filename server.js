'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { authenticator } = require('otplib');
const webpush = require('web-push');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(cors({ origin: process.env.CORS_ORIGIN === '*' || !process.env.CORS_ORIGIN ? true : process.env.CORS_ORIGIN.split(',').map(s => s.trim()) }));

const PORT = Number(process.env.PORT || 10000);
const RSI_LENGTH = Math.max(2, Number(process.env.RSI_LENGTH || 14));
const RSI_SMA_LENGTH = Math.max(2, Number(process.env.RSI_SMA_LENGTH || 14));
const LOWER_LIMIT = Number(process.env.RSI_LOWER_LIMIT || 30);
const POLL_MS = Math.max(15000, Number(process.env.POLL_INTERVAL_MS || 20000));
const ANGEL_BASE = 'https://apiconnect.angelone.in';

let jwtToken = null;
let feedToken = null;
let tokenExpiry = 0;
let lastAuthAt = null;
let lastPollAt = null;
let lastError = null;
let monitorTimer = null;
const subscriptions = new Map();
const states = new Map();
const eventLog = [];
const candlesCache = new Map();

const instruments = {
  NIFTY: { token: process.env.NIFTY_TOKEN || '99926000', exchange: process.env.NIFTY_EXCHANGE || 'NSE' },
  SENSEX: { token: process.env.SENSEX_TOKEN || '99919000', exchange: process.env.SENSEX_EXCHANGE || 'BSE' }
};
const intervals = { '1m': 'ONE_MINUTE', '3m': 'THREE_MINUTE', '5m': 'FIVE_MINUTE', '15m': 'FIFTEEN_MINUTE', ONE_MINUTE: 'ONE_MINUTE', THREE_MINUTE: 'THREE_MINUTE', FIVE_MINUTE: 'FIVE_MINUTE', FIFTEEN_MINUTE: 'FIFTEEN_MINUTE' };

function configured() {
  return Boolean(process.env.ANGELONE_API_KEY && process.env.ANGELONE_CLIENT_CODE && process.env.ANGELONE_PIN && process.env.ANGELONE_TOTP_SECRET);
}
function baseHeaders(auth = true) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-PrivateKey': process.env.ANGELONE_API_KEY || '',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': process.env.ANGELONE_CLIENT_LOCAL_IP || '127.0.0.1',
    'X-ClientPublicIP': process.env.ANGELONE_CLIENT_PUBLIC_IP || '127.0.0.1',
    'X-MACAddress': process.env.ANGELONE_MAC_ADDRESS || '00:00:00:00:00:00'
  };
  if (auth && jwtToken) h.Authorization = `Bearer ${jwtToken}`;
  return h;
}
async function login(force = false) {
  if (!configured()) throw new Error('Angel One credentials are missing. Configure ANGELONE_API_KEY, ANGELONE_CLIENT_CODE, ANGELONE_PIN and ANGELONE_TOTP_SECRET in Render.');
  if (!force && jwtToken && Date.now() < tokenExpiry) return;
  const totp = authenticator.generate(String(process.env.ANGELONE_TOTP_SECRET).replace(/\s/g, ''));
  const res = await axios.post(`${ANGEL_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    clientcode: process.env.ANGELONE_CLIENT_CODE,
    password: process.env.ANGELONE_PIN,
    totp
  }, { headers: baseHeaders(false), timeout: 20000 });
  if (!res.data || res.data.status !== true || !res.data.data || !res.data.data.jwtToken) {
    throw new Error(`Angel One login failed: ${res.data?.message || res.data?.errorcode || 'No JWT token returned'}`);
  }
  jwtToken = res.data.data.jwtToken;
  feedToken = res.data.data.feedToken || null;
  tokenExpiry = Date.now() + 20 * 60 * 1000;
  lastAuthAt = new Date().toISOString();
  lastError = null;
}
async function angelPost(path, body) {
  await login();
  try {
    const res = await axios.post(`${ANGEL_BASE}${path}`, body, { headers: baseHeaders(true), timeout: 20000 });
    if (res.data?.errorcode === 'AG8001' || res.data?.errorcode === 'AG8002' || /token/i.test(res.data?.message || '') && res.data?.status === false) {
      await login(true);
      const retry = await axios.post(`${ANGEL_BASE}${path}`, body, { headers: baseHeaders(true), timeout: 20000 });
      return retry.data;
    }
    return res.data;
  } catch (e) {
    if (e.response?.status === 401) {
      await login(true);
      const retry = await axios.post(`${ANGEL_BASE}${path}`, body, { headers: baseHeaders(true), timeout: 20000 });
      return retry.data;
    }
    throw e;
  }
}
function parseTimeframe(value) {
  const key = String(value || process.env.DEFAULT_TIMEFRAME || '1m').toLowerCase();
  const interval = intervals[key] || intervals[key.toUpperCase()];
  if (!interval) throw new Error('Unsupported timeframe. Use 1m, 3m, 5m or 15m.');
  return interval;
}
function dateIST(d) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const o = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${o.year}-${o.month}-${o.day}`;
}
function istDateTime(d) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d).replace(' ', 'T');
}
function defaultRange() {
  const now = new Date();
  const from = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
  return { fromdate: `${istDateTime(from).slice(0, 10)} 09:15`, todate: `${dateIST(now)} 15:30` };
}
async function getCandles(symbol = 'NIFTY', timeframe = '1m', limit = 250) {
  const key = String(symbol).toUpperCase();
  const instrument = instruments[key];
  if (!instrument) throw new Error('Unsupported symbol. Use NIFTY or SENSEX.');
  const interval = parseTimeframe(timeframe);
  const { fromdate, todate } = defaultRange();
  const data = await angelPost('/rest/secure/angelbroking/historical/v1/getCandleData', {
    exchange: instrument.exchange,
    symboltoken: instrument.token,
    interval,
    fromdate,
    todate
  });
  if (!data || data.status !== true || !Array.isArray(data.data)) throw new Error(`Angel One candle request failed: ${data?.message || data?.errorcode || 'Unexpected response'}`);
  const candles = data.data.slice(-Math.max(30, Math.min(Number(limit) || 250, 500))).map(row => ({
    time: row[0], open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5] || 0)
  }));
  candlesCache.set(`${key}:${timeframe}`, { candles, at: Date.now() });
  return candles;
}
function calculateRSI(closes, length = RSI_LENGTH) {
  if (closes.length < length + 1) return closes.map(() => null);
  const out = Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= length; i++) {
    const delta = closes[i] - closes[i - 1];
    gain += Math.max(delta, 0); loss += Math.max(-delta, 0);
  }
  let avgGain = gain / length, avgLoss = loss / length;
  const value = () => avgLoss === 0 ? 100 : avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss);
  out[length] = value();
  for (let i = length + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    avgGain = (avgGain * (length - 1) + Math.max(delta, 0)) / length;
    avgLoss = (avgLoss * (length - 1) + Math.max(-delta, 0)) / length;
    out[i] = value();
  }
  return out;
}
function sma(values, length) {
  return values.map((_, i) => {
    if (i < length - 1) return null;
    const window = values.slice(i - length + 1, i + 1);
    if (window.some(v => v == null || !Number.isFinite(v))) return null;
    return window.reduce((a, b) => a + b, 0) / length;
  });
}
function calculateState(candles, symbol, timeframe) {
  const closes = candles.map(c => c.close);
  const rsi = calculateRSI(closes);
  const rsiSma = sma(rsi, RSI_SMA_LENGTH);
  let armed = false, crossedRsiMa = false, trigger = false, triggerIndex = -1;
  for (let i = 1; i < candles.length; i++) {
    const r = rsi[i], p = rsi[i - 1], m = rsiSma[i], pm = rsiSma[i - 1];
    if ([r, p, m, pm].some(v => v == null)) continue;
    // Sequence resets when the RSI/SMA oversold precondition is lost before the MA crossover.
    if (r < LOWER_LIMIT && m < LOWER_LIMIT) armed = true;
    if (armed && !crossedRsiMa && p <= pm && r > m && r < LOWER_LIMIT && m < LOWER_LIMIT) crossedRsiMa = true;
    if (crossedRsiMa && p <= LOWER_LIMIT && r > LOWER_LIMIT && r > m && m < LOWER_LIMIT) {
      trigger = true; triggerIndex = i; armed = false; crossedRsiMa = false;
    }
    if (crossedRsiMa && m >= LOWER_LIMIT) { armed = false; crossedRsiMa = false; }
  }
  const n = candles.length - 1;
  const prev = n > 0 ? n - 1 : n;
  const latest = { time: candles[n]?.time || null, close: closes[n] ?? null, rsi: rsi[n] ?? null, rsiSma: rsiSma[n] ?? null, lowerLimit: LOWER_LIMIT };
  const currentKey = `${symbol}:${timeframe}`;
  const old = states.get(currentKey) || {};
  // Trigger only if the qualifying final candle is newer than the last processed candle.
  const triggerCandleTime = triggerIndex >= 0 ? candles[triggerIndex].time : null;
  const newTrigger = Boolean(trigger && triggerIndex === n && triggerCandleTime !== old.lastTriggerCandleTime);
  const state = {
    symbol, timeframe, latest,
    precondition: latest.rsi != null && latest.rsi < LOWER_LIMIT && latest.rsiSma != null && latest.rsiSma < LOWER_LIMIT,
    rsiAboveSma: latest.rsi != null && latest.rsiSma != null && latest.rsi > latest.rsiSma,
    sequenceStage: newTrigger ? 'TRIGGERED' : (crossedRsiMa ? 'WAITING_FOR_RSI_CROSS_30' : (armed ? 'OVERSOLD_PRECONDITION_SEEN' : 'IDLE')),
    alert: newTrigger,
    lastTriggerCandleTime: newTrigger ? triggerCandleTime : old.lastTriggerCandleTime || null,
    updatedAt: new Date().toISOString()
  };
  states.set(currentKey, state);
  return { state, rsiSeries: rsi.map((v, i) => ({ time: candles[i].time, rsi: v, rsiSma: rsiSma[i] })) };
}
function pushConfigured() { return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT); }
function setupWebPush() {
  if (pushConfigured()) webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
}
function recordEvent(event) {
  eventLog.unshift(event);
  if (eventLog.length > 200) eventLog.length = 200;
}
async function sendPushToAll(payload) {
  if (!pushConfigured()) return { sent: 0, skipped: true, reason: 'VAPID keys not configured' };
  setupWebPush();
  let sent = 0;
  for (const [id, sub] of subscriptions.entries()) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 60 }); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) subscriptions.delete(id); }
  }
  return { sent, skipped: false };
}
async function pollOne(symbol, timeframe) {
  try {
    const candles = await getCandles(symbol, timeframe, 250);
    const result = calculateState(candles, symbol, timeframe);
    lastPollAt = new Date().toISOString(); lastError = null;
    if (result.state.alert) {
      const event = { type: 'RSI_LOWER_LIMIT_CROSS', symbol, timeframe, ...result.state.latest, createdAt: new Date().toISOString() };
      recordEvent(event);
      await sendPushToAll({ title: `${symbol} RSI Alert`, body: `RSI crossed above ${LOWER_LIMIT}; RSI-SMA is still below ${LOWER_LIMIT}.`, event, url: '/' });
    }
    return result.state;
  } catch (e) {
    lastError = e.message;
    return { symbol, timeframe, error: e.message, updatedAt: new Date().toISOString() };
  }
}
async function monitorTick() {
  if (!configured()) return;
  // Keep the requests sequential to reduce SmartAPI rate-limit pressure.
  await pollOne('NIFTY', process.env.DEFAULT_TIMEFRAME || '1m');
  await new Promise(resolve => setTimeout(resolve, 1200));
  await pollOne('SENSEX', process.env.DEFAULT_TIMEFRAME || '1m');
}

app.get('/', (req, res) => res.json({ name: 'RSI Cross Alarm Angel One Backend', runtime: 'Node.js', ok: true, endpoints: ['GET /api/health', 'GET /api/status', 'GET /api/candles?symbol=NIFTY&timeframe=1m&limit=250', 'GET /api/rsi-state?symbol=NIFTY&timeframe=1m', 'GET /api/events', 'GET /api/vapid-public-key', 'POST /api/subscribe', 'POST /api/test-push'] }));
app.get('/api/health', (req, res) => res.json({ ok: true, runtime: 'node', time: new Date().toISOString() }));
app.get('/api/status', (req, res) => res.json({ ok: true, runtime: 'node', angelOneConfigured: configured(), authenticated: Boolean(jwtToken && Date.now() < tokenExpiry), lastAuthAt, lastPollAt, lastError, pushConfigured: pushConfigured(), subscriptions: subscriptions.size, instruments, settings: { rsiLength: RSI_LENGTH, rsiSmaLength: RSI_SMA_LENGTH, lowerLimit: LOWER_LIMIT, pollIntervalMs: POLL_MS } }));
app.get('/api/candles', async (req, res) => {
  try { const candles = await getCandles(req.query.symbol || 'NIFTY', req.query.timeframe || '1m', req.query.limit || 250); res.json({ ok: true, symbol: String(req.query.symbol || 'NIFTY').toUpperCase(), timeframe: req.query.timeframe || '1m', count: candles.length, candles }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
app.get('/api/rsi-state', async (req, res) => {
  try { const symbol = String(req.query.symbol || 'NIFTY').toUpperCase(); const timeframe = req.query.timeframe || '1m'; const candles = await getCandles(symbol, timeframe, 250); const result = calculateState(candles, symbol, timeframe); res.json({ ok: true, ...result }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
app.get('/api/events', (req, res) => res.json({ ok: true, events: eventLog }));
app.get('/api/vapid-public-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({ ok: false, error: 'VAPID_PUBLIC_KEY is not configured' });
  res.json({ ok: true, publicKey: process.env.VAPID_PUBLIC_KEY, vapidPublicKey: process.env.VAPID_PUBLIC_KEY });
});
app.post('/api/subscribe', (req, res) => {
  const sub = req.body?.subscription || req.body;
  if (!sub || !sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return res.status(400).json({ ok: false, error: 'Expected a Web Push subscription object with endpoint and keys.p256dh/auth.' });
  subscriptions.set(sub.endpoint, sub);
  res.json({ ok: true, message: 'Push subscription saved in memory.', count: subscriptions.size, note: 'Render restart clears in-memory subscriptions; persistent storage is needed for durability.' });
});
app.post('/api/test-push', async (req, res) => {
  if (!pushConfigured()) return res.status(503).json({ ok: false, error: 'Configure VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT first.' });
  if (!subscriptions.size) return res.status(409).json({ ok: false, error: 'No subscriptions registered. The PWA must request notification permission and POST its subscription to /api/subscribe.' });
  const result = await sendPushToAll({ title: 'RSI Alarm Test', body: 'Test push from RSI Cross Alarm backend.', createdAt: new Date().toISOString() });
  res.json({ ok: true, ...result });
});
app.post('/api/monitor/run-once', async (req, res) => {
  // Optional manual diagnostic; no credentials are returned.
  const symbol = String(req.body?.symbol || 'NIFTY').toUpperCase();
  const timeframe = req.body?.timeframe || process.env.DEFAULT_TIMEFRAME || '1m';
  const state = await pollOne(symbol, timeframe);
  res.json({ ok: !state.error, state });
});

app.listen(PORT, () => {
  console.log(`RSI Cross Alarm backend listening on ${PORT}`);
  console.log(`Angel One credentials configured: ${configured()}`);
  if (configured()) {
    monitorTick().catch(e => { lastError = e.message; });
    monitorTimer = setInterval(() => monitorTick().catch(e => { lastError = e.message; }), POLL_MS);
  } else {
    console.log('Monitoring is paused until Angel One environment variables are configured.');
  }
});
