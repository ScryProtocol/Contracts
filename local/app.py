import os
import json
import re
import requests
from urllib.parse import quote_plus
from datetime import datetime
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify, Response, stream_with_context
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'local-ai-stable-key-2026')
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///local.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

OLLAMA_BASE = os.environ.get('OLLAMA_HOST', 'http://localhost:11434')
SD_BASE = os.environ.get('SD_HOST', 'http://localhost:7860')

db = SQLAlchemy(app)
login_manager = LoginManager(app)
login_manager.login_view = 'login'

# ─── Models ───────────────────────────────────────────────────────────

class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    default_model = db.Column(db.String(120), default='llama3.2')
    default_personality = db.Column(db.String(120), default='default')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    conversations = db.relationship('Conversation', backref='user', lazy=True, cascade='all, delete-orphan')

    def set_password(self, pw):
        self.password_hash = generate_password_hash(pw)

    def check_password(self, pw):
        return check_password_hash(self.password_hash, pw)


class Conversation(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    title = db.Column(db.String(200), default='New Chat')
    model = db.Column(db.String(120))
    personality = db.Column(db.String(120), default='default')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    messages = db.relationship('Message', backref='conversation', lazy=True, cascade='all, delete-orphan',
                               order_by='Message.created_at')


class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    conversation_id = db.Column(db.Integer, db.ForeignKey('conversation.id'), nullable=False)
    role = db.Column(db.String(20), nullable=False)  # user | assistant | system
    content = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class Backend(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    name = db.Column(db.String(120), nullable=False)
    kind = db.Column(db.String(30), nullable=False)  # ollama | openai | lmstudio | llamacpp | custom
    base_url = db.Column(db.String(500), nullable=False)
    api_key = db.Column(db.String(500), default='')
    is_default = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    # kind presets
    KIND_DEFAULTS = {
        'ollama':   {'url': 'http://localhost:11434', 'name': 'Ollama'},
        'lmstudio': {'url': 'http://localhost:1234',  'name': 'LM Studio'},
        'llamacpp': {'url': 'http://localhost:8080',  'name': 'llama.cpp'},
        'openai':   {'url': 'https://api.openai.com', 'name': 'OpenAI'},
        'custom':   {'url': 'http://localhost:8000',  'name': 'Custom (OpenAI-compatible)'},
    }


class GeneratedImage(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    prompt = db.Column(db.Text, nullable=False)
    negative_prompt = db.Column(db.Text, default='')
    model = db.Column(db.String(200), default='')
    width = db.Column(db.Integer, default=512)
    height = db.Column(db.Integer, default=512)
    steps = db.Column(db.Integer, default=20)
    cfg_scale = db.Column(db.Float, default=7.0)
    seed = db.Column(db.Integer, default=-1)
    filename = db.Column(db.String(300), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


@login_manager.user_loader
def load_user(uid):
    return db.session.get(User, int(uid))

# ─── Apps (dynamic loader) ────────────────────────────────────────────

import importlib.util

APPS_DIR = os.path.join(os.path.dirname(__file__), 'apps')


class Platform:
    """Core services exposed to apps via their register() function."""

    def __init__(self, flask_app):
        self._app = flask_app

    def stream(self, messages, data=None):
        data = data or {}
        backend = get_active_backend(data.get('backend_id'))
        model = data.get('model', current_user.default_model)
        if not backend:
            raise RuntimeError('No backend configured')
        if backend.kind == 'ollama':
            return stream_ollama(backend, model, messages)
        return stream_openai_compat(backend, model, messages)

    def complete(self, messages, data=None):
        tokens = []
        for token, done in self.stream(messages, data):
            if token:
                tokens.append(token)
            if done:
                break
        return ''.join(tokens)

    def sse(self, data):
        return f"data: {json.dumps(data)}\n\n"

    def web_search(self, query, num_results=5):
        return web_search(query, num_results)

    def fetch_page(self, url, max_chars=3000):
        return fetch_page_text(url, max_chars)

    def get_models(self, backend_id=None):
        backend = get_active_backend(backend_id)
        if not backend:
            return []
        try:
            if backend.kind == 'ollama':
                resp = requests.get(f'{backend.base_url}/api/tags', timeout=5)
                resp.raise_for_status()
                return [m['name'] for m in resp.json().get('models', [])]
            else:
                headers = {}
                if backend.api_key:
                    headers['Authorization'] = f'Bearer {backend.api_key}'
                resp = requests.get(f'{backend.base_url.rstrip("/")}/v1/models', headers=headers, timeout=5)
                resp.raise_for_status()
                return [m.get('id', '') for m in resp.json().get('data', [])]
        except Exception:
            return []


APPS = {}


def load_apps(flask_app, platform):
    """Scan apps/ directory, load manifests, register backends."""
    if not os.path.isdir(APPS_DIR):
        return

    for name in sorted(os.listdir(APPS_DIR)):
        app_dir = os.path.join(APPS_DIR, name)
        manifest_path = os.path.join(app_dir, 'manifest.json')
        if not os.path.isfile(manifest_path):
            continue

        with open(manifest_path) as f:
            manifest = json.load(f)

        app_id = manifest['id']
        APPS[app_id] = manifest

        # Register backend routes
        backend_file = manifest.get('entry', {}).get('backend')
        extra_context = {}
        if backend_file:
            spec = importlib.util.spec_from_file_location(
                f'app_{app_id}', os.path.join(app_dir, backend_file)
            )
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            if hasattr(mod, 'register'):
                mod.register(flask_app, platform)
            if hasattr(mod, 'get_template_context'):
                extra_context = mod.get_template_context()

        # Register page route
        template_file = manifest.get('entry', {}).get('template')
        if template_file:
            template_path = os.path.join(app_dir, template_file)
            page_route = manifest['routes']['page']

            def make_page_view(_tpl=template_path, _ctx=extra_context):
                @login_required
                def app_page_view():
                    with open(_tpl) as tf:
                        from flask import render_template_string
                        return render_template_string(tf.read(), user=current_user, **_ctx)
                return app_page_view

            flask_app.add_url_rule(
                page_route,
                endpoint=f'app_{app_id}_page',
                view_func=make_page_view(),
            )

        # Register static file serving
        static_dir = manifest.get('entry', {}).get('static')
        if static_dir:
            static_path = os.path.join(app_dir, static_dir)
            if os.path.isdir(static_path):
                from flask import send_from_directory

                def make_static_view(_dir=static_path):
                    def serve(filename):
                        return send_from_directory(_dir, filename)
                    return serve

                flask_app.add_url_rule(
                    f'/apps/{app_id}/static/<path:filename>',
                    endpoint=f'app_{app_id}_static',
                    view_func=make_static_view(),
                )

# ─── Personalities ────────────────────────────────────────────────────

PERSONALITIES = {
    'default': {
        'name': 'Default',
        'icon': '🤖',
        'system': 'You are a helpful, friendly AI assistant.',
    },
    'coder': {
        'name': 'Coder',
        'icon': '💻',
        'system': 'You are an expert programmer. Provide clear, well-structured code with explanations. Use markdown code blocks with language tags.',
    },
    'creative': {
        'name': 'Creative Writer',
        'icon': '✍️',
        'system': 'You are a creative writer with a vivid imagination. Write engaging, eloquent prose. Be expressive and original.',
    },
    'tutor': {
        'name': 'Tutor',
        'icon': '📚',
        'system': 'You are a patient, knowledgeable tutor. Explain concepts step by step. Use analogies and examples. Ask the student questions to check understanding.',
    },
    'analyst': {
        'name': 'Analyst',
        'icon': '📊',
        'system': 'You are a data analyst. Be precise, logical, and thorough. Present information in structured formats. Back claims with reasoning.',
    },
    'chef': {
        'name': 'Chef',
        'icon': '👨‍🍳',
        'system': 'You are a professional chef. Provide detailed recipes, cooking tips, and culinary advice. Be enthusiastic about food.',
    },
    'comedian': {
        'name': 'Comedian',
        'icon': '😂',
        'system': 'You are a witty comedian. Be humorous and entertaining while still being helpful. Use clever wordplay and jokes.',
    },
    'philosopher': {
        'name': 'Philosopher',
        'icon': '🧠',
        'system': 'You are a deep thinker and philosopher. Explore ideas from multiple angles. Ask thought-provoking questions. Reference great thinkers when relevant.',
    },
}

# ─── Auth Routes ──────────────────────────────────────────────────────

@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('chat'))
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        if len(username) < 3:
            flash('Username must be at least 3 characters.', 'error')
            return redirect(url_for('register'))
        if len(password) < 4:
            flash('Password must be at least 4 characters.', 'error')
            return redirect(url_for('register'))
        if User.query.filter_by(username=username).first():
            flash('Username already taken.', 'error')
            return redirect(url_for('register'))
        user = User(username=username)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()
        login_user(user)
        return redirect(url_for('chat'))
    return render_template('register.html')


@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('chat'))
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        user = User.query.filter_by(username=username).first()
        if user and user.check_password(password):
            login_user(user, remember=True)
            return redirect(request.args.get('next') or url_for('chat'))
        flash('Invalid username or password.', 'error')
    return render_template('login.html')


@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

# ─── Chat Routes ──────────────────────────────────────────────────────

@app.route('/')
def index():
    if current_user.is_authenticated:
        return redirect(url_for('chat'))
    return redirect(url_for('login'))


@app.route('/chat')
@app.route('/chat/<int:convo_id>')
@login_required
def chat(convo_id=None):
    convos = Conversation.query.filter_by(user_id=current_user.id)\
        .order_by(Conversation.updated_at.desc()).all()
    active_convo = None
    messages = []
    if convo_id:
        active_convo = Conversation.query.filter_by(id=convo_id, user_id=current_user.id).first_or_404()
        messages = active_convo.messages
    return render_template('chat.html',
                           conversations=convos,
                           active_convo=active_convo,
                           messages=messages,
                           personalities=PERSONALITIES,
                           user=current_user)


@app.route('/api/conversations', methods=['POST'])
@login_required
def new_conversation():
    data = request.get_json() or {}
    model = data.get('model', current_user.default_model)
    personality = data.get('personality', current_user.default_personality)
    convo = Conversation(user_id=current_user.id, model=model, personality=personality)
    db.session.add(convo)
    db.session.commit()
    return jsonify({'id': convo.id, 'title': convo.title})


@app.route('/api/conversations/<int:convo_id>', methods=['DELETE'])
@login_required
def delete_conversation(convo_id):
    convo = Conversation.query.filter_by(id=convo_id, user_id=current_user.id).first_or_404()
    db.session.delete(convo)
    db.session.commit()
    return jsonify({'ok': True})


@app.route('/api/conversations/<int:convo_id>/title', methods=['PUT'])
@login_required
def rename_conversation(convo_id):
    convo = Conversation.query.filter_by(id=convo_id, user_id=current_user.id).first_or_404()
    data = request.get_json() or {}
    convo.title = data.get('title', convo.title)[:200]
    db.session.commit()
    return jsonify({'ok': True})

# ─── Backend helpers ──────────────────────────────────────────────────

def get_active_backend(backend_id=None):
    """Get a specific backend or the user's default."""
    if backend_id:
        return Backend.query.filter_by(id=backend_id, user_id=current_user.id).first()
    b = Backend.query.filter_by(user_id=current_user.id, is_default=True).first()
    if not b:
        b = Backend.query.filter_by(user_id=current_user.id).first()
    if not b:
        # Auto-create default Ollama backend
        b = Backend(user_id=current_user.id, name='Ollama', kind='ollama',
                    base_url=OLLAMA_BASE, is_default=True)
        db.session.add(b)
        db.session.commit()
    return b


def strip_think_tags(streamer):
    """Filter out <think>...</think> blocks from streamed tokens (e.g. qwen3)."""
    in_think = False
    buf = ''
    for token, done in streamer:
        if done:
            # Flush any non-think buffered content
            if buf and not in_think:
                yield buf, False
            yield '', True
            return
        buf += token
        while buf:
            if in_think:
                end = buf.find('</think>')
                if end == -1:
                    buf = ''  # discard think content, wait for closing tag
                    break
                buf = buf[end + 8:]  # skip past </think>
                in_think = False
            else:
                start = buf.find('<think>')
                if start == -1:
                    # Check if buf ends with partial '<think' match
                    partial = False
                    for i in range(1, min(len(buf), 7) + 1):
                        if '<think>'.startswith(buf[-i:]):
                            partial = True
                            if len(buf) > i:
                                yield buf[:-i], False
                            buf = buf[-i:]
                            break
                    if not partial:
                        yield buf, False
                        buf = ''
                    break
                else:
                    if start > 0:
                        yield buf[:start], False
                    buf = buf[start + 7:]  # skip past <think>
                    in_think = True


def stream_ollama(backend, model, messages):
    """Stream from Ollama API."""
    resp = requests.post(f'{backend.base_url}/api/chat', json={
        'model': model, 'messages': messages, 'stream': True,
    }, stream=True, timeout=120)
    resp.raise_for_status()
    def raw():
        for line in resp.iter_lines():
            if line:
                chunk = json.loads(line)
                token = chunk.get('message', {}).get('content', '')
                done = chunk.get('done', False)
                yield token, done
    yield from strip_think_tags(raw())


def stream_openai_compat(backend, model, messages):
    """Stream from any OpenAI-compatible API (LM Studio, llama.cpp, vLLM, OpenAI, etc.)."""
    headers = {'Content-Type': 'application/json'}
    if backend.api_key:
        headers['Authorization'] = f'Bearer {backend.api_key}'
    base = backend.base_url.rstrip('/')
    resp = requests.post(f'{base}/v1/chat/completions', json={
        'model': model, 'messages': messages, 'stream': True,
    }, headers=headers, stream=True, timeout=120)
    resp.raise_for_status()
    for line in resp.iter_lines():
        if line:
            text = line.decode('utf-8', errors='ignore')
            if text.startswith('data: '):
                payload = text[6:]
                if payload.strip() == '[DONE]':
                    yield '', True
                    return
                chunk = json.loads(payload)
                delta = chunk.get('choices', [{}])[0].get('delta', {})
                token = delta.get('content', '')
                yield token, False


# ─── Backend CRUD ─────────────────────────────────────────────────────

@app.route('/api/backends')
@login_required
def list_backends():
    backends = Backend.query.filter_by(user_id=current_user.id).order_by(Backend.created_at).all()
    if not backends:
        get_active_backend()  # auto-create default
        backends = Backend.query.filter_by(user_id=current_user.id).all()
    return jsonify({'backends': [{
        'id': b.id, 'name': b.name, 'kind': b.kind,
        'base_url': b.base_url, 'has_key': bool(b.api_key),
        'is_default': b.is_default,
    } for b in backends], 'kinds': list(Backend.KIND_DEFAULTS.keys())})


@app.route('/api/backends', methods=['POST'])
@login_required
def add_backend():
    data = request.get_json() or {}
    kind = data.get('kind', 'custom')
    defaults = Backend.KIND_DEFAULTS.get(kind, Backend.KIND_DEFAULTS['custom'])
    b = Backend(
        user_id=current_user.id,
        name=data.get('name', defaults['name']),
        kind=kind,
        base_url=data.get('base_url', defaults['url']),
        api_key=data.get('api_key', ''),
    )
    # If first backend, make it default
    if not Backend.query.filter_by(user_id=current_user.id).first():
        b.is_default = True
    db.session.add(b)
    db.session.commit()
    return jsonify({'id': b.id, 'name': b.name})


@app.route('/api/backends/<int:bid>', methods=['PUT'])
@login_required
def update_backend(bid):
    b = Backend.query.filter_by(id=bid, user_id=current_user.id).first_or_404()
    data = request.get_json() or {}
    if 'name' in data: b.name = data['name']
    if 'base_url' in data: b.base_url = data['base_url']
    if 'api_key' in data: b.api_key = data['api_key']
    if data.get('is_default'):
        Backend.query.filter_by(user_id=current_user.id).update({'is_default': False})
        b.is_default = True
    db.session.commit()
    return jsonify({'ok': True})


@app.route('/api/backends/<int:bid>', methods=['DELETE'])
@login_required
def delete_backend(bid):
    b = Backend.query.filter_by(id=bid, user_id=current_user.id).first_or_404()
    was_default = b.is_default
    db.session.delete(b)
    db.session.commit()
    if was_default:
        first = Backend.query.filter_by(user_id=current_user.id).first()
        if first:
            first.is_default = True
            db.session.commit()
    return jsonify({'ok': True})


@app.route('/api/backends/<int:bid>/test')
@login_required
def test_backend(bid):
    b = Backend.query.filter_by(id=bid, user_id=current_user.id).first_or_404()
    try:
        if b.kind == 'ollama':
            resp = requests.get(f'{b.base_url}/api/tags', timeout=5)
        else:
            headers = {}
            if b.api_key:
                headers['Authorization'] = f'Bearer {b.api_key}'
            resp = requests.get(f'{b.base_url.rstrip("/")}/v1/models', headers=headers, timeout=5)
        resp.raise_for_status()
        return jsonify({'ok': True, 'status': 'connected'})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)})


