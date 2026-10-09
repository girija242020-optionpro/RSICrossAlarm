# DhanHQ RSI Cross Alarm Backend

Node.js backend designed for the supplied `RSI_Cross_Alarm_PWA.zip`. It implements the PWA's exact endpoint:

`GET /api/candles?symbol=NIFTY&timeframe=1m&limit=250`

Response includes chronological `candles` in `{time,open,high,low,close,volume}` format. RSI calculation and sequence detection remain in the PWA; this backend only supplies market candles from DhanHQ.

## Deploy on Render
1. Upload/extract this ZIP into a GitHub repository.
2. Create a Render **Web Service** from that repository.
3. Runtime: Node; Build command: `npm install`; Start command: `npm start`.
4. Add environment variables from `.env.example` to Render. Set `DHAN_CLIENT_ID` and a current `DHAN_ACCESS_TOKEN` from Dhan. Never place broker credentials in the PWA.
5. Set `CORS_ORIGIN` to the exact HTTPS frontend origin after preview/deployment, or `*` during initial testing.
6. Check `/api/health`, then `/api/status`, then `/api/candles?symbol=NIFTY&timeframe=1m&limit=250`.
7. In the PWA settings, paste the backend base URL (no `/api/candles` suffix) and press Connect.

## Environment
All requested environment names are included in `.env.example`, including the five index IDs and operational limits. Dhan chart API requests use `DHAN_ACCESS_TOKEN` and `DHAN_CLIENT_ID`. Tokens expire/rotate; refresh the token in Render when required. This service does not generate broker tokens or request/order execution.

## VAPID keys
The `.env.example` contains a valid generated P-256 VAPID key pair. Copy `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` exactly. Keep the private key secret. These keys are reserved for push integration; this backend build exposes the public key through `/api/config` but does not yet implement subscription storage or sending push messages.

## Data notes
- Dhan intraday candle API is queried for the latest five calendar days so recent candles remain available after the session closes, subject to Dhan API availability and token permissions.
- When Dhan fails temporarily after a successful request, the API can return the last cached candle set with `stale: true` and a warning. The PWA currently ignores the `stale` flag in its UI, so check `/api/status` during diagnosis.
- A candle close is not a true tick-by-tick CMP. The `/api/spot` endpoint reports the latest available 1-minute candle close. For true tick-level spot and depth, a Dhan market-feed WebSocket consumer must be added separately.
- This backend supplies data, not a profitability guarantee or order execution.
