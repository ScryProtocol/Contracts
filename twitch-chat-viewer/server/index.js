require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const tmi = require('tmi.js');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

let accessToken = null;
let tokenExpiresAt = null;

// User tokens storage (in production, use a proper session store)
const userTokens = new Map();
const REFRESH_GRACE_MS = 60000;

function getTokenExpiryTimestamp(expiresInSeconds) {
  if (!expiresInSeconds) {
    return null;
  }
  return Date.now() + expiresInSeconds * 1000 - REFRESH_GRACE_MS;
}

async function refreshUserAccessToken(sessionId) {
  const session = userTokens.get(sessionId);
  if (!session || !session.refreshToken) {
    return null;
  }

  try {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
      },
    });

    const { access_token, refresh_token, expires_in } = response.data;
    const updatedSession = {
      ...session,
      token: access_token,
      refreshToken: refresh_token || session.refreshToken,
      tokenExpiresAt: getTokenExpiryTimestamp(expires_in),
    };
    userTokens.set(sessionId, updatedSession);
    console.log(`🔄 Refreshed Twitch token for ${session.user.login}`);
    return updatedSession.token;
  } catch (err) {
    console.error('Failed to refresh user token:', err.response?.data || err.message);
    return null;
  }
}

async function ensureUserAccessToken(sessionId) {
  const session = userTokens.get(sessionId);
  if (!session) {
    return null;
  }

  if (session.tokenExpiresAt && Date.now() > session.tokenExpiresAt) {
    return refreshUserAccessToken(sessionId);
  }

  return session.token;
}

// Chat monitoring
const chatClients = new Map();
const chatMetrics = new Map();

// Visitor tracking - Map of visitorId -> { lastSeen, stream, watchTimeMs }
const activeConnections = new Map();
const allTimeVisitors = new Set(); // Track unique visitor IDs ever seen
const twitchLogins = new Set(); // Track Twitch usernames that have logged in
const userWatchTime = {}; // visitorId -> total watch time in ms
let peakConnections = 0;
const STALE_TIMEOUT = 60000; // 1 minute without heartbeat = stale
const STATS_FILE = './visitor-stats.json';
const LISTS_FILE = './custom-lists.json';
const WATCHTIME_FILE = './watch-time.json';

// Custom lists storage: { handle: { twitchId, twitchLogin, streams: [...], createdAt } }
let customLists = {};

// Curated recommendation list (fallback only; primary source is custom-lists.json)
const DEFAULT_REC_STREAMERS = [
  'quin69', 'summit1g', 'robcdee', 'day9tv', 'anniefuchsia', 'willneff',
  'hasanabi', 'nmplol', 'trainwreckstv', 'zackrawrr', 'nl_kripp', 'forsen',
  'cohhcarnage', 'bikeman', 'itmejp', 'sodapoppin', 'towelliee', 'lirik',
  'xqc', 'maya'
];

// Load saved stats on startup
function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
      data.visitors?.forEach(v => allTimeVisitors.add(v));
      data.twitchLogins?.forEach(u => twitchLogins.add(u));
      peakConnections = data.peak || 0;
      console.log(`📊 Loaded stats: ${allTimeVisitors.size} unique visitors, peak ${peakConnections}, ${twitchLogins.size} twitch logins`);
    }
    if (fs.existsSync(LISTS_FILE)) {
      customLists = JSON.parse(fs.readFileSync(LISTS_FILE, 'utf8'));
      console.log(`📋 Loaded ${Object.keys(customLists).length} custom lists`);
    }
    if (fs.existsSync(WATCHTIME_FILE)) {
      const data = JSON.parse(fs.readFileSync(WATCHTIME_FILE, 'utf8'));
      Object.assign(userWatchTime, data);
      console.log(`⏱️ Loaded watch time for ${Object.keys(userWatchTime).length} users`);
    }
  } catch (err) {
    console.error('Failed to load stats:', err.message);
  }
}

