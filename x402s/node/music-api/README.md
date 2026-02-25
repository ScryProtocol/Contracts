# Music API (Paid Stream Chunks)

Spotify-style demo app that keeps a payment connection alive by charging every 5s (`statechannel-hub-v1`).

## Run

```bash
npm run scp:music
```

Terminal stream client (pays every 5s and advances `cursor`):

```bash
npm run scp:music:stream -- http://127.0.0.1:4095 --track neon-sky
```

Required env:

- `PAYEE_PRIVATE_KEY`

Optional env:

- `MUSIC_HOST` (default `127.0.0.1`)
- `MUSIC_PORT` (default `4095`)
- `NETWORK` (default `base`)
- `HUB_NAME` (default `pay.eth`)
- `HUB_ENDPOINT` or `HUB_URL` (defaults from network)
- `MUSIC_PRICE_ETH` (default `0.0000001`)
- `MUSIC_STREAM_T_SEC` or `STREAM_T_SEC` (default `5`)

## Endpoints

- `GET /music` (or `/app`) : Spotify-like web player UI in browser, paid JSON route for API clients
- `GET /music/catalog` (or `/v1/music/catalog`) : free track list
- `GET /music/chunk?track=<id>&cursor=<sec>` (or `/v1/music/chunk?...`) : paid chunk route
- `WS /music/ws?session=<id>` (or `/ws`) : stream control + 402 signaling channel
- `GET /pay` : offer discovery
- `GET /health`

## WebSocket Flow

Sessionized control (app and SCP client can both drive it):

1. `offer.get` -> server returns `offer` with stream `amount/t`
2. `control.start` -> server sends `scp.402` offer + broadcasts `stream.start`
3. Any payer pays `/music/chunk?...&session=<id>` with SCP proof
4. Server emits `scp.approved` with `stream.nextCursor` after each paid tick
5. `control.stop` -> server broadcasts `stream.stop`

Event types:

- `ws.connected`
- `offer`
- `scp.402`
- `scp.approved`
- `scp.rejected`
- `stream.start`
- `stream.stop`

## Practical Stream Steps

1. Open `/music` and copy the session id shown in UI.
2. Start control (`control.start`) from UI or WS client.
3. Use an SCP payer to repeatedly pay:
   - `GET /music/chunk?track=<id>&cursor=<sec>&session=<sessionId>`
4. Respect cadence from offer metadata:
   - `accepts[].extensions["statechannel-hub-v1"].stream.t`
5. Update `cursor` from each response:
   - `response.stream.nextCursor`

If payments stop, the web app auto-stops after a timeout (~2 cadence windows).

## Stream Metadata

Hub offers include:

`accepts[].extensions["statechannel-hub-v1"].stream = { amount, t }`

- `amount`: raw wei per chunk window
- `t`: cadence in seconds (default `5`)
