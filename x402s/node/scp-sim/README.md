# SCP Multi-Node Simulation

Runs a local simulation of:

- 1 hub
- N payees
- M agents
- R payment rounds

All agent payments route through the hub (`A -> H -> B`).

## Run

```bash
node node/scp-sim/sim-multi-node.js
```

Or with custom scale:

```bash
SIM_PAYEES=5 SIM_AGENTS=8 SIM_ROUNDS=3 node node/scp-sim/sim-multi-node.js
```

## Output

Prints JSON summary with:

- attempted / ok / fail totals
- elapsed time and throughput
- p95 latency
- sample failures

## Mixed Traffic (Agents + Raw x402 API)

Runs both:

- agent SDK payments (`ScpAgentClient`)
- direct x402 API style payments (`402 -> quote -> issue -> retry`)

```bash
node node/scp-sim/sim-mixed.js
```

Scale knobs:

```bash
SIM_PAYEES=3 SIM_AGENTS=3 SIM_API_CLIENTS=3 SIM_ROUNDS=2 \
  node node/scp-sim/sim-mixed.js
```