// Save stats to disk
function saveStats() {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify({
      visitors: [...allTimeVisitors],
      twitchLogins: [...twitchLogins],
      peak: peakConnections
    }));
    fs.writeFileSync(WATCHTIME_FILE, JSON.stringify(userWatchTime));
  } catch (err) {
    console.error('Failed to save stats:', err.message);
  }
}

// Save custom lists to disk
function saveLists() {
  try {
    fs.writeFileSync(LISTS_FILE, JSON.stringify(customLists));
  } catch (err) {
    console.error('Failed to save lists:', err.message);
  }
}

loadStats();

// Save stats every 5 minutes
setInterval(saveStats, 5 * 60 * 1000);

// Clean up stale connections every 10 seconds
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  activeConnections.forEach((data, visitorId) => {
    if (now - data.lastSeen > STALE_TIMEOUT) {
      activeConnections.delete(visitorId);
      removed++;
    }
  });
  if (removed > 0) {
    console.log(`🧹 Cleaned ${removed} stale connections (Active: ${activeConnections.size})`);
  }
}, 10000);

// Get OAuth token from Twitch
async function getAccessToken() {
  if (accessToken && tokenExpiresAt && Date.now() < tokenExpiresAt) {
    return accessToken;
  }

  try {
    const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: 'client_credentials',
      },
    });

    accessToken = response.data.access_token;
    tokenExpiresAt = Date.now() + (response.data.expires_in * 1000) - 60000; // Refresh 1 min before expiry

    console.log('✅ Obtained new Twitch access token');
    return accessToken;
  } catch (error) {
    console.error('❌ Error getting access token:', error.response?.data || error.message);
    throw error;
  }
}

// Fetch top streams from Twitch
async function getTopStreams(limit = 100, language = null, gameId = null) {
  console.log(`🔍 Fetching streams: limit=${limit}, lang=${language}, game=${gameId}`);
  const token = await getAccessToken();
  const streams = [];
  let cursor = null;

  while (streams.length < limit) {
    try {
      const params = {
        first: Math.min(100, limit - streams.length),
      };

      if (cursor) {
        params.after = cursor;
      }

      // Filter by language if specified
      if (language && language !== 'all') {
        params.language = language;
      }

      // Filter by game/category if specified
      if (gameId) {
        params.game_id = gameId;
      }

      console.log(`  ➡️ Requesting page: first=${params.first}, cursor=${cursor ? 'yes' : 'no'}`);
      const response = await axios.get('https://api.twitch.tv/helix/streams', {
        headers: {
          'Client-ID': process.env.TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${token}`,
        },
        params,
      });

      console.log(`  ⬅️ Got ${response.data.data.length} streams`);
      streams.push(...response.data.data);
      cursor = response.data.pagination.cursor;

      if (!cursor || response.data.data.length === 0) {
        console.log('  🛑 No more pages or cursor');
        break;
      }
    } catch (error) {
      console.error('Error fetching streams:', error.response?.data || error.message);
      break;
    }
  }

  console.log(`✅ Returning ${streams.length} streams`);
  return streams.slice(0, limit);
}

// Search games/categories by name (Twitch Helix: /search/categories)
async function searchCategories(query, first = 20, after = null) {
  const token = await getAccessToken();

  const params = {
    query,
    first: Math.min(Math.max(parseInt(first) || 20, 1), 100),
  };
  if (after) {
    params.after = after;
  }

  const response = await axios.get('https://api.twitch.tv/helix/search/categories', {
    headers: {
      'Client-ID': process.env.TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`,
    },
    params,
  });

  return response.data;
}

// Start monitoring a channel's chat
function startChatMonitoring(channelName) {
  if (chatClients.has(channelName)) {
    return;
  }

  const client = new tmi.Client({
    connection: {
      secure: true,
      reconnect: true,
    },
    channels: [channelName],
  });

  chatMetrics.set(channelName, {
    messageCount: 0,
    chatRate: 0,
    lastUpdate: Date.now(),
  });

  client.on('message', () => {
    const metric = chatMetrics.get(channelName);
    if (metric) {
      metric.messageCount++;
    }
  });

  client.connect().catch(err => {
    console.error(`Error connecting to ${channelName}:`, err.message);
  });

  chatClients.set(channelName, client);

  // Calculate chat rate every 5 seconds
  const interval = setInterval(() => {
    const metric = chatMetrics.get(channelName);
    if (!metric) return;

    const now = Date.now();
    const timeDiff = (now - metric.lastUpdate) / 1000;

    if (timeDiff > 0) {
      metric.chatRate = metric.messageCount / timeDiff;
      metric.messageCount = 0;
      metric.lastUpdate = now;
    }
  }, 5000);

  chatMetrics.get(channelName).interval = interval;
}

// Stop monitoring a channel
function stopChatMonitoring(channelName) {
  const client = chatClients.get(channelName);
  if (client) {
    client.disconnect();
    chatClients.delete(channelName);
  }

  const metric = chatMetrics.get(channelName);
  if (metric && metric.interval) {
    clearInterval(metric.interval);
  }

  chatMetrics.delete(channelName);
}

// API Routes
app.get('/api/streams', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const language = req.query.language || null;
    const gameId = req.query.gameId || req.query.game_id || null;
    const streams = await getTopStreams(limit, language, gameId);

    // Start monitoring chats for all streams
    streams.forEach(stream => {
      startChatMonitoring(stream.user_login);
    });

    res.json(streams);
  } catch (error) {
    console.error('Error in /api/streams:', error);
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
});

// Search categories (games) for the Top 100 game filter UI
app.get('/api/search/categories', async (req, res) => {
  try {
    const query = (req.query.query || '').toString();
    if (!query.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }

    const first = req.query.first;
    const after = req.query.after || null;
    const data = await searchCategories(query, first, after);
    res.json(data);
  } catch (error) {
    console.error('Error in /api/search/categories:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to search categories' });
  }
});

