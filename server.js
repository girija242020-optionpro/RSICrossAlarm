'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
const allowed = (process.env.CORS_ORIGIN || '*').split(',').map(x => x.trim()).filter(Boolean);
app.use(cors({ origin: (origin, cb) => {
  if (!origin || allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
  return cb(new Error('Origin not allowed by CORS'));
}}));

const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || '0.0.0.0';
const DHAN_BASE = 'https://api.dhan.co/v2';
const SYMBOLS = {
  NIFTY: { securityId: process.env.NIFTY_SECURITY_ID || '13', exchangeSegment: 'IDX_I', instrument: 'INDEX' },
  BANKNIFTY: { securityId: process.env.BANKNIFTY_SECURITY_ID || '25', exchangeSegment: 'IDX_I', instrument: 'INDEX' },
  FINNIFTY: { securityId: process.env.FINNIFTY_SECURITY_ID || '27', exchangeSegment: 'IDX_I', instrument: 'INDEX' },
  MIDCPNIFTY: { securityId: process.env.MIDCPNIFTY_SECURITY_ID || '442', exchangeSegment: 'IDX_I', instrument: 'INDEX' },
  SENSEX: { securityId: process.env.SENSEX_SECURITY_ID || '51', exchangeSegment: 'IDX_I', instrument: 'INDEX' }
};
const timeframeMap = { '1m': '1', '2m': '1', '3m': '3', '5m': '5', '10m': '5', '15m': '15', '25m': '25', '30m': '15', '60m': '60', '1h': '60' };
const candleCache = new Map();
let lastProviderError = null;
let lastProviderSuccess = null;

function dhanHeaders() {
  if (!process.env.DHAN_ACCESS_TOKEN || !process.env.DHAN_CLIENT_ID) {
    const e = new Error('DHAN_ACCESS_TOKEN and DHAN_CLIENT_ID must be configured on the backend.'); e.status = 503; throw e;
  }
  return { 'Content-Type': 'application/json', 'Accept': 'application/json', 'access-token': process.env.DHAN_ACCESS_TOKEN, 'client-id': process.env.DHAN_CLIENT_ID };
}
function normalizeSymbol(v) { return String(v || process.env.DEFAULT_INDEX || 'NIFTY').toUpperCase().replace(/[^A-Z]/g, ''); }
function normalizeTimeframe(v) { const s = String(v || '1m').toLowerCase(); return timeframeMap[s] ? s : null; }
function timeForInterval(ts, interval) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return new Date().toISOString();
  return d.toISOString();
}
function parseDhanCandles(payload) {
  const root = payload?.data || payload;
  const ts = root?.timestamp || root?.time || [];
  const opens = root?.open || [], highs = root?.high || [], lows = root?.low || [], closes = root?.close || [], volumes = root?.volume || [];
  const rows = [];
  for (let i = 0; i < closes.length; i++) {
    const close = Number(closes[i]);
    if (!Number.isFinite(close)) continue;
    rows.push({
      time: timeForInterval(ts[i], i),
      open: Number(opens[i]), high: Number(highs[i]), low: Number(lows[i]), close,
      volume: Number(volumes[i] || 0)
    });
  }
  return rows.filter(c => [c.open,c.high,c.low,c.close].every(Number.isFinite)).sort((a,b) => new Date(a.time)-new Date(b.time));
}
async function fetchDhanCandles(symbol, timeframe, limit) {
  const instrument = SYMBOLS[symbol];
  if (!instrument) { const e = new Error(`Unsupported index '${symbol}'. Supported: ${Object.keys(SYMBOLS).join(', ')}`); e.status = 400; throw e; }
  const interval = timeframeMap[timeframe];
  // Request enough recent sessions to retain RSI history outside market hours.
  const to = new Date();
  const from = new Date(to.getTime() - 5 * 24 * 60 * 60 * 1000);
  const body = {
    securityId: String(instrument.securityId),
    exchangeSegment: instrument.exchangeSegment,
    instrument: instrument.instrument,
    interval,
    fromDate: from.toISOString().slice(0, 10),
    toDate: to.toISOString().slice(0, 10)
  };
  const response = await fetch(`${DHAN_BASE}/charts/intraday`, { method: 'POST', headers: dhanHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  const raw = await response.text();
  let json; try { json = JSON.parse(raw); } catch { json = { raw: raw.slice(0, 500) }; }
  if (!response.ok) {
    const msg = json?.errorMessage || json?.message || json?.raw || `Dhan HTTP ${response.status}`;
    const e = new Error(`Dhan chart API failed (${response.status}): ${msg}`); e.status = response.status === 401 ? 502 : 502; throw e;
  }
  const rows = parseDhanCandles(json).slice(-limit);
  if (!rows.length) throw new Error('Dhan returned no candles. Check token, instrument ID, market data entitlement, and API response.');
  lastProviderSuccess = new Date().toISOString(); lastProviderError = null;
  candleCache.set(`${symbol}|${timeframe}`, { rows, updatedAt: Date.now() });
  return rows;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'dhan-rsi-cross-backend', time: new Date().toISOString() }));
