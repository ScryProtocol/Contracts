# Local AI — App Development Spec

> Build apps that hook into Local AI. Full control over UI, backend, data, and AI integration.

---

## 1. Architecture

```
local/
├── apps/                          # App packages (one folder per app)
│   ├── translator/
│   │   ├── manifest.json          # App metadata + config
│   │   ├── backend.py             # Python backend (routes, logic)
│   │   ├── templates/
│   │   │   └── index.html         # Jinja2 UI template
│   │   └── static/
│   │       ├── app.js             # Frontend logic
│   │       └── app.css            # App-specific styles
│   ├── flashcards/
│   │   └── ...
│   └── recipes/
│       └── ...
├── app.py                         # Core platform (loads apps dynamically)
├── templates/
│   ├── base.html                  # Base layout (sidebar, theme)
│   └── apps.html                  # App hub page
└── static/
    └── css/style.css              # Global styles
```

Apps are **self-contained packages**. Drop a folder into `apps/`, restart, it's live.

---

## 2. Manifest — `manifest.json`

Every app must have a `manifest.json` at its root.

```json
{
  "id": "translator",
  "name": "Translator",
  "icon": "🌍",
  "version": "1.0.0",
  "description": "Translate text between languages with natural phrasing.",
  "author": "local-ai",

  "entry": {
    "backend": "backend.py",
    "template": "templates/index.html",
    "static": "static/"
  },

  "routes": {
    "page": "/apps/translator",
    "api_prefix": "/api/apps/translator"
  },

  "ai": {
    "system_prompt": "You are a translator. Translate the following text from {source} to {target}. Output ONLY the translation.",
    "output_format": "text",
    "streaming": true,
    "temperature": 0.3,
    "max_tokens": null
  },

  "inputs": [
    {"key": "text",   "type": "textarea", "label": "Text",            "required": true},
    {"key": "source", "type": "select",   "label": "Source Language",  "default": "Auto-detect", "options_ref": "languages"},
    {"key": "target", "type": "select",   "label": "Target Language",  "default": "Spanish",     "options_ref": "languages"}
  ],

  "data": {
    "languages": [
      "Auto-detect", "English", "Spanish", "French", "German", "Italian",
      "Portuguese", "Chinese", "Japanese", "Korean", "Arabic", "Hindi",
      "Russian", "Dutch", "Swedish", "Polish", "Turkish", "Vietnamese",
      "Thai", "Greek", "Hebrew"
    ]
  },

  "permissions": ["ai.stream", "ai.models"],

  "settings": [
    {"key": "default_target", "type": "select", "label": "Default target language", "options_ref": "languages", "default": "Spanish"}
  ],

  "hooks": {
    "on_install": null,
    "on_uninstall": null,
    "on_run": null
  }
}
```

### Manifest fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique slug. Lowercase, hyphens ok. |
| `name` | string | yes | Display name. |
| `icon` | string | yes | Emoji or icon URL. |
| `version` | semver | yes | App version. |
| `description` | string | yes | One-liner for the hub. |
| `author` | string | no | Creator name. |
| `entry.backend` | path | no | Python file with Flask routes. Omit for frontend-only apps. |
| `entry.template` | path | yes | Main Jinja2 template. |
| `entry.static` | path | no | Static assets folder (JS, CSS, images). |
| `routes.page` | string | yes | Main page URL. |
| `routes.api_prefix` | string | no | API route prefix. |
| `ai.system_prompt` | string | no | System prompt template. Supports `{input_key}` interpolation. |
| `ai.output_format` | string | no | `text` (stream raw), `json` (parse on completion), `markdown`. |
| `ai.streaming` | bool | no | Whether to stream tokens to the client. Default `true`. |
| `ai.temperature` | float | no | Override model temperature. |
| `ai.max_tokens` | int | no | Override max output tokens. |
| `inputs` | array | no | Declarative input schema. Used by both auto-UI and validation. |
| `data` | object | no | Static data referenced by inputs via `options_ref`. |
| `permissions` | array | no | What platform features the app needs. |
| `settings` | array | no | Per-user configurable settings. |
| `hooks` | object | no | Lifecycle hooks (Python callables). |