# ─── Web Search ───────────────────────────────────────────────────────

def web_search(query, num_results=5):
    """Search DuckDuckGo and return results."""
    try:
        resp = requests.get('https://html.duckduckgo.com/html/', params={'q': query}, headers={
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
        }, timeout=10)
        resp.raise_for_status()
        results = []
        # Parse results from HTML
        from html.parser import HTMLParser
        class DDGParser(HTMLParser):
            def __init__(self):
                super().__init__()
                self.in_result = False
                self.in_title = False
                self.in_snippet = False
                self.current = {}
                self.results = []
            def handle_starttag(self, tag, attrs):
                attrs_d = dict(attrs)
                cls = attrs_d.get('class', '')
                if tag == 'a' and 'result__a' in cls:
                    self.in_title = True
                    href = attrs_d.get('href', '')
                    # DDG wraps URLs
                    if 'uddg=' in href:
                        from urllib.parse import unquote, parse_qs, urlparse
                        parsed = parse_qs(urlparse(href).query)
                        href = parsed.get('uddg', [href])[0]
                    self.current = {'title': '', 'url': href, 'snippet': ''}
                elif tag == 'a' and 'result__snippet' in cls:
                    self.in_snippet = True
            def handle_endtag(self, tag):
                if tag == 'a' and self.in_title:
                    self.in_title = False
                elif tag == 'a' and self.in_snippet:
                    self.in_snippet = False
                    if self.current.get('title'):
                        self.results.append(self.current)
                    self.current = {}
            def handle_data(self, data):
                if self.in_title:
                    self.current['title'] += data
                elif self.in_snippet:
                    self.current['snippet'] += data
        parser = DDGParser()
        parser.feed(resp.text)
        return parser.results[:num_results]
    except Exception as e:
        return [{'title': 'Search error', 'url': '', 'snippet': str(e)}]