app.get('/api/chat-metrics', (req, res) => {
  const metrics = {};
  chatMetrics.forEach((value, key) => {
    metrics[key] = {
      chatRate: value.chatRate,
      messageCount: value.messageCount,
    };
  });
  res.json(metrics);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    monitoringChannels: chatClients.size,
    hasToken: !!accessToken,
  });
});

// Track visitor connection (also serves as heartbeat)
app.post('/api/connect', (req, res) => {
  const visitorId = req.body.visitorId || Math.random().toString(36).substring(7);
  const stream = req.body.stream || null;
  const existing = activeConnections.get(visitorId);
  const isNew = !existing;
  const now = Date.now();

  // Calculate watch time since last heartbeat
  if (existing && existing.lastSeen) {
    const elapsed = now - existing.lastSeen;
    if (elapsed < STALE_TIMEOUT * 2) { // Only count if reasonable time
      userWatchTime[visitorId] = (userWatchTime[visitorId] || 0) + elapsed;
    }
  }

  // Update connection info
  activeConnections.set(visitorId, { lastSeen: now, stream });

  // Track unique visitors (Set automatically handles duplicates)
  allTimeVisitors.add(visitorId);

  if (isNew) {
    if (activeConnections.size > peakConnections) {
      peakConnections = activeConnections.size;
    }
    console.log(`👤 New visitor: ${visitorId} (Active: ${activeConnections.size}, Total unique: ${allTimeVisitors.size})`);
  }

  const watchTimeSec = Math.floor((userWatchTime[visitorId] || 0) / 1000);
  res.json({ visitorId, active: activeConnections.size, total: allTimeVisitors.size, peak: peakConnections, watchTime: watchTimeSec });
});

// Track visitor disconnect
app.post('/api/disconnect', (req, res) => {
  const { visitorId } = req.body;
  if (visitorId && activeConnections.has(visitorId)) {
    activeConnections.delete(visitorId);
    console.log(`👋 Visitor left: ${visitorId} (Active: ${activeConnections.size})`);
  }
  res.json({ success: true });
});