---

## 3. Backend — `backend.py`

A Python module that registers Flask routes. The platform passes the Flask app instance.

```python
"""Translator app backend."""
import json
from flask import request, jsonify, Response, stream_with_context
from flask_login import login_required, current_user


def register(app, platform):
    """Called by the platform on startup. `platform` gives access to core services."""

    @app.route('/api/apps/translator/run', methods=['POST'])
    @login_required
    def run_translator():
        data = request.get_json()
        text = data.get('text', '').strip()
        source = data.get('source', 'Auto-detect')
        target = data.get('target', 'English')

        if not text:
            return jsonify({'error': 'No text provided'}), 400

        # Build prompt from manifest or custom logic
        src = f'from {source} ' if source != 'Auto-detect' else ''
        system = f'You are a translator. Translate the following text {src}to {target}. Output ONLY the translation.'
        messages = [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': text},
        ]

        # Use platform AI streaming
        def generate():
            try:
                for token, done in platform.stream(messages, data):
                    if token:
                        yield platform.sse({'token': token})
                    if done:
                        break
                yield platform.sse({'done': True})
            except Exception as e:
                yield platform.sse({'error': str(e)})

        return Response(stream_with_context(generate()), mimetype='text/event-stream')
```

### Platform object

Passed to `register()`. Provides access to all core services:

```python
class Platform:
    def stream(self, messages, data=None):
        """Stream AI completion. Returns iterator of (token, done).
        Uses backend_id and model from `data` or user defaults."""

    def complete(self, messages, data=None):
        """Non-streaming AI completion. Returns full text."""

    def get_backend(self, backend_id=None):
        """Get a Backend object (Ollama, OpenAI, etc)."""

    def get_user():
        """Get current authenticated user."""

    def db():
        """Get SQLAlchemy db session for app data storage."""

    def web_search(self, query, num_results=5):
        """Run web search, return results list."""

    def fetch_page(self, url, max_chars=3000):
        """Fetch and extract text from a URL."""

    def sse(self, data):
        """Format a dict as an SSE data line."""

    def get_app_setting(self, app_id, key, default=None):
        """Get a per-user app setting."""

    def set_app_setting(self, app_id, key, value):
        """Save a per-user app setting."""

    def get_models(self, backend_id=None):
        """List available models for a backend."""

    def emit(self, event, data):
        """Emit event for inter-app communication."""

    def on(self, event, callback):
        """Listen for platform or inter-app events."""
```

### Backend patterns

**Pattern: Raw streaming (translator, chat-like)**
```python
for token, done in platform.stream(messages, data):
    yield platform.sse({'token': token})
```

**Pattern: Structured JSON output (flashcards, recipes)**
```python
text = platform.complete(messages, data)
# Parse JSON from response
start, end = text.find('['), text.rfind(']') + 1
result = json.loads(text[start:end])
yield platform.sse({'done': True, 'cards': result})
```

**Pattern: Multi-step pipeline (research, analysis)**
```python
# Step 1: Search
yield platform.sse({'status': 'searching'})
results = platform.web_search(query)
yield platform.sse({'status': 'reading'})
context = platform.fetch_page(results[0]['url'])

# Step 2: Analyze with AI
messages.append({'role': 'user', 'content': context + '\n\nAnalyze this.'})
for token, done in platform.stream(messages, data):
    yield platform.sse({'token': token})
```

**Pattern: No AI (pure utility)**
```python
# Apps don't have to use AI at all
@app.route('/api/apps/json-formatter/run', methods=['POST'])
def run():
    text = request.get_json().get('text', '')
    formatted = json.dumps(json.loads(text), indent=2)
    return jsonify({'result': formatted})
```

---

## 4. Frontend — Templates & JS

### Template

Extends `base.html`. Has access to the shared sidebar partial.