def fetch_page_text(url, max_chars=3000):
    """Fetch a page and extract text content."""
    try:
        resp = requests.get(url, headers={
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
        }, timeout=8)
        resp.raise_for_status()
        # Strip HTML tags
        text = re.sub(r'<script[^>]*>.*?</script>', '', resp.text, flags=re.DOTALL)
        text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'\s+', ' ', text).strip()
        return text[:max_chars]
    except:
        return ''


@app.route('/api/web/search')
@login_required
def api_web_search():
    q = request.args.get('q', '').strip()
    if not q:
        return jsonify({'results': []})
    results = web_search(q)
    return jsonify({'results': results})


# ─── Chat / Streaming ────────────────────────────────────────────────

THINK_SYSTEM = """Think through this step-by-step before answering. Show your reasoning process clearly.
Structure your response as:
<think>
[Your detailed reasoning, analysis, and thought process here]
</think>

[Your final, clear answer here]"""

SEARCH_SYSTEM = """You have access to web search results. Use them to provide accurate, up-to-date answers.
Always cite your sources. If the search results don't contain the answer, say so and answer from your own knowledge."""

IMAGE_SYSTEM = """You can generate images. When the user asks you to draw, paint, create, or generate an image, include exactly one [IMG: detailed prompt] tag in your response. Write a descriptive Stable Diffusion prompt inside the tag with quality keywords. Example: Here's your image!\n[IMG: a fluffy orange cat sitting on a windowsill, golden hour lighting, detailed fur, photorealistic, 8k]\nHope you like it!"""


