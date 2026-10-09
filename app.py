import os, json, time, threading, logging, sqlite3, base64
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from pathlib import Path
from flask import Flask, jsonify, request
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=os.getenv('LOG_LEVEL', 'INFO'))
log = logging.getLogger('rsi-alarm-backend')
IST = ZoneInfo('Asia/Kolkata')
BASE_DIR = Path(__file__).resolve().parent
DB_PATH = os.getenv('DATABASE_PATH', str(BASE_DIR / 'rsi_alarm.sqlite3'))

app = Flask(__name__)
origins = os.getenv('CORS_ORIGINS', '*').strip()
CORS(app, resources={r"/*": {"origins": "*" if origins == '*' else [x.strip() for x in origins.split(',') if x.strip()]}})

TIMEFRAMES = {
    '1m': 'ONE_MINUTE', '3m': 'THREE_MINUTE', '5m': 'FIVE_MINUTE',
    '10m': 'TEN_MINUTE', '15m': 'FIFTEEN_MINUTE', '30m': 'THIRTY_MINUTE',
    '1h': 'ONE_HOUR', '1d': 'ONE_DAY'
}
INSTRUMENTS = {
    'NIFTY': {'exchange': os.getenv('NIFTY_EXCHANGE', 'NSE'), 'token': os.getenv('NIFTY_SYMBOL_TOKEN', '99926000')},
    'NIFTY 50': {'exchange': os.getenv('NIFTY_EXCHANGE', 'NSE'), 'token': os.getenv('NIFTY_SYMBOL_TOKEN', '99926000')},
    'SENSEX': {'exchange': os.getenv('SENSEX_EXCHANGE', 'BSE'), 'token': os.getenv('SENSEX_SYMBOL_TOKEN', '99919000')},
}

# ---- SQLite: push subscriptions and duplicate-alert suppression ----
def db():
    con = sqlite3.connect(DB_PATH, timeout=15)
    con.row_factory = sqlite3.Row
    return con

def init_db():
    with db() as con:
        con.execute('CREATE TABLE IF NOT EXISTS subscriptions (endpoint TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)')
        con.execute('CREATE TABLE IF NOT EXISTS fired_alerts (alert_key TEXT PRIMARY KEY, created_at TEXT NOT NULL)')
init_db()

# ---- Angel One SmartAPI session ----
_smart = None
_smart_lock = threading.Lock()
_last_login = 0

def env_first(*names):
    for name in names:
        value = os.getenv(name, '').strip()
        if value:
            return value
    return ''

def angel_configured():
    return all([
        env_first('ANGELONE_API_KEY', 'ANGEL_ONE_API_KEY', 'ANGEL_API_KEY'),
        env_first('ANGELONE_CLIENT_CODE', 'ANGEL_ONE_CLIENT_CODE', 'ANGEL_CLIENT_CODE', 'ANGEL_CLIENT_ID'),
        env_first('ANGELONE_PIN', 'ANGEL_ONE_PIN', 'ANGEL_PIN'),
        env_first('ANGELONE_TOTP_SECRET', 'ANGEL_ONE_TOTP_SECRET', 'ANGEL_TOTP_SECRET'),
    ])

