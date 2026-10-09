# RSI Cross Alarm — Angel One backend (Node.js)

This is a Node.js/Express rewrite. It does not use Python.

## Render settings
- Runtime: Node
- Root Directory: blank if these files are in the repository root; otherwise the folder containing `package.json`.
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/api/health`

## Required Render environment variables
- `ANGELONE_API_KEY`
- `ANGELONE_CLIENT_CODE`
- `ANGELONE_PIN`
- `ANGELONE_TOTP_SECRET`

Optional settings are in `.env.example`. Confirm instrument tokens against the current Angel One instrument master for your account/segment before live use.

## VAPID / Web Push
Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` in Render. Generate a matching pair locally with:

```bash
npx web-push generate-vapid-keys
```

Copy the generated public key and private key into the corresponding Render variables. Never put the private key in frontend code or GitHub. The backend endpoint `/api/vapid-public-key` exposes only the public key.

## Endpoints
- `GET /` — endpoint index
- `GET /api/health` — health check
- `GET /api/status` — configuration and monitor status (never returns credentials)
- `GET /api/candles?symbol=NIFTY&timeframe=1m&limit=250`
- `GET /api/rsi-state?symbol=NIFTY&timeframe=1m`
- `GET /api/events` — recent server-detected alerts
- `GET /api/vapid-public-key`
- `POST /api/subscribe` — JSON Web Push subscription
- `POST /api/test-push` — send a test notification to registered subscriptions
- `POST /api/monitor/run-once` — body `{ "symbol": "NIFTY", "timeframe": "1m" }` for a manual diagnostic

## RSI sequence implemented
1. RSI(14) and RSI-SMA(14) both below the configurable lower limit (default 30).
2. RSI crosses above RSI-SMA while both are still below 30.
3. Later RSI crosses above 30, RSI is above RSI-SMA, and RSI-SMA remains below 30.

The server polls both NIFTY and SENSEX at `POLL_INTERVAL_MS` (minimum 15 seconds) and sends Web Push on a qualifying alert. Web Push requires the PWA to request notification permission, create a browser subscription, and POST that subscription to `/api/subscribe`. This backend does not magically add push subscription code to an existing PWA.

## Important operational limits
- SmartAPI credentials, TOTP secret, and VAPID private key belong only in Render environment variables.
- The included subscriptions and recent event history are in memory. A Render restart clears them; use persistent storage if you need durable subscriptions/logs.
- Push notification delivery depends on browser/OS settings and is not a guaranteed Clock-style continuous audio alarm. The PWA must implement foreground audio and a service worker for push handling.
- Validate token IDs, API access, market hours, candle interval support, and current SmartAPI rate limits before relying on live alerts. This package has not been authenticated against your private Angel One account.