@app.route('/api/chat', methods=['POST'])
@login_required
def api_chat():
    data = request.get_json()
    convo_id = data.get('conversation_id')
    user_msg = data.get('message', '').strip()
    model = data.get('model', current_user.default_model)
    personality_key = data.get('personality', 'default')
    backend_id = data.get('backend_id')
    search_enabled = data.get('search', False)
    think_enabled = data.get('think', False)

    if not user_msg:
        return jsonify({'error': 'Empty message'}), 400

    backend = get_active_backend(backend_id)
    if not backend:
        return jsonify({'error': 'No backend configured'}), 400

    # Get or create conversation
    if convo_id:
        convo = Conversation.query.filter_by(id=convo_id, user_id=current_user.id).first_or_404()
    else:
        convo = Conversation(user_id=current_user.id, model=model, personality=personality_key)
        db.session.add(convo)
        db.session.commit()

    if not convo.messages:
        convo.title = user_msg[:80] + ('...' if len(user_msg) > 80 else '')
    convo.model = model

    msg = Message(conversation_id=convo.id, role='user', content=user_msg)
    db.session.add(msg)
    db.session.commit()

    personality = PERSONALITIES.get(personality_key, PERSONALITIES['default'])
    system_parts = [personality['system']]
    if think_enabled:
        system_parts.append(THINK_SYSTEM)
    if search_enabled:
        system_parts.append(SEARCH_SYSTEM)
    system_parts.append(IMAGE_SYSTEM)

    chat_messages = [{'role': 'system', 'content': '\n\n'.join(system_parts)}]
    for m in convo.messages:
        if m.role in ('user', 'assistant'):
            chat_messages.append({'role': m.role, 'content': m.content})

    def generate():
        full_response = []
        search_results = []

        # Web search if enabled
        if search_enabled:
            yield f"data: {json.dumps({'status': 'searching'})}\n\n"
            search_results = web_search(user_msg, num_results=5)
            yield f"data: {json.dumps({'search_results': search_results})}\n\n"

            # Fetch top 2 page contents for deeper context
            page_texts = []
            for r in search_results[:2]:
                if r.get('url'):
                    yield f"data: {json.dumps({'status': 'reading', 'url': r['url']})}\n\n"
                    text = fetch_page_text(r['url'])
                    if text:
                        page_texts.append(f"[{r['title']}]({r['url']})\n{text}")

            # Inject search context into messages
            search_context = "## Web Search Results\n\n"
            for i, r in enumerate(search_results, 1):
                search_context += f"{i}. **{r['title']}**\n   {r['snippet']}\n   {r['url']}\n\n"
            if page_texts:
                search_context += "## Page Contents\n\n" + "\n\n---\n\n".join(page_texts)

            chat_messages.append({'role': 'user', 'content': f"{search_context}\n\n---\n\nBased on the above search results, answer: {user_msg}"})
            # Remove the duplicate plain user message (last user msg in history is the plain one)
            # The search-augmented one replaces it
            if len(chat_messages) >= 2 and chat_messages[-2].get('role') == 'user' and chat_messages[-2].get('content') == user_msg:
                chat_messages.pop(-2)

            yield f"data: {json.dumps({'status': 'generating'})}\n\n"

        try:
            # Stream LLM response
            if backend.kind == 'ollama':
                streamer = stream_ollama(backend, model, chat_messages)
            else:
                streamer = stream_openai_compat(backend, model, chat_messages)

            for token, done in streamer:
                if token:
                    full_response.append(token)
                    yield f"data: {json.dumps({'token': token, 'conversation_id': convo.id})}\n\n"
                if done:
                    break

            assistant_text = ''.join(full_response)

            # Check for [IMG: ...] tags — AI decided to generate an image
            img_matches = re.findall(r'\[IMG:\s*(.+?)\]', assistant_text)
            images_out = []
            if img_matches:
                yield f"data: {json.dumps({'status': 'generating_image'})}\n\n"
                for sd_prompt in img_matches:
                    try:
                        sd_resp = requests.post(f'{SD_BASE}/sdapi/v1/txt2img', json={
                            'prompt': sd_prompt,
                            'negative_prompt': 'blurry, low quality, deformed, ugly, disfigured',
                            'width': 512, 'height': 512,
                            'steps': 20, 'cfg_scale': 7.0,
                            'seed': -1, 'sampler_name': 'Euler a',
                        }, timeout=300)
                        sd_resp.raise_for_status()
                        sd_result = sd_resp.json()
                        for img_b64 in sd_result.get('images', []):
                            fname = f'{uuid.uuid4().hex}.png'
                            fpath = os.path.join(IMAGES_DIR, fname)
                            with open(fpath, 'wb') as f:
                                f.write(base64.b64decode(img_b64))
                            info = json.loads(sd_result.get('info', '{}')) if isinstance(sd_result.get('info'), str) else sd_result.get('info', {})
                            actual_seed = info.get('seed', -1)
                            img_record = GeneratedImage(
                                user_id=current_user.id, prompt=sd_prompt,
                                width=512, height=512, steps=20, cfg_scale=7.0,
                                seed=actual_seed, filename=fname,
                            )
                            db.session.add(img_record)
                            db.session.commit()
                            images_out.append({'url': f'/static/images/{fname}', 'seed': actual_seed, 'prompt': sd_prompt})
                    except Exception as img_err:
                        yield f"data: {json.dumps({'status': 'image_error', 'message': str(img_err)})}\n\n"

                if images_out:
                    yield f"data: {json.dumps({'images': images_out})}\n\n"

                # Replace [IMG: ...] with image markdown in saved text
                for img in images_out:
                    assistant_text = re.sub(r'\[IMG:\s*.+?\]', f'![Generated Image]({img["url"]})', assistant_text, count=1)
                # Remove any remaining unprocessed tags
                assistant_text = re.sub(r'\[IMG:\s*.+?\]', '', assistant_text)

            if assistant_text.strip():
                with app.app_context():
                    amsg = Message(conversation_id=convo.id, role='assistant', content=assistant_text)
                    db.session.add(amsg)
                    convo.updated_at = datetime.utcnow()
                    db.session.commit()

            yield f"data: {json.dumps({'done': True, 'conversation_id': convo.id, 'title': convo.title})}\n\n"

        except requests.ConnectionError:
            yield f"data: {json.dumps({'error': f'Cannot connect to {backend.name} at {backend.base_url}'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(stream_with_context(generate()), mimetype='text/event-stream')

