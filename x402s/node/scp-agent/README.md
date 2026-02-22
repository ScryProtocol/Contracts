# SCP Agent Client

`ScpAgentClient` is a reusable agent-side payment client for `statechannel-hub-v1`.

## API

```js
const { ScpAgentClient } = require("./agent-client");
const agent = new ScpAgentClient({...});
const result = await agent.payResource("http://payee/v1/data");
```

`payResource(url)` performs:

1. payee offer discovery via `402`
2. hub quote request
3. local channel state update + signature
4. hub ticket issue
5. paid retry to payee with `PAYMENT-SIGNATURE`
6. receipt persistence

## Persistence

Stores durable state at:

- `node/scp-agent/state/agent-state.json`

Contains:

- channel nonce/balances per hub endpoint
- payment receipts by paymentId

## Demo

```bash
node node/scp-agent/demo-agent.js
```