// Get stats
// Format seconds as human-readable string (e.g., "3m 30s" or "1h 5m")
function formatWatchTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

app.get('/api/stats', (req, res) => {
  // Build list of all users (active + historical)
  const allUsers = [];
  
  // Get all known visitor IDs
  const allVisitorIds = new Set([...allTimeVisitors, ...Object.keys(userWatchTime)]);
  
  allVisitorIds.forEach(visitorId => {
    const isActive = activeConnections.has(visitorId);
    const activeData = activeConnections.get(visitorId);
    const watchTimeMs = userWatchTime[visitorId] || 0;
    const watchTimeSec = Math.floor(watchTimeMs / 1000);
    
    allUsers.push({
      id: visitorId,
      stream: isActive ? activeData.stream : null,
      watchTime: watchTimeSec,
      watchTimeFormatted: formatWatchTime(watchTimeSec),
      active: isActive
    });
  });

  res.json({
    activeUsers: activeConnections.size,
    totalVisitors: allTimeVisitors.size,
    twitchLogins: [...twitchLogins],
    peakConnections,
    monitoringChannels: chatClients.size,
    allUsers
  });
});

// Custom lists API

// Get a custom list by handle
app.get('/api/list/:handle', (req, res) => {
  const handle = req.params.handle.toLowerCase();
  const list = customLists[handle];
  if (!list) {
    return res.status(404).json({ error: 'List not found' });
  }
  res.json(list);
});

// Check if handle is available
app.get('/api/list-available/:handle', (req, res) => {
  const handle = req.params.handle.toLowerCase();
  const available = !customLists[handle];
  res.json({ available, handle });
});

// Save/update a custom list (requires Twitch session)
app.post('/api/list', (req, res) => {
  const { sessionId, handle, streams } = req.body;

  // Validate session
  if (!sessionId || !userTokens.has(sessionId)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = userTokens.get(sessionId);
  const twitchId = session.user.id;
  const twitchLogin = session.user.login;

  // Validate handle
  const cleanHandle = handle?.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!cleanHandle || cleanHandle.length < 2 || cleanHandle.length > 20) {
    return res.status(400).json({ error: 'Handle must be 2-20 alphanumeric characters' });
  }

  // Check if handle is taken by someone else
  const existing = customLists[cleanHandle];
  if (existing && existing.twitchId !== twitchId) {
    return res.status(409).json({ error: 'Handle already taken' });
  }

  // Validate streams array
  if (!Array.isArray(streams) || streams.length === 0) {
    return res.status(400).json({ error: 'Streams list required' });
  }

  // Remove old handle if user is changing it
  for (const [h, list] of Object.entries(customLists)) {
    if (list.twitchId === twitchId && h !== cleanHandle) {
      delete customLists[h];
      console.log(`📋 Removed old handle @${h} for ${twitchLogin}`);
    }
  }

  // Save the list
  customLists[cleanHandle] = {
    twitchId,
    twitchLogin,
    streams: streams.slice(0, 50), // Max 50 streams
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now()
  };

  saveLists();
  console.log(`📋 Saved list @${cleanHandle} by ${twitchLogin} (${streams.length} streams)`);

  res.json({ success: true, handle: cleanHandle });
});

// Get user's own list handle
app.get('/api/my-list', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId || !userTokens.has(sessionId)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = userTokens.get(sessionId);
  const twitchId = session.user.id;

  // Find user's list
  for (const [handle, list] of Object.entries(customLists)) {
    if (list.twitchId === twitchId) {
      return res.json({ handle, ...list });
    }
  }

  res.json({ handle: null });
});

// Twitch OAuth routes
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const API_BASE_URL = process.env.API_BASE_URL || `http://localhost:${PORT}`;