def get_smart(force_login=False):
    global _smart, _last_login
    with _smart_lock:
        now = time.time()
        if _smart is not None and not force_login and now - _last_login < 8 * 60 * 60:
            return _smart
        if not angel_configured():
            raise RuntimeError('Angel One credentials are not configured. Set API key, client code, PIN and TOTP secret in Render environment variables.')
        try:
            import pyotp
            from SmartApi import SmartConnect
        except Exception as exc:
            raise RuntimeError(f'Could not import Angel One SDK dependencies: {exc}')
        api_key = env_first('ANGELONE_API_KEY', 'ANGEL_ONE_API_KEY', 'ANGEL_API_KEY')
        client_code = env_first('ANGELONE_CLIENT_CODE', 'ANGEL_ONE_CLIENT_CODE', 'ANGEL_CLIENT_CODE', 'ANGEL_CLIENT_ID')
        pin = env_first('ANGELONE_PIN', 'ANGEL_ONE_PIN', 'ANGEL_PIN')
        totp_secret = env_first('ANGELONE_TOTP_SECRET', 'ANGEL_ONE_TOTP_SECRET', 'ANGEL_TOTP_SECRET')
        client = SmartConnect(api_key=api_key)
        totp = pyotp.TOTP(totp_secret).now()
        response = client.generateSession(client_code, pin, totp)
        if not isinstance(response, dict) or not response.get('status') or not (response.get('data') or {}).get('jwtToken'):
            # Never log credentials or the authentication response body; it can contain tokens.
            message = response.get('message', 'Angel One login failed') if isinstance(response, dict) else 'Unexpected login response'
            raise RuntimeError(f'Angel One login failed: {message}. Check API key, client code, PIN and TOTP secret.')
        _smart = client
        _last_login = now
        log.info('Angel One SmartAPI session established')
        return _smart

# ---- Candle retrieval and normalization ----
def fetch_candles(symbol='NIFTY', timeframe='1m', limit=250):
    symbol = symbol.strip().upper()
    tf = timeframe.strip().lower()
    if symbol not in INSTRUMENTS:
        raise ValueError(f'Unsupported symbol {symbol}. Supported symbols: NIFTY, SENSEX.')
    if tf not in TIMEFRAMES:
        raise ValueError(f'Unsupported timeframe {tf}. Supported: {", ".join(TIMEFRAMES)}')
    limit = max(30, min(int(limit), 500))
    instrument = INSTRUMENTS[symbol]
    now = datetime.now(IST)
    # Request a short recent window; enough to calculate RSI and its smoothing MA.
    from_dt = now - timedelta(days=2)
    params = {
        'exchange': instrument['exchange'],
        'symboltoken': instrument['token'],
        'interval': TIMEFRAMES[tf],
        'fromdate': from_dt.strftime('%Y-%m-%d %H:%M'),
        'todate': now.strftime('%Y-%m-%d %H:%M'),
    }
    client = get_smart()
    try:
        response = client.getCandleData(params)
    except Exception as exc:
        # Re-authenticate once in case the SmartAPI session expired.
        log.warning('Candle request failed; refreshing session once: %s', type(exc).__name__)
        client = get_smart(force_login=True)
        response = client.getCandleData(params)
    if not isinstance(response, dict) or response.get('status') is False:
        msg = response.get('message', 'Angel One candle API returned an error') if isinstance(response, dict) else 'Invalid candle response'
        raise RuntimeError(f'Angel One candle request failed: {msg}')
    rows = response.get('data') or []
    candles = []
    for row in rows:
        if not isinstance(row, (list, tuple)) or len(row) < 5:
            continue
        candles.append({
            'time': str(row[0]), 'open': float(row[1]), 'high': float(row[2]),
            'low': float(row[3]), 'close': float(row[4]),
            'volume': float(row[5]) if len(row) > 5 and row[5] is not None else 0,
        })
    candles.sort(key=lambda c: c['time'])
    return candles[-limit:]

# ---- RSI and exact three-stage sequence, using Wilder RSI and SMA smoothing ----
def rma(values, length):
    out = [None] * len(values)
    if len(values) < length:
        return out
    seed = sum(values[:length]) / length
    out[length - 1] = seed
    for i in range(length, len(values)):
        out[i] = (out[i - 1] * (length - 1) + values[i]) / length
    return out