# ─── Models ───────────────────────────────────────────────────────────

@app.route('/api/models')
@login_required
def list_models():
    backend_id = request.args.get('backend_id', type=int)
    backend = get_active_backend(backend_id)
    if not backend:
        return jsonify({'models': [], 'error': 'No backend configured'})

    try:
        if backend.kind == 'ollama':
            resp = requests.get(f'{backend.base_url}/api/tags', timeout=5)
            resp.raise_for_status()
            raw = resp.json().get('models', [])
            models = []
            for m in raw:
                size_bytes = m.get('size', 0)
                size_str = f'{size_bytes / 1e9:.1f} GB' if size_bytes > 1e9 else f'{size_bytes / 1e6:.0f} MB'
                models.append({
                    'name': m['name'], 'size': size_str,
                    'family': m.get('details', {}).get('family', ''),
                    'params': m.get('details', {}).get('parameter_size', ''),
                })
            return jsonify({'models': models, 'backend': backend.name, 'kind': backend.kind})
        else:
            headers = {}
            if backend.api_key:
                headers['Authorization'] = f'Bearer {backend.api_key}'
            resp = requests.get(f'{backend.base_url.rstrip("/")}/v1/models', headers=headers, timeout=5)
            resp.raise_for_status()
            raw = resp.json().get('data', [])
            models = [{'name': m.get('id', m.get('name', '')), 'size': '', 'family': '', 'params': ''} for m in raw]
            return jsonify({'models': models, 'backend': backend.name, 'kind': backend.kind})
    except requests.ConnectionError:
        return jsonify({'models': [], 'error': f'{backend.name} not running'}), 200
    except Exception as e:
        return jsonify({'models': [], 'error': str(e)}), 200