// Get OAuth URL for login
app.get('/api/auth/twitch', (req, res) => {
  const redirectUri = `${API_BASE_URL}/api/auth/callback`;
  const scopes = 'user:read:follows';

  const authUrl = `https://id.twitch.tv/oauth2/authorize?` +
    `client_id=${process.env.TWITCH_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scopes)}`;

  res.json({ url: authUrl });
});

// OAuth callback
app.get('/api/auth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect(`${FRONTEND_URL}?error=no_code`);
  }

  try {
    const redirectUri = `${API_BASE_URL}/api/auth/callback`;

    // Exchange code for token
    const tokenResponse = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      },
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    // Get user info
    const userResponse = await axios.get('https://api.twitch.tv/helix/users', {
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${access_token}`,
      },
    });

    const user = userResponse.data.data[0];

    // Track Twitch login
    const isNew = !twitchLogins.has(user.login);
    twitchLogins.add(user.login);
    console.log(`🎮 Twitch login: ${user.login}${isNew ? ' (NEW)' : ''} (Total: ${twitchLogins.size})`);

    // Store token (in production, use sessions)
    const sessionId = Math.random().toString(36).substring(7);
    userTokens.set(sessionId, {
      token: access_token,
      refreshToken: refresh_token,
      tokenExpiresAt: getTokenExpiryTimestamp(expires_in),
      user: {
        id: user.id,
        login: user.login,
        display_name: user.display_name,
        profile_image_url: user.profile_image_url,
      },
    });

    // Redirect back to frontend with session
    res.redirect(`${FRONTEND_URL}?session=${sessionId}`);
  } catch (error) {
    console.error('OAuth callback error:', error.response?.data || error.message);
    res.redirect(`${FRONTEND_URL}?error=auth_failed`);
  }
});

// Get user from session
app.get('/api/auth/user', (req, res) => {
  const sessionId = req.query.session;

  if (!sessionId || !userTokens.has(sessionId)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = userTokens.get(sessionId);
  res.json({ user: session.user });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  const sessionId = req.query.session;

  if (sessionId) {
    userTokens.delete(sessionId);
  }

  res.json({ success: true });
});

// Get recommended streams (curated list)
app.get('/api/recommended-streams', async (req, res) => {
  try {
    const token = await getAccessToken();
    const handle = (req.query.list || 'rec').toString().toLowerCase();
    const language = req.query.language && req.query.language !== 'all'
      ? req.query.language.toString().toLowerCase()
      : null;
    const list = customLists[handle];
    const baseLogins = Array.isArray(list?.streams) && list.streams.length > 0
      ? list.streams
      : DEFAULT_REC_STREAMERS;

    // Build query string for specific users
    const queryParams = new URLSearchParams();
    [...new Set(baseLogins.map(login => login.toLowerCase()))].slice(0, 100).forEach(login => {
      queryParams.append('user_login', login);
    });
    
    const response = await axios.get(`https://api.twitch.tv/helix/streams?${queryParams.toString()}`, {
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`,
      },
    });

    let streams = response.data.data;

    if (language) {
      streams = streams.filter(stream => stream.language?.toLowerCase() === language);
    }

    // Start monitoring chats for recommended streams
    streams.forEach(stream => {
      startChatMonitoring(stream.user_login);
    });

    res.json(streams);
  } catch (error) {
    console.error('Error fetching recommended streams:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch recommended streams' });
  }
});

// Get followed streams (live only)
app.get('/api/followed-streams', async (req, res) => {
  const sessionId = req.query.session;

  if (!sessionId || !userTokens.has(sessionId)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = userTokens.get(sessionId);
  const token = await ensureUserAccessToken(sessionId);

  if (!token) {
    userTokens.delete(sessionId);
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const fetchFollowed = async bearer => axios.get('https://api.twitch.tv/helix/streams/followed', {
      headers: {
        'Client-ID': process.env.TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${bearer}`,
      },
      params: {
        user_id: session.user.id,
        first: 100,
      },
    });

    let response;

    try {
      response = await fetchFollowed(token);
    } catch (error) {
      const status = error.response?.status;
      if (status === 401 && session.refreshToken) {
        const refreshedToken = await refreshUserAccessToken(sessionId);
        if (!refreshedToken) {
          userTokens.delete(sessionId);
          return res.status(401).json({ error: 'Not authenticated' });
        }
        response = await fetchFollowed(refreshedToken);
      } else {
        throw error;
      }
    }

    const streams = response.data.data;

    // Start monitoring chats for followed streams
    streams.forEach(stream => {
      startChatMonitoring(stream.user_login);
    });

    res.json(streams);
  } catch (error) {
    console.error('Error fetching followed streams:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch followed streams' });
  }
});

