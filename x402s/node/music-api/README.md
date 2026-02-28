# Music API (Paid Streaming)

Pay-per-second music streaming demo using `statechannel-hub-v1`.

The server exposes a track catalog and a `/music/chunk` endpoint that returns
402 with stream offers.  Each paid tick unlocks `t` seconds of playback.
A built-in WebSocket layer pushes `scp.402` / `scp.approved` events to the
browser frontend so the agent (browser or CLI) can drive the payment loop.

## Run

```bash
node node/music-api/server.js
```

Required env:

- `PAYEE_PRIVATE_KEY`

Optional env:

- `MUSIC_HOST` / `HOST` (default `127.0.0.1`)
- `MUSIC_PORT` / `PORT` (default `4095`)
- `NETWORK` (default `base`)
- `HUB_NAME` (default `pay.eth`)
- `HUB_ENDPOINT` / `HUB_URL` (default resolved from `NETWORK`)
- `MUSIC_PRICE_ETH` (default `0.0000001`)
- `MUSIC_STREAM_T_SEC` / `STREAM_T_SEC` (default `5`)
- `MUSIC_PUBLIC_BASE_URL` / `PUBLIC_BASE_URL` (for proxy / HTTPS)
- `CORS_ORIGIN` (default `*`)

## Endpoints

| Route | Method | Description |
|---|---|---|
| `/health` | GET | Server status, track count, session count |
| `/music/catalog` | GET | Track catalog JSON |
| `/v1/music/catalog` | GET | Alias |
| `/music` | GET | 402 chunk endpoint (JSON) or browser app (if `Accept: text/html`) |
| `/music/chunk` | GET | 402 chunk endpoint |
| `/v1/music/chunk` | GET | Alias |
| `/app` | GET | Browser frontend |
| `/pay` | GET | Preview offer payload without 402 |
| `/music/ws` | WS | WebSocket for real-time stream events |

## Stream Offer

Each 402 response includes a `stream` extension:

```json
{
  "extensions": {
    "statechannel-hub-v1": {
      "stream": { "amount": "100000000000", "t": 5 }
    }
  }
}
```

- `amount` — wei charged per tick
- `t` — cadence in seconds (agent should pay every `t` seconds)

## Stream Client (CLI)

```bash
npm run scp:music:stream -- [baseUrl] [options]
```

Options:

- `--track <id>` — track id from catalog (default: first)
- `--cursor <sec>` — start position
- `--route <hub|direct|auto>` — route preference
- `--ticks <n>` — max paid ticks (0 = infinite)
- `--interval-sec <n>` — override cadence
- `--continue-on-error` — keep going after failures

## WebSocket Protocol

Connect to `/music/ws?session=<sessionId>`.

**Client → Server:**

| Type | Fields | Description |
|---|---|---|
| `offer.get` | `track`, `cursor` | Request fresh 402 offer |
| `control.start` | `track`, `cursor` | Begin stream |
| `control.stop` | — | Stop stream |
| `scp.approve` | `amount`, `t` | Pre-approve stream terms |
| `ping` | — | Keep-alive |

**Server → Client:**

| Type | Fields | Description |
|---|---|---|
| `ws.connected` | `sessionId`, `amount`, `t` | Connection established |
| `scp.402` | `offer` | Payment required (new tick) |
| `scp.approved` | `paymentId`, `stream`, `chunk` | Tick paid successfully |
| `scp.rejected` | `error` | Payment failed |
| `stream.start` | `amount`, `t` | Stream loop started |
| `stream.stop` | — | Stream stopped |
| `pong` | — | Keep-alive response |

## Browser App

Navigate to `http://localhost:4095/music` for the built-in frontend with:

- Track library with search, favorites, shuffle, repeat
- Vinyl visualizer with FFT frequency bars
- Real-time tick/charge/failure counters
- WebSocket event log
- Keyboard shortcuts (Space, →, /, M)

The browser app connects via WebSocket and expects an external agent to handle
the actual payment loop.  The CLI stream client or the browser SCP agent
(`scp-agent/index.html`) can drive payments.