app.get('/api/status', (_req, res) => res.json({
  ok: true, provider: 'DhanHQ v2', configured: Boolean(process.env.DHAN_CLIENT_ID && process.env.DHAN_ACCESS_TOKEN),
  defaultIndex: process.env.DEFAULT_INDEX || 'NIFTY', symbols: Object.keys(SYMBOLS),
  lastProviderSuccess, lastProviderError, time: new Date().toISOString()
}));
app.get('/api/config', (_req, res) => res.json({ defaultIndex: process.env.DEFAULT_INDEX || 'NIFTY', symbols: Object.keys(SYMBOLS), timeframes: Object.keys(timeframeMap), vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '' }));
app.get('/api/candles', async (req, res) => {
  const symbol = normalizeSymbol(req.query.symbol);
  const timeframe = normalizeTimeframe(req.query.timeframe);
  const limit = Math.max(20, Math.min(2000, Number.parseInt(req.query.limit || '250', 10) || 250));
  if (!timeframe) return res.status(400).json({ error: 'Unsupported timeframe. Use 1m, 3m, 5m, 15m, 25m, 30m, 60m or 1h.' });
  try {
    const candles = await fetchDhanCandles(symbol, timeframe, limit);
    return res.json({ symbol, timeframe, candles, count: candles.length, source: 'DhanHQ v2', asOf: new Date().toISOString(), stale: false });
  } catch (err) {
    lastProviderError = { message: err.message, time: new Date().toISOString() };
    // On temporary provider failure, return cached candles clearly marked stale; never fabricate prices.
    const cached = candleCache.get(`${symbol}|${timeframe}`);
    if (cached?.rows?.length) return res.json({ symbol, timeframe, candles: cached.rows.slice(-limit), count: Math.min(limit,cached.rows.length), source: 'DhanHQ v2 cache', asOf: new Date(cached.updatedAt).toISOString(), stale: true, warning: err.message });
    return res.status(err.status || 502).json({ error: err.message, source: 'DhanHQ v2', stale: false });
  }
});
app.get('/api/spot', async (req, res) => {
  const symbol = normalizeSymbol(req.query.symbol);
  const timeframe = '1m';
  try {
    const rows = await fetchDhanCandles(symbol, timeframe, 2);
    const c = rows[rows.length - 1];
    res.json({ symbol, price: c.close, timestamp: c.time, marketState: 'UNKNOWN', source: 'DhanHQ candle close', stale: false });
  } catch (err) { res.status(err.status || 502).json({ error: err.message }); }
});
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message || 'Internal server error' }));
app.listen(PORT, HOST, () => console.log(`Dhan RSI backend listening on http://${HOST}:${PORT}`));