// ============================================================
// Watch Party: co-viewing of Twitch VODs/clips with shared chat
// ============================================================
const parties = new Map(); // roomId -> party
const PARTY_IDLE_MS = 60 * 60 * 1000; // 1h no activity
const PARTY_MAX_MESSAGES = 500;

function makeId(len = 8) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function sanitizeNick(raw) {
  const s = (raw || '').toString().trim().slice(0, 24);
  return s.replace(/[\u0000-\u001f\u007f]/g, '') || 'guest';
}

function touchParty(party) {
  party.lastActivity = Date.now();
}

function participantsPublic(party) {
  const now = Date.now();
  return [...party.participants.values()]
    .filter(p => now - p.lastSeen < 45000)
    .map(p => ({ nick: p.nick, pid: p.pid, host: p.pid === party.hostPid }));
}

// Reap idle parties
setInterval(() => {
  const now = Date.now();
  parties.forEach((p, id) => {
    if (now - p.lastActivity > PARTY_IDLE_MS) parties.delete(id);
  });
}, 60000);

// Parse a Twitch VOD/clip identifier from various input formats
function parseVodRef(input) {
  const raw = (input || '').toString().trim();
  if (!raw) return null;

  // https://www.twitch.tv/videos/1234567890
  let m = raw.match(/twitch\.tv\/videos\/(\d+)/i);
  if (m) return { kind: 'video', id: m[1] };

  // https://clips.twitch.tv/AwesomeClipSlug or https://www.twitch.tv/<chan>/clip/<slug>
  m = raw.match(/clips\.twitch\.tv\/([A-Za-z0-9_-]+)/i);
  if (m) return { kind: 'clip', id: m[1] };
  m = raw.match(/twitch\.tv\/[^/]+\/clip\/([A-Za-z0-9_-]+)/i);
  if (m) return { kind: 'clip', id: m[1] };

  // bare video id like "v123..." or "1234567890"
  m = raw.match(/^v?(\d{6,})$/i);
  if (m) return { kind: 'video', id: m[1] };

  // bare clip slug (letters/dashes, no spaces)
  if (/^[A-Za-z0-9_-]{6,100}$/.test(raw)) return { kind: 'clip', id: raw };

  return null;
}

app.post('/api/party/create', (req, res) => {
  const nick = sanitizeNick(req.body?.nick);
  const roomId = makeId(6);
  const pid = makeId(10);
  const hostToken = makeId(16);
  const now = Date.now();
  const party = {
    id: roomId,
    createdAt: now,
    lastActivity: now,
    hostPid: pid,
    hostToken,
    vod: null, // { kind, id, position, playing, updatedAt }
    participants: new Map([[pid, { pid, nick, joinedAt: now, lastSeen: now }]]),
    messages: [],
    messageSeq: 0,
  };
  parties.set(roomId, party);
  console.log(`🎬 Party ${roomId} created by ${nick}`);
  res.json({ roomId, pid, hostToken, nick });
});

app.post('/api/party/:roomId/join', (req, res) => {
  const party = parties.get(req.params.roomId);
  if (!party) return res.status(404).json({ error: 'Party not found' });
  const nick = sanitizeNick(req.body?.nick);
  const pid = makeId(10);
  const now = Date.now();
  party.participants.set(pid, { pid, nick, joinedAt: now, lastSeen: now });
  touchParty(party);
  res.json({ roomId: party.id, pid, nick, host: false });
});

