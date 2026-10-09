# RSI Cross Alarm Backend — Angel One SmartAPI

Backend for the accompanying RSI Cross Alarm PWA. It exposes the exact candle API the PWA expects and can monitor the RSI sequence server-side for Web Push delivery while the PWA is closed (provided the Render service is running and Angel One data/authentication is working).

## Exact signal sequence

Defaults: RSI length 14, RSI smoothing SMA length 14, lower limit 30, timeframe 1m.

1. RSI < 30 AND RSI-SMA < 30.
2. RSI crosses above RSI-SMA while RSI < 30 AND RSI-SMA < 30.
3. RSI crosses above 30 while RSI > RSI-SMA AND RSI-SMA < 30.

The push monitor fires only if Step 3 is the latest returned candle. It suppresses duplicate alerts for the same symbol/timeframe/candle in the current database. The PWA itself calculates the same sequence from `/api/candles` and plays its foreground beep.

## Deploy to Render

1. Upload this folder to a new GitHub repository, or extract the ZIP and push its files to GitHub.
2. In Render, create **New + → Web Service**, connect that repository, choose Python runtime.
3. Build command: `pip install -r requirements.txt`
4. Start command: `gunicorn app:app --workers 1 --threads 4 --timeout 120`
5. Add the environment variables listed below. Keep `WEB_CONCURRENCY` at 1 / use the single worker command above because the background monitor is started inside the web process.
6. Deploy, then test `/api/health`, `/api/status`, and `/api/candles?symbol=NIFTY&timeframe=1m&limit=250`.
7. Paste the Render service base URL (not a specific endpoint) into the PWA Backend URL setting, e.g. `https://your-service.onrender.com`.

`render.yaml` is included as an optional Blueprint configuration.

## Required Render environment variables

- `ANGELONE_API_KEY`: Angel One SmartAPI key
- `ANGELONE_CLIENT_CODE`: client/user code
- `ANGELONE_PIN`: trading PIN/password used for SmartAPI login
- `ANGELONE_TOTP_SECRET`: TOTP secret (not the six-digit current TOTP code)
- `VAPID_PUBLIC_KEY`: browser-safe Web Push public key
- `VAPID_PRIVATE_KEY_B64`: Base64-encoded PEM private key; keep secret
- `VAPID_SUBJECT`: e.g. `mailto:you@example.com`

The app also accepts aliases `ANGEL_ONE_API_KEY`, `ANGEL_API_KEY`, `ANGEL_ONE_CLIENT_CODE`, `ANGEL_CLIENT_CODE`, `ANGEL_CLIENT_ID`, `ANGEL_ONE_PIN`, `ANGEL_PIN`, `ANGEL_ONE_TOTP_SECRET`, and `ANGEL_TOTP_SECRET`.

Generate VAPID values locally by installing the dependencies and running:

```bash
python generate_vapid.py
```

Copy the printed `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY_B64`, and `VAPID_SUBJECT` values into Render → Environment. Do not paste the private key into the PWA or share it in chat.

## API contract

### `GET /api/candles?symbol=NIFTY&timeframe=1m&limit=250`

Returns the contract required by the PWA:

```json
{
  "ok": true,
  "symbol": "NIFTY",
  "timeframe": "1m",
  "candles": [
    {"time":"2026-10-09T09:15:00+05:30","open":25200,"high":25210,"low":25190,"close":25205,"volume":0}
  ]
}
```

Supported symbols: `NIFTY`, `SENSEX`. Supported timeframes: `1m`, `3m`, `5m`, `10m`, `15m`, `30m`, `1h`, `1d`. Tokens default to NIFTY 50 `99926000` on NSE and SENSEX `99919000` on BSE; override `NIFTY_SYMBOL_TOKEN` or `SENSEX_SYMBOL_TOKEN` if required by your current Angel One instrument master.

### Other endpoints

- `GET /` — endpoint inventory
- `GET /api/health` — health check
- `GET /api/status` — Angel One/VAPID configuration and push subscriber count
- `GET /api/rsi-state?symbol=NIFTY&timeframe=1m&rsiLength=14&maLength=14&lowerLimit=30` — sequence state
- `GET /api/vapid-public-key` — public VAPID key
- `POST /api/subscribe` — store a browser PushSubscription JSON object (body may be the subscription itself or `{ "subscription": ... }`)
- `POST /api/test-push` — send a test push to saved subscriptions

## Important PWA integration note

The PWA ZIP made earlier calls `/api/candles`, so foreground RSI calculation and beep can work with this backend once the Angel One login and candle route are verified. That PWA version does **not yet register a PushSubscription or POST it to `/api/subscribe`**. To receive background web pushes, its UI code must call `/api/vapid-public-key`, run `serviceWorkerRegistration.pushManager.subscribe(...)`, POST the subscription to `/api/subscribe`, and its service worker must display the incoming `push` event. Backend VAPID variables alone do not make the existing PWA subscribe automatically.

A push notification is not equivalent to a native Android Clock alarm: Android/browser power policies can delay or suppress delivery and do not guarantee a full-volume continuous sound or waking a sleeping phone. The server-side monitor can detect while Render is running, but push delivery still depends on browser/device settings and a valid subscription.

## Data and operational notes

- SmartAPI credentials stay on the server; never put them in the PWA.
- This service only reads historical candles and sends notifications; it does not place orders.
- Angel One authentication, market-data entitlement, index token validity, rate limits, and API availability must be verified with your own account. The code cannot verify your private credentials from this ZIP.
- The free Render service may sleep and its filesystem may be ephemeral. For reliable background monitoring use an always-on service and a persistent disk for SQLite. With a free/sleeping instance, server-side monitoring is not guaranteed to run continuously.
- The server-side watcher polls every 20 seconds by default. Historical candle API response behavior and in-progress candle updates can affect alert timing. Validate against live market data before relying on it.
- `CORS_ORIGINS=*` is convenient for initial testing. For production, set it to your exact HTTPS PWA origin(s), comma-separated.
