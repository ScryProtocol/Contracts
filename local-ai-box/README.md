# Local AI Box

A local ChatGPT-style web app with:

- Local user accounts (register/login)
- Personality selection
- Model selection (from local Ollama)
- Optional web search context (DuckDuckGo)
- Chat history per user

## Requirements

- Node.js 18+
- [Ollama](https://ollama.com/) running locally (default: `http://127.0.0.1:11434`)
- At least one installed Ollama model (example: `ollama pull llama3.2`)

## Run

```bash
cd local-ai-box
npm start
```

Open `http://localhost:8787`.

## Environment variables

- `PORT` (default `8787`)
- `OLLAMA_URL` (default `http://127.0.0.1:11434`)

Example:

```bash
PORT=9000 OLLAMA_URL=http://127.0.0.1:11434 npm start
```

## Notes

- Data is stored in `local-ai-box/data/app-data.json`.
- Search results are used as extra context; they may be incomplete.
- Session tokens are in-memory server sessions and browser localStorage.