app.get('/api/party/:roomId/state', (req, res) => {
  const party = parties.get(req.params.roomId);
  if (!party) return res.status(404).json({ error: 'Party not found' });
  const pid = req.query.pid;
  const since = parseInt(req.query.since) || 0;
  if (pid && party.participants.has(pid)) {
    party.participants.get(pid).lastSeen = Date.now();
  }
  const msgs = party.messages.filter(m => m.seq > since);
  res.json({
    roomId: party.id,
    vod: party.vod,
    participants: participantsPublic(party),
    messages: msgs,
    latestSeq: party.messageSeq,
    hostPid: party.hostPid,
    serverTime: Date.now(),
  });
});

app.post('/api/party/:roomId/chat', (req, res) => {
  const party = parties.get(req.params.roomId);
  if (!party) return res.status(404).json({ error: 'Party not found' });
  const { pid, text } = req.body || {};
  const p = party.participants.get(pid);
  if (!p) return res.status(401).json({ error: 'Not in party' });
  const clean = (text || '').toString().slice(0, 500).trim();
  if (!clean) return res.status(400).json({ error: 'Empty message' });
  party.messageSeq += 1;
  const msg = { seq: party.messageSeq, nick: p.nick, pid, text: clean, ts: Date.now() };
  party.messages.push(msg);
  if (party.messages.length > PARTY_MAX_MESSAGES) {
    party.messages.splice(0, party.messages.length - PARTY_MAX_MESSAGES);
  }
  p.lastSeen = Date.now();
  touchParty(party);
  res.json({ ok: true, seq: msg.seq });
});

app.post('/api/party/:roomId/vod', (req, res) => {
  const party = parties.get(req.params.roomId);
  if (!party) return res.status(404).json({ error: 'Party not found' });
  const { pid, hostToken, vod, position, playing } = req.body || {};
  if (pid !== party.hostPid || hostToken !== party.hostToken) {
    return res.status(403).json({ error: 'Host only' });
  }
  const ref = parseVodRef(vod);
  if (vod !== undefined && vod !== null && !ref) {
    return res.status(400).json({ error: 'Invalid VOD reference' });
  }
  const now = Date.now();
  if (ref) {
    const current = party.vod && party.vod.id === ref.id && party.vod.kind === ref.kind;
    party.vod = {
      kind: ref.kind,
      id: ref.id,
      position: Number.isFinite(position) ? Math.max(0, position) : (current ? party.vod.position : 0),
      playing: playing !== undefined ? !!playing : (current ? party.vod.playing : true),
      updatedAt: now,
    };
  } else if (party.vod) {
    if (Number.isFinite(position)) party.vod.position = Math.max(0, position);
    if (playing !== undefined) party.vod.playing = !!playing;
    party.vod.updatedAt = now;
  }
  touchParty(party);
  res.json({ ok: true, vod: party.vod });
});

app.post('/api/party/:roomId/leave', (req, res) => {
  const party = parties.get(req.params.roomId);
  if (!party) return res.json({ ok: true });
  const { pid } = req.body || {};
  if (pid && party.participants.has(pid)) {
    party.participants.delete(pid);
    // If host left, promote another participant
    if (pid === party.hostPid) {
      const next = party.participants.values().next().value;
      if (next) {
        party.hostPid = next.pid;
        party.hostToken = makeId(16); // rotate - old host token invalid
        console.log(`🎬 Party ${party.id} host promoted: ${next.nick}`);
      }
    }
  }
  if (party.participants.size === 0) {
    parties.delete(party.id);
    console.log(`🎬 Party ${party.id} closed (empty)`);
  }
  res.json({ ok: true });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 Twitch Client ID: ${process.env.TWITCH_CLIENT_ID}`);
});

// Cleanup on exit
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  saveStats();
  chatClients.forEach((_, channelName) => {
    stopChatMonitoring(channelName);
  });
  process.exit(0);
});