@app.route('/api/models/pull', methods=['POST'])
@login_required
def pull_model():
    data = request.get_json() or {}
    model_name = data.get('name', '').strip()
    backend_id = data.get('backend_id', type=int) if isinstance(data.get('backend_id'), int) else None
    backend = get_active_backend(backend_id)

    if not model_name:
        return jsonify({'error': 'No model name provided'}), 400
    if not backend or backend.kind != 'ollama':
        return jsonify({'error': 'Pull is only supported for Ollama backends'}), 400

    def generate():
        try:
            resp = requests.post(f'{backend.base_url}/api/pull', json={
                'name': model_name, 'stream': True
            }, stream=True, timeout=600)
            resp.raise_for_status()
            for line in resp.iter_lines():
                if line:
                    chunk = json.loads(line)
                    status = chunk.get('status', '')
                    total = chunk.get('total', 0)
                    completed = chunk.get('completed', 0)
                    pct = int(completed / total * 100) if total else 0
                    yield f"data: {json.dumps({'status': status, 'percent': pct, 'total': total, 'completed': completed})}\n\n"
                    if 'error' in chunk:
                        yield f"data: {json.dumps({'error': chunk['error']})}\n\n"
                        return
            yield f"data: {json.dumps({'done': True})}\n\n"
        except requests.ConnectionError:
            yield f"data: {json.dumps({'error': 'Cannot connect to Ollama'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(stream_with_context(generate()), mimetype='text/event-stream')