```html
{% extends "base.html" %}
{% block title %}Translator – Local AI{% endblock %}
{% block body %}
<div class="app-layout">
    {% include "partials/sidebar.html" %}

    <main class="app-page">
        <div class="app-topbar">
            <a href="/apps" class="app-back">&larr; Apps</a>
            <span class="app-title-bar">🌍 Translator</span>
            <!-- Optional: model/backend selector -->
            <div class="app-topbar-right">
                <select id="app-model" class="app-select"></select>
            </div>
        </div>

        <div class="app-content">
            <!-- Your custom UI here -->
        </div>
    </main>
</div>

<!-- App-specific JS -->
<script src="/apps/translator/static/app.js"></script>
{% endblock %}
```

### JavaScript

Apps get a global `LocalAI` helper object:

```javascript
// ─── LocalAI client SDK (injected by platform) ────────────────────

const LocalAI = {
    // Stream an app API endpoint
    async stream(url, body, { onToken, onDone, onError, onStatus }) {
        const res = await fetch(url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body),
        });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const line of decoder.decode(value).split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const data = JSON.parse(line.slice(6));
                if (data.error)          onError?.(data.error);
                if (data.token)          onToken?.(data.token);
                if (data.status)         onStatus?.(data.status, data);
                if (data.done)           onDone?.(data);
            }
        }
    },

    // Non-streaming fetch
    async run(url, body) {
        const res = await fetch(url, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body),
        });
        return res.json();
    },

    // Load models for a backend
    async getModels(backendId) { ... },

    // Get/set app settings
    async getSetting(key) { ... },
    async setSetting(key, value) { ... },

    // Escape HTML
    esc(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    },
};
```

### Example: Translator JS

```javascript
const $input = document.getElementById('tr-input');
const $output = document.getElementById('tr-output');

document.getElementById('tr-go').addEventListener('click', async () => {
    $output.textContent = '';
    let full = '';

    await LocalAI.stream('/api/apps/translator/run', {
        text: $input.value,
        source: document.getElementById('tr-source').value,
        target: document.getElementById('tr-target').value,
    }, {
        onToken(token) { full += token; $output.textContent = full; },
        onDone()       { /* show copy button */ },
        onError(err)   { $output.textContent = 'Error: ' + err; },
    });
});
```

### Example: Flashcards JS (structured output)

```javascript
await LocalAI.stream('/api/apps/flashcards/run', {
    topic: 'Python basics',
    count: 10,
}, {
    onToken(token)  { /* optional: show raw generation progress */ },
    onDone(data)    { renderCards(data.cards); },  // cards = [{front, back}, ...]
    onError(err)    { showError(err); },
});
```

---

## 5. Output Formats

Apps produce one of these output types:

| Format | Description | Frontend handling |
|---|---|---|
| `text` | Raw streamed text | Append tokens to a container in real-time |
| `json` | Structured JSON | Backend collects full response, parses, sends parsed object with `done` |
| `markdown` | Markdown text | Stream tokens, render markdown on `done` |
| `html` | Raw HTML | Backend returns rendered HTML (non-AI apps) |
| `binary` | File data | Backend returns file URL (image gen, PDF export, etc) |
| `multi` | Multi-part | Backend sends status updates, then final structured result |

### JSON output pattern (backend)

```python
def generate():
    text = platform.complete(messages, data)
    # Find JSON in response
    start = text.find('{')    # or '[' for arrays
    end = text.rfind('}') + 1  # or ']'
    if start >= 0 and end > start:
        parsed = json.loads(text[start:end])
        yield platform.sse({'done': True, 'result': parsed})
    else:
        yield platform.sse({'error': 'Failed to parse output'})
```

### Multi-part output pattern (backend)

```python
def generate():
    yield platform.sse({'status': 'step1', 'message': 'Searching...'})
    results = platform.web_search(query)
    yield platform.sse({'status': 'step2', 'message': 'Analyzing...'})
    for token, done in platform.stream(messages, data):
        yield platform.sse({'token': token})
    yield platform.sse({'done': True, 'metadata': {...}})
```

---

## 6. Data & State

### App-level storage (SQLAlchemy)

Apps can define their own DB models:

