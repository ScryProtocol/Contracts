# SCP Challenge Watchers

Runs onchain challenge monitors for both parties:

- `ROLE=agent`: uses agent state + hub signature (`sigB`) to challenge stale close.
- `ROLE=hub`: uses hub state + agent signature (`sigA`) to challenge stale close.

## Required Env

- `RPC_URL`
- `CONTRACT_ADDRESS`
- `CHANNEL_ID`
- `WATCHER_PRIVATE_KEY`

Optional:

- `POLL_MS` (default `5000`)
- `SAFETY_BUFFER_SEC` (default `2`)
- `HUB_STORE_PATH` (default `node/scp-hub/data/store.json`)
- `AGENT_STATE_PATH` (default `node/scp-agent/state/agent-state.json`)

## Run

Hub watcher:

```bash
ROLE=hub RPC_URL=... CONTRACT_ADDRESS=... CHANNEL_ID=... WATCHER_PRIVATE_KEY=... \
  node node/scp-watch/challenge-watcher.js
```

Agent watcher:

```bash
ROLE=agent RPC_URL=... CONTRACT_ADDRESS=... CHANNEL_ID=... WATCHER_PRIVATE_KEY=... \
  node node/scp-watch/challenge-watcher.js
```