@app.route('/api/models/<path:model_name>', methods=['DELETE'])
@login_required
def delete_model(model_name):
    backend = get_active_backend()
    if not backend or backend.kind != 'ollama':
        return jsonify({'error': 'Delete is only supported for Ollama backends'}), 400
    try:
        resp = requests.delete(f'{backend.base_url}/api/delete', json={'name': model_name}, timeout=30)
        resp.raise_for_status()
        return jsonify({'ok': True})
    except requests.ConnectionError:
        return jsonify({'error': 'Cannot connect to Ollama'}), 502
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ─── Search ───────────────────────────────────────────────────────────

@app.route('/api/search')
@login_required
def search():
    q = request.args.get('q', '').strip()
    if len(q) < 2:
        return jsonify({'results': []})

    # Search conversations and messages
    matching_msgs = Message.query.join(Conversation).filter(
        Conversation.user_id == current_user.id,
        Message.content.ilike(f'%{q}%')
    ).order_by(Message.created_at.desc()).limit(50).all()

    results = []
    seen_convos = set()
    for m in matching_msgs:
        if m.conversation_id not in seen_convos:
            seen_convos.add(m.conversation_id)
            convo = m.conversation
            # Find snippet
            idx = m.content.lower().find(q.lower())
            start = max(0, idx - 40)
            end = min(len(m.content), idx + len(q) + 40)
            snippet = ('...' if start > 0 else '') + m.content[start:end] + ('...' if end < len(m.content) else '')
            results.append({
                'conversation_id': convo.id,
                'title': convo.title,
                'snippet': snippet,
                'role': m.role,
                'date': convo.updated_at.strftime('%b %d, %Y'),
            })

    return jsonify({'results': results})

# ─── Settings ─────────────────────────────────────────────────────────

@app.route('/api/settings', methods=['PUT'])
@login_required
def update_settings():
    data = request.get_json() or {}
    if 'default_model' in data:
        current_user.default_model = data['default_model']
    if 'default_personality' in data:
        current_user.default_personality = data['default_personality']
    db.session.commit()
    return jsonify({'ok': True})