def calc_rsi(closes, length=14):
    if len(closes) < length + 1:
        return [None] * len(closes)
    changes = [0.0] + [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    up = [max(x, 0.0) for x in changes[1:]]
    down = [max(-x, 0.0) for x in changes[1:]]
    avg_up, avg_down = rma(up, length), rma(down, length)
    out = [None] * len(closes)
    for i, (u, d) in enumerate(zip(avg_up, avg_down), start=1):
        if u is None or d is None:
            continue
        out[i] = 100.0 if d == 0 else (0.0 if u == 0 else 100.0 - 100.0 / (1.0 + u / d))
    return out

def sma_nullable(values, length):
    out = [None] * len(values)
    for i in range(length - 1, len(values)):
        chunk = values[i - length + 1:i + 1]
        if all(v is not None for v in chunk):
            out[i] = sum(chunk) / length
    return out

def analyze_sequence(candles, rsi_length=14, ma_length=14, lower=30):
    if len(candles) < rsi_length + ma_length + 5:
        return {'ready': False, 'reason': 'Not enough candles to calculate RSI and smoothing MA.', 'candles_required': rsi_length + ma_length + 5}
    rsis = calc_rsi([c['close'] for c in candles], rsi_length)
    mas = sma_nullable(rsis, ma_length)
    valid = [i for i in range(len(candles)) if rsis[i] is not None and mas[i] is not None]
    if len(valid) < 2:
        return {'ready': False, 'reason': 'RSI/MA values are not ready.'}
    i = valid[-1]
    r, m = rsis[i], mas[i]
    stage = 0
    signal_index = -1
    for j in range(1, i + 1):
        pr, pm, cr, cm = rsis[j - 1], mas[j - 1], rsis[j], mas[j]
        if any(v is None for v in (pr, pm, cr, cm)):
            continue
        if pr < lower and pm < lower:
            stage = max(stage, 1)
        if stage >= 1 and pr <= pm and cr > cm and cr < lower and cm < lower:
            stage = 2
        if stage == 2 and pr <= lower and cr > lower and cm < lower and cr > cm:
            signal_index = j
            stage = 3
            break
    return {
        'ready': True, 'symbol': None, 'timeframe': None,
        'rsi': round(r, 4), 'rsiSma': round(m, 4), 'lowerLimit': lower,
        'stage': stage, 'stage1': stage >= 1, 'stage2': stage >= 2, 'stage3': stage >= 3,
        'latestCandleTime': candles[i]['time'],
        'signalOnLatestCandle': signal_index == i,
        'signalCandleTime': candles[signal_index]['time'] if signal_index >= 0 else None,
        'conditions': {
            'rsiAboveMa': r > m,
            'rsiAboveLowerLimit': r > lower,
            'maBelowLowerLimit': m < lower,
        }
    }

# ---- Web Push support ----
def vapid_public_key():
    return env_first('VAPID_PUBLIC_KEY')

def vapid_private_pem():
    raw = env_first('VAPID_PRIVATE_KEY_B64')
    if raw:
        try:
            return base64.b64decode(raw).decode('utf-8')
        except Exception as exc:
            raise RuntimeError('VAPID_PRIVATE_KEY_B64 must be standard Base64 encoding of a PEM private key.') from exc
    # Direct PEM value is supported, including literal escaped newlines.
    direct = os.getenv('VAPID_PRIVATE_KEY_PEM', '').strip()
    return direct.replace('\\n', '\n') if direct else ''

def push_subscription(subscription, title, body, tag):
    public = vapid_public_key()
    private = vapid_private_pem()
    if not public or not private:
        log.warning('Push skipped: VAPID keys are not configured')
        return False
    try:
        from pywebpush import webpush, WebPushException
        webpush(
            subscription_info=subscription,
            data=json.dumps({'title': title, 'body': body, 'tag': tag}),
            vapid_private_key=private,
            vapid_claims={'sub': env_first('VAPID_SUBJECT') or 'mailto:admin@example.com'},
        )
        return True
    except Exception as exc:
        log.warning('Push delivery failed (%s)', type(exc).__name__)
        return False

def send_push_to_all(title, body, tag):
    with db() as con:
        rows = con.execute('SELECT endpoint, payload FROM subscriptions').fetchall()
    sent = 0
    for row in rows:
        try:
            ok = push_subscription(json.loads(row['payload']), title, body, tag)
            sent += int(ok)
            # A 404/410 subscription may be expired. Remove only when pywebpush marks it gone.
        except Exception:
            continue
    return sent

# ---- Server-side signal watcher (continues while PWA is closed, while Render service is running) ----
_monitor_started = False
_monitor_lock = threading.Lock()
_last_monitor_error = None

def was_alert_fired(key):
    with db() as con:
        row = con.execute('SELECT alert_key FROM fired_alerts WHERE alert_key=?', (key,)).fetchone()
        return row is not None

def mark_alert_fired(key):
    with db() as con:
        con.execute('INSERT OR IGNORE INTO fired_alerts(alert_key, created_at) VALUES (?, ?)', (key, datetime.now(IST).isoformat()))

def monitor_loop():
    global _last_monitor_error
    interval = max(15, int(os.getenv('MONITOR_INTERVAL_SEC', '20')))
    symbols = [s.strip().upper() for s in os.getenv('MONITOR_SYMBOLS', 'NIFTY').split(',') if s.strip()]
    timeframe = os.getenv('MONITOR_TIMEFRAME', '1m').strip().lower()
    rsi_len = int(os.getenv('RSI_LENGTH', '14'))
    ma_len = int(os.getenv('RSI_SMA_LENGTH', '14'))
    lower = float(os.getenv('RSI_LOWER_LIMIT', '30'))
    log.info('Server-side signal monitor enabled: symbols=%s timeframe=%s interval=%ss', symbols, timeframe, interval)
    while True:
        for symbol in symbols:
            try:
                candles = fetch_candles(symbol, timeframe, 250)
                result = analyze_sequence(candles, rsi_len, ma_len, lower)
                result['symbol'], result['timeframe'] = symbol, timeframe
                if result.get('ready') and result.get('signalOnLatestCandle'):
                    key = f"{symbol}|{timeframe}|{result['signalCandleTime']}|{rsi_len}|{ma_len}|{lower}"
                    if not was_alert_fired(key):
                        mark_alert_fired(key)
                        title = f'{symbol}: RSI crossed above {lower:g}'
                        body = f"RSI {result['rsi']:.2f} > {lower:g}; RSI-SMA {result['rsiSma']:.2f} < {lower:g}. Required sequence completed."
                        count = send_push_to_all(title, body, key)
                        log.info('Signal detected for %s at %s; push deliveries accepted=%s', symbol, result['signalCandleTime'], count)
                _last_monitor_error = None
            except Exception as exc:
                _last_monitor_error = f'{type(exc).__name__}: {exc}'
                log.warning('Monitor check failed for %s: %s', symbol, _last_monitor_error)
        time.sleep(interval)

def start_monitor_once():
    global _monitor_started
    if os.getenv('ENABLE_PUSH_MONITOR', 'true').lower() not in ('1', 'true', 'yes', 'on'):
        return
    with _monitor_lock:
        if not _monitor_started:
            threading.Thread(target=monitor_loop, name='rsi-push-monitor', daemon=True).start()
            _monitor_started = True

# Start monitor for standard single-process Render deployment. If using multiple Gunicorn workers,
# each worker starts a monitor; use WEB_CONCURRENCY=1 to avoid duplicate monitoring.
start_monitor_once()

@app.get('/')
def root():
    return jsonify({
        'name': 'RSI Cross Alarm Backend — Angel One SmartAPI', 'ok': True,
        'features': ['Angel One historical candles', 'RSI(14)+SMA sequence analysis', 'Web Push/VAPID', 'server-side monitor'],
        'endpoints': {
            'GET /api/health': 'health and configuration status',
            'GET /api/status': 'backend status',
            'GET /api/candles?symbol=NIFTY&timeframe=1m&limit=250': 'PWA candle contract',
            'GET /api/rsi-state?symbol=NIFTY&timeframe=1m': 'current RSI sequence state',
            'GET /api/vapid-public-key': 'public VAPID key',
            'POST /api/subscribe': 'register browser push subscription',
            'POST /api/test-push': 'send a test push to saved subscriptions',
        }
    })

@app.get('/api/health')
def health():
    return jsonify({'ok': True, 'service': 'rsi-cross-alarm-backend', 'time': datetime.now(IST).isoformat()})

@app.get('/api/status')
def status():
    with db() as con:
        count = con.execute('SELECT COUNT(*) AS n FROM subscriptions').fetchone()['n']
    return jsonify({
        'ok': True, 'angelOneConfigured': angel_configured(),
        'vapidConfigured': bool(vapid_public_key() and vapid_private_pem()),
        'pushSubscriptions': count,
        'monitorEnabled': os.getenv('ENABLE_PUSH_MONITOR', 'true').lower() in ('1', 'true', 'yes', 'on'),
        'monitorIntervalSec': max(15, int(os.getenv('MONITOR_INTERVAL_SEC', '20'))),
        'lastMonitorError': _last_monitor_error,
    })

@app.get('/api/candles')
def candles_route():
    try:
        symbol = request.args.get('symbol', 'NIFTY')
        timeframe = request.args.get('timeframe', '1m')
        limit = request.args.get('limit', '250')
        rows = fetch_candles(symbol, timeframe, int(limit))
        return jsonify({'ok': True, 'symbol': symbol.upper(), 'timeframe': timeframe, 'candles': rows})
    except ValueError as exc:
        return jsonify({'ok': False, 'error': str(exc)}), 400
    except Exception as exc:
        log.exception('Candle endpoint failed')
        return jsonify({'ok': False, 'error': str(exc)}), 502

@app.get('/api/rsi-state')
def rsi_state_route():
    try:
        symbol = request.args.get('symbol', 'NIFTY').upper()
        timeframe = request.args.get('timeframe', '1m').lower()
        rsi_len = max(1, min(100, int(request.args.get('rsiLength', os.getenv('RSI_LENGTH', '14')))))
        ma_len = max(1, min(100, int(request.args.get('maLength', os.getenv('RSI_SMA_LENGTH', '14')))))
        lower = max(1.0, min(49.0, float(request.args.get('lowerLimit', os.getenv('RSI_LOWER_LIMIT', '30')))))
        rows = fetch_candles(symbol, timeframe, 250)
        result = analyze_sequence(rows, rsi_len, ma_len, lower)
        result['symbol'], result['timeframe'] = symbol, timeframe
        return jsonify(result)
    except ValueError as exc:
        return jsonify({'ready': False, 'error': str(exc)}), 400
    except Exception as exc:
        log.exception('RSI state endpoint failed')
        return jsonify({'ready': False, 'error': str(exc)}), 502

@app.get('/api/vapid-public-key')
def get_vapid_public_key():
    key = vapid_public_key()
    if not key:
        return jsonify({'ok': False, 'error': 'VAPID_PUBLIC_KEY is not configured'}), 503
    return jsonify({'ok': True, 'publicKey': key})

@app.post('/api/subscribe')
def subscribe():
    payload = request.get_json(silent=True) or {}
    subscription = payload.get('subscription', payload)
    if not isinstance(subscription, dict) or not subscription.get('endpoint') or not isinstance(subscription.get('keys'), dict):
        return jsonify({'ok': False, 'error': 'Expected a Web Push subscription object containing endpoint and keys.'}), 400
    with db() as con:
        con.execute('INSERT OR REPLACE INTO subscriptions(endpoint, payload, created_at) VALUES (?, ?, ?)',
                    (subscription['endpoint'], json.dumps(subscription), datetime.now(IST).isoformat()))
    return jsonify({'ok': True, 'message': 'Push subscription saved.'})

@app.post('/api/test-push')
def test_push():
    if not (vapid_public_key() and vapid_private_pem()):
        return jsonify({'ok': False, 'error': 'Configure VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY_B64 first.'}), 503
    sent = send_push_to_all('RSI Alarm Test', 'Your backend can send a web push notification.', f'test-{int(time.time())}')
    return jsonify({'ok': sent > 0, 'accepted': sent})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', '10000')))
