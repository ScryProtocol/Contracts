import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8787);
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const DATA_FILE = path.join(__dirname, 'data', 'app-data.json');
const STATIC_DIR = path.join(__dirname, 'public');

const PERSONALITIES = [
  {
    id: 'balanced',
    name: 'Balanced Assistant',
    prompt:
      'You are a practical, concise AI assistant. Answer clearly, include actionable steps, and avoid fluff.',
  },
  {
    id: 'teacher',
    name: 'Teacher',
    prompt:
      'You are a patient teacher. Explain ideas step-by-step with simple examples and short summaries.',
  },
  {
    id: 'coder',
    name: 'Senior Engineer',
    prompt:
      'You are a senior software engineer. Provide robust, production-minded coding guidance and mention tradeoffs.',
  },
  {
    id: 'creative',
    name: 'Creative',
    prompt:
      'You are an imaginative assistant. Offer original ideas while still being useful and grounded.',
  },
];

const sessions = new Map();

function ensureDataFile() {
  if (!fs.existsSync(path.dirname(DATA_FILE))) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  }

  if (!fs.existsSync(DATA_FILE)) {
    const initial = { users: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), 'utf8');
  }
}

function readData() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  return JSON.parse(raw);
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const hash = pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');

  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}

function jsonResponse(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

function getSessionUser(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return null;
  }

  const token = auth.slice('Bearer '.length).trim();
  if (!token) {
    return null;
  }

  const userId = sessions.get(token);
  if (!userId) {
    return null;
  }

  const data = readData();
  return data.users.find((u) => u.id === userId) || null;
}

function generateToken() {
  return randomBytes(24).toString('hex');
}

function toPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
  };
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

function serveStatic(req, res, pathname) {
  let safePath = pathname === '/' ? '/index.html' : pathname;
  safePath = safePath.replace(/\.{2,}/g, '.');
  const filePath = path.join(STATIC_DIR, safePath);

  if (!filePath.startsWith(STATIC_DIR)) {
    jsonResponse(res, 403, { error: 'Forbidden' });
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': getContentType(filePath) });
    res.end(content);
  });
}

async function fetchModels() {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}`);
    }
    const data = await response.json();
    const models = (data.models || []).map((m) => m.name).filter(Boolean);
    return models;
  } catch {
    return ['llama3.2', 'mistral', 'qwen2.5'];
  }
}

async function runSearch(query) {
  if (!query) {
    return [];
  }

  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&skip_disambig=1`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Search request failed');
    }

    const data = await response.json();
    const results = [];

    if (data.AbstractText) {
      results.push({
        title: data.Heading || 'Summary',
        snippet: data.AbstractText,
        url: data.AbstractURL || '',
      });
    }

    for (const topic of data.RelatedTopics || []) {
      if (results.length >= 5) {
        break;
      }

      if (topic.Text && topic.FirstURL) {
        results.push({
          title: topic.Text.split(' - ')[0].slice(0, 120),
          snippet: topic.Text,
          url: topic.FirstURL,
        });
      }

      if (topic.Topics) {
        for (const nested of topic.Topics) {
          if (results.length >= 5) {
            break;
          }
          if (nested.Text && nested.FirstURL) {
            results.push({
              title: nested.Text.split(' - ')[0].slice(0, 120),
              snippet: nested.Text,
              url: nested.FirstURL,
            });
          }
        }
      }
    }

    return results.slice(0, 5);
  } catch {
    return [];
  }
}