# ─── Apps Hub ─────────────────────────────────────────────────────────

@app.route('/apps')
@login_required
def apps_page():
    return render_template('apps.html', apps=APPS, user=current_user)


# ─── Image Generation ─────────────────────────────────────────────────

import base64
import uuid

IMAGES_DIR = os.path.join(os.path.dirname(__file__), 'static', 'images')
os.makedirs(IMAGES_DIR, exist_ok=True)


@app.route('/imagegen')
@login_required
def imagegen():
    images = GeneratedImage.query.filter_by(user_id=current_user.id)\
        .order_by(GeneratedImage.created_at.desc()).limit(50).all()
    return render_template('imagegen.html', images=images, user=current_user)


@app.route('/api/sd/models')
@login_required
def sd_models():
    try:
        resp = requests.get(f'{SD_BASE}/sdapi/v1/sd-models', timeout=5)
        resp.raise_for_status()
        models = [{'name': m['model_name'], 'title': m['title']} for m in resp.json()]
        return jsonify({'models': models})
    except requests.ConnectionError:
        return jsonify({'models': [], 'error': 'Stable Diffusion server not running.'}), 200
    except Exception as e:
        return jsonify({'models': [], 'error': str(e)}), 200


@app.route('/api/sd/samplers')
@login_required
def sd_samplers():
    try:
        resp = requests.get(f'{SD_BASE}/sdapi/v1/samplers', timeout=5)
        resp.raise_for_status()
        samplers = [s['name'] for s in resp.json()]
        return jsonify({'samplers': samplers})
    except:
        return jsonify({'samplers': ['Euler a', 'DPM++ 2M Karras', 'DDIM']}), 200


@app.route('/api/sd/generate', methods=['POST'])
@login_required
def sd_generate():
    data = request.get_json() or {}
    prompt = data.get('prompt', '').strip()
    if not prompt:
        return jsonify({'error': 'No prompt provided'}), 400

    negative = data.get('negative_prompt', '')
    width = min(int(data.get('width', 512)), 2048)
    height = min(int(data.get('height', 512)), 2048)
    steps = min(int(data.get('steps', 20)), 150)
    cfg = float(data.get('cfg_scale', 7.0))
    seed = int(data.get('seed', -1))
    sampler = data.get('sampler', 'Euler a')
    sd_model = data.get('model', '')

    # Switch model if requested
    if sd_model:
        try:
            requests.post(f'{SD_BASE}/sdapi/v1/options', json={
                'sd_model_checkpoint': sd_model
            }, timeout=120)
        except:
            pass

    try:
        resp = requests.post(f'{SD_BASE}/sdapi/v1/txt2img', json={
            'prompt': prompt,
            'negative_prompt': negative,
            'width': width,
            'height': height,
            'steps': steps,
            'cfg_scale': cfg,
            'seed': seed,
            'sampler_name': sampler,
        }, timeout=300)
        resp.raise_for_status()
        result = resp.json()

        images_out = []
        for i, img_b64 in enumerate(result.get('images', [])):
            fname = f'{uuid.uuid4().hex}.png'
            fpath = os.path.join(IMAGES_DIR, fname)
            with open(fpath, 'wb') as f:
                f.write(base64.b64decode(img_b64))

            info = json.loads(result.get('info', '{}')) if isinstance(result.get('info'), str) else result.get('info', {})
            actual_seed = info.get('seed', seed)

            img_record = GeneratedImage(
                user_id=current_user.id,
                prompt=prompt,
                negative_prompt=negative,
                model=sd_model,
                width=width, height=height,
                steps=steps, cfg_scale=cfg,
                seed=actual_seed,
                filename=fname,
            )
            db.session.add(img_record)
            db.session.commit()

            images_out.append({
                'id': img_record.id,
                'url': f'/static/images/{fname}',
                'seed': actual_seed,
            })

        return jsonify({'images': images_out})

    except requests.ConnectionError:
        return jsonify({'error': 'Cannot connect to Stable Diffusion server.'}), 502
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/sd/images/<int:img_id>', methods=['DELETE'])
@login_required
def delete_image(img_id):
    img = GeneratedImage.query.filter_by(id=img_id, user_id=current_user.id).first_or_404()
    fpath = os.path.join(IMAGES_DIR, img.filename)
    if os.path.exists(fpath):
        os.remove(fpath)
    db.session.delete(img)
    db.session.commit()
    return jsonify({'ok': True})


# ─── Init ─────────────────────────────────────────────────────────────

with app.app_context():
    db.create_all()

# Load apps from apps/ directory
platform = Platform(app)
load_apps(app, platform)

if __name__ == '__main__':
    app.run(debug=True, port=9090)