```python
# backend.py
from platform_db import db

class FlashcardDeck(db.Model):
    __tablename__ = 'app_flashcards_decks'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, nullable=False)
    topic = db.Column(db.String(200))
    cards_json = db.Column(db.Text)  # JSON array of {front, back}
    created_at = db.Column(db.DateTime, default=db.func.now())
```

Table names must be prefixed with `app_<app_id>_` to avoid collisions.

### Per-user settings

Defined in manifest `settings` array. Stored in platform's `AppSetting` table.

```python
# Read
lang = platform.get_app_setting('translator', 'default_target', 'Spanish')

# Write
platform.set_app_setting('translator', 'default_target', 'French')
```

### Client-side storage

Apps can use `localStorage` namespaced by app ID:

```javascript
localStorage.setItem('app:flashcards:last_topic', 'Python');
```

---

## 7. Permissions

Apps declare what platform features they need:

| Permission | Grants |
|---|---|
| `ai.stream` | Stream AI completions |
| `ai.complete` | Non-streaming AI completions |
| `ai.models` | List/select models |
| `web.search` | Use web search |
| `web.fetch` | Fetch external URLs |
| `data.read` | Read from app DB tables |
| `data.write` | Write to app DB tables |
| `user.settings` | Read/write per-user app settings |
| `user.profile` | Read user profile info |
| `files.read` | Read uploaded files |
| `files.write` | Write/save files to disk |
| `apps.emit` | Emit inter-app events |

---

## 8. Hooks & Events

### Lifecycle hooks

```json
{
  "hooks": {
    "on_install": "setup",
    "on_uninstall": "teardown",
    "on_run": "pre_run",
    "on_settings_change": "on_settings"
  }
}
```

```python
def setup(platform):
    """Called once when app is installed. Create tables, seed data."""
    platform.db().create_all()

def teardown(platform):
    """Called on uninstall. Clean up."""

def pre_run(platform, data):
    """Called before every /run request. Can modify data or abort."""
    return data  # return modified data, or raise to abort
```

### Inter-app events

```python
# App A emits
platform.emit('translation.complete', {'text': translated, 'lang': target})

# App B listens
platform.on('translation.complete', lambda data: save_to_deck(data))
```

---

## 9. UI Components

Reusable CSS classes from the platform:

### Layout
- `.app-page` — Full-height scrollable main area
- `.app-topbar` — Top bar with back link and title
- `.app-content` — Padded content container (max-width centered)

### Form controls (reuse from image gen styles)
- `.ig-field` — Field wrapper with label
- `.ig-field label` — Uppercase dim label
- `.ig-field input/select/textarea` — Styled dark inputs
- `.ig-row` — Horizontal flex row of fields

### Buttons
- `.btn.btn-primary` — Green accent button
- `.fc-btn` — Secondary ghost button
- `.toggle-btn` — Pill toggle (on/off)

### Status
- `.status-dot` — Pulsing green dot
- `.hidden` — Display none

### Cards
- `.app-card-link` — Clickable card with icon, body, arrow

---

## 10. App Loading (Platform Internals)

How the platform discovers and loads apps:

```python
import os, json, importlib.util

APPS_DIR = os.path.join(os.path.dirname(__file__), 'apps')

def load_apps(flask_app, platform):
    """Scan apps/ directory, load manifests, register backends."""
    apps = {}
    if not os.path.isdir(APPS_DIR):
        return apps

    for name in os.listdir(APPS_DIR):
        app_dir = os.path.join(APPS_DIR, name)
        manifest_path = os.path.join(app_dir, 'manifest.json')
        if not os.path.isfile(manifest_path):
            continue

        with open(manifest_path) as f:
            manifest = json.load(f)

        app_id = manifest['id']
        apps[app_id] = manifest

        # Register backend routes
        backend_file = manifest.get('entry', {}).get('backend')
        if backend_file:
            spec = importlib.util.spec_from_file_location(
                f'app_{app_id}', os.path.join(app_dir, backend_file)
            )
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            if hasattr(mod, 'register'):
                mod.register(flask_app, platform)

        # Register static files
        static_dir = manifest.get('entry', {}).get('static')
        if static_dir:
            from flask import send_from_directory
            static_path = os.path.join(app_dir, static_dir)

            @flask_app.route(f'/apps/{app_id}/static/<path:filename>')
            def serve_app_static(filename, _dir=static_path):
                return send_from_directory(_dir, filename)

        # Register page route
        template_path = os.path.join(app_dir, manifest['entry']['template'])

        @flask_app.route(manifest['routes']['page'])
        @login_required
        def app_page(_tpl=template_path, _manifest=manifest):
            return render_template_string(
                open(_tpl).read(),
                app=_manifest, user=current_user
            )

    return apps
```