async function askModel({ model, personalityPrompt, message, searchResults }) {
  const searchBlock =
    searchResults.length > 0
      ? `\nWeb context (may be imperfect):\n${searchResults
          .map((r, i) => `${i + 1}. ${r.title}\n${r.snippet}\n${r.url}`)
          .join('\n\n')}\nUse this context when relevant, and acknowledge uncertainty.`
      : '';

  const payload = {
    model,
    stream: false,
    messages: [
      {
        role: 'system',
        content: `${personalityPrompt}${searchBlock}`,
      },
      {
        role: 'user',
        content: message,
      },
    ],
  };

  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Ollama chat failed (${response.status})`);
  }

  const data = await response.json();
  return data?.message?.content || 'No response from model.';
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = requestUrl.pathname;

  try {
    if (pathname === '/api/register' && req.method === 'POST') {
      const body = await parseBody(req);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');

      if (username.length < 3 || password.length < 8) {
        jsonResponse(res, 400, { error: 'Username must be 3+ chars and password 8+ chars.' });
        return;
      }

      const data = readData();
      const exists = data.users.some((u) => u.username === username);
      if (exists) {
        jsonResponse(res, 409, { error: 'Username already exists.' });
        return;
      }

      const { salt, hash } = hashPassword(password);
      const user = {
        id: randomBytes(10).toString('hex'),
        username,
        passwordSalt: salt,
        passwordHash: hash,
        createdAt: new Date().toISOString(),
        chats: [],
      };

      data.users.push(user);
      writeData(data);

      jsonResponse(res, 201, { message: 'Registered successfully.' });
      return;
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await parseBody(req);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');

      const data = readData();
      const user = data.users.find((u) => u.username === username);

      if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
        jsonResponse(res, 401, { error: 'Invalid credentials.' });
        return;
      }

      const token = generateToken();
      sessions.set(token, user.id);

      jsonResponse(res, 200, { token, user: toPublicUser(user) });
      return;
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) {
        jsonResponse(res, 401, { error: 'Unauthorized.' });
        return;
      }

      jsonResponse(res, 200, { user: toPublicUser(user) });
      return;
    }

    if (pathname === '/api/personalities' && req.method === 'GET') {
      jsonResponse(res, 200, { personalities: PERSONALITIES.map(({ id, name }) => ({ id, name })) });
      return;
    }

    if (pathname === '/api/models' && req.method === 'GET') {
      const models = await fetchModels();
      jsonResponse(res, 200, { models });
      return;
    }

    if (pathname === '/api/search' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) {
        jsonResponse(res, 401, { error: 'Unauthorized.' });
        return;
      }

      const q = String(requestUrl.searchParams.get('q') || '').trim();
      if (q.length < 2) {
        jsonResponse(res, 400, { error: 'Search query is too short.' });
        return;
      }

      const results = await runSearch(q);
      jsonResponse(res, 200, { results });
      return;
    }

    if (pathname === '/api/history' && req.method === 'GET') {
      const user = getSessionUser(req);
      if (!user) {
        jsonResponse(res, 401, { error: 'Unauthorized.' });
        return;
      }

      const recent = [...(user.chats || [])].slice(-30).reverse();
      jsonResponse(res, 200, { chats: recent });
      return;
    }

    if (pathname === '/api/chat' && req.method === 'POST') {
      const authUser = getSessionUser(req);
      if (!authUser) {
        jsonResponse(res, 401, { error: 'Unauthorized.' });
        return;
      }

      const body = await parseBody(req);
      const message = String(body.message || '').trim();
      const model = String(body.model || '').trim();
      const personalityId = String(body.personalityId || 'balanced').trim();
      const useSearch = Boolean(body.useSearch);

      if (!message) {
        jsonResponse(res, 400, { error: 'Message is required.' });
        return;
      }

      if (!model) {
        jsonResponse(res, 400, { error: 'Model is required.' });
        return;
      }

      const personality = PERSONALITIES.find((p) => p.id === personalityId) || PERSONALITIES[0];
      const searchResults = useSearch ? await runSearch(message) : [];

      let answer;
      try {
        answer = await askModel({
          model,
          personalityPrompt: personality.prompt,
          message,
          searchResults,
        });
      } catch (error) {
        jsonResponse(res, 502, {
          error: `Model request failed. Ensure Ollama is running and model '${model}' is installed.`,
          details: error.message,
        });
        return;
      }

      const data = readData();
      const dbUser = data.users.find((u) => u.id === authUser.id);
      if (!dbUser) {
        jsonResponse(res, 401, { error: 'Unauthorized.' });
        return;
      }

      const chat = {
        id: randomBytes(8).toString('hex'),
        createdAt: new Date().toISOString(),
        model,
        personalityId: personality.id,
        useSearch,
        message,
        answer,
        searchResults,
      };

      dbUser.chats = dbUser.chats || [];
      dbUser.chats.push(chat);
      writeData(data);

      jsonResponse(res, 200, { reply: answer, chat });
      return;
    }

    if (pathname.startsWith('/api/')) {
      jsonResponse(res, 404, { error: 'API route not found.' });
      return;
    }

    serveStatic(req, res, pathname);
  } catch (error) {
    jsonResponse(res, 500, { error: 'Server error.', details: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Local AI Box running on http://localhost:${PORT}`);
  console.log(`Ollama endpoint: ${OLLAMA_URL}`);
});