---

## 11. Built-in Apps Reference

### Translator

```
ID:       translator
Type:     text streaming
AI:       yes (stream)
Inputs:   text, source language, target language
Output:   streamed translated text
UI:       side-by-side panels, language bar with swap
```

**Key features:**
- Auto-detect source language
- Swap languages + swap text content
- Real-time token streaming into output panel
- Copy to clipboard
- Ctrl+Enter shortcut

### Flashcards

```
ID:       flashcards
Type:     structured JSON
AI:       yes (complete → parse JSON)
Inputs:   topic, card count
Output:   array of {front, back} objects
UI:       generate form → flip-card study mode
```

**Key features:**
- Two modes: generate and study
- 3D CSS card flip animation
- Keyboard nav: arrows (prev/next), space (flip)
- Shuffle, progress bar
- AI returns JSON array, parsed on completion

### Recipes & Meal Prep

```
ID:       recipes
Type:     structured JSON
AI:       yes (complete → parse JSON)
Inputs:   ingredients, dietary, servings, meal type
Output:   recipe object with title, times, ingredients, steps
UI:       input form → structured recipe display
```

**Key features:**
- Checkable ingredient list (strikethrough on check)
- Numbered steps with accent markers
- Prep/cook/servings badges
- Tips section
- AI returns JSON object, parsed on completion

---

## 12. Creating a New App — Quickstart

### 1. Create the folder

```bash
mkdir -p apps/my-app/{templates,static}
```

### 2. Write the manifest

```bash
cat > apps/my-app/manifest.json << 'EOF'
{
  "id": "my-app",
  "name": "My App",
  "icon": "⚡",
  "version": "1.0.0",
  "description": "Does something cool.",
  "entry": {
    "backend": "backend.py",
    "template": "templates/index.html",
    "static": "static/"
  },
  "routes": {
    "page": "/apps/my-app",
    "api_prefix": "/api/apps/my-app"
  },
  "ai": {
    "output_format": "text",
    "streaming": true
  },
  "permissions": ["ai.stream"]
}
EOF
```

### 3. Write the backend

```python
# apps/my-app/backend.py
import json
from flask import request, jsonify, Response, stream_with_context
from flask_login import login_required

def register(app, platform):

    @app.route('/api/apps/my-app/run', methods=['POST'])
    @login_required
    def run():
        data = request.get_json()
        prompt = data.get('prompt', '').strip()
        if not prompt:
            return jsonify({'error': 'No prompt'}), 400

        messages = [
            {'role': 'system', 'content': 'You are a helpful assistant.'},
            {'role': 'user', 'content': prompt},
        ]

        def generate():
            try:
                for token, done in platform.stream(messages, data):
                    if token:
                        yield platform.sse({'token': token})
                    if done:
                        break
                yield platform.sse({'done': True})
            except Exception as e:
                yield platform.sse({'error': str(e)})

        return Response(stream_with_context(generate()), mimetype='text/event-stream')
```

### 4. Write the template

```html
{% extends "base.html" %}
{% block body %}
<div class="app-layout">
    {% include "partials/sidebar.html" %}
    <main class="app-page">
        <div class="app-topbar">
            <a href="/apps" class="app-back">&larr; Apps</a>
            <span class="app-title-bar">⚡ My App</span>
        </div>
        <div style="max-width:600px; margin:0 auto; padding:28px 24px;">
            <textarea id="prompt" class="ig-field" rows="4" placeholder="Ask anything..."></textarea>
            <button class="btn btn-primary" style="width:100%; margin-top:8px;" id="go">Run</button>
            <div id="output" style="margin-top:16px; white-space:pre-wrap;"></div>
        </div>
    </main>
</div>
<script>
document.getElementById('go').addEventListener('click', async () => {
    const output = document.getElementById('output');
    output.textContent = '';
    let full = '';
    const res = await fetch('/api/apps/my-app/run', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ prompt: document.getElementById('prompt').value }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value).split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = JSON.parse(line.slice(6));
            if (data.token) { full += data.token; output.textContent = full; }
            if (data.error) { output.textContent = 'Error: ' + data.error; }
        }
    }
});
</script>
{% endblock %}
```

### 5. Restart

```bash
python app.py
```

App appears at `/apps/my-app` and in the hub grid.

---

## 13. Advanced Patterns

### Chained AI calls

```python
# Step 1: Extract keywords
kw_messages = [{'role': 'system', 'content': 'Extract 5 keywords.'}, ...]
keywords = platform.complete(kw_messages, data)

# Step 2: Use keywords in second call
messages = [{'role': 'system', 'content': f'Write about: {keywords}'}, ...]
for token, done in platform.stream(messages, data):
    yield platform.sse({'token': token})
```

### Web-augmented (RAG)

```python
yield platform.sse({'status': 'searching'})
results = platform.web_search(query)
context = '\n'.join(platform.fetch_page(r['url']) for r in results[:3])
messages.append({'role': 'user', 'content': f'Context:\n{context}\n\nQuestion: {query}'})
for token, done in platform.stream(messages, data):
    yield platform.sse({'token': token})
```

### Frontend-only app (no AI)

```json
{
  "id": "json-formatter",
  "entry": { "template": "templates/index.html" },
  "permissions": []
}
```

No `backend.py` needed. All logic in JS.

### Multi-model app

```python
# Use one model to generate, another to critique
draft = platform.complete(gen_messages, {**data, 'model': 'llama3.2'})
critique = platform.complete(review_messages, {**data, 'model': 'mistral'})
```

### Persistent app data

```python
# Save generated flashcard decks to DB
deck = FlashcardDeck(user_id=current_user.id, topic=topic, cards_json=json.dumps(cards))
platform.db().session.add(deck)
platform.db().session.commit()

# Load saved decks
decks = FlashcardDeck.query.filter_by(user_id=current_user.id).order_by(FlashcardDeck.created_at.desc()).all()
```

---

## 14. SSE Protocol

All streaming app endpoints use Server-Sent Events.

### Event types

```
data: {"token": "Hello"}           # Streaming text token
data: {"status": "searching"}      # Status update (shown in UI)
data: {"status": "reading", "url": "https://..."}
data: {"search_results": [...]}    # Web search results
data: {"done": true}               # Completion (text output)
data: {"done": true, "cards": [...]}  # Completion (JSON output)
data: {"done": true, "recipe": {...}} # Completion (JSON output)
data: {"error": "message"}         # Error
```

### Client-side consumption

```javascript
const res = await fetch(url, { method: 'POST', ... });
const reader = res.body.getReader();
const decoder = new TextDecoder();

while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = JSON.parse(line.slice(6));
        // handle data.token, data.done, data.error, data.status
    }
}
```

---

## 15. Theming

Apps inherit the platform's CSS variables:

```css
--bg: #212121;
--bg-sidebar: #171717;
--bg-input: #2f2f2f;
--bg-hover: #2f2f2f;
--border: #383838;
--text: #ececec;
--text-secondary: #b4b4b4;
--text-dim: #767676;
--accent: #10a37f;
--accent-hover: #0e8c6d;
--radius: 16px;
--font: 'Söhne', -apple-system, ...;
--font-mono: 'Söhne Mono', 'Fira Code', monospace;
```

Use these in app CSS for consistency. Apps can define their own CSS scoped with `.app-<id>` class prefix.
