import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './WatchParty.css';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';

interface WatchPartyProps {
  initialRoomId?: string | null;
}

interface PartyParticipant {
  pid: string;
  nick: string;
  host: boolean;
}

interface PartyMessage {
  seq: number;
  nick: string;
  pid: string;
  text: string;
  ts: number;
}

interface PartyVod {
  kind: 'video' | 'clip';
  id: string;
  position: number;
  playing: boolean;
  updatedAt: number;
}

interface PartyState {
  roomId: string;
  vod: PartyVod | null;
  participants: PartyParticipant[];
  messages: PartyMessage[];
  latestSeq: number;
  hostPid: string;
  serverTime: number;
}

type Session = {
  roomId: string;
  pid: string;
  nick: string;
  hostToken?: string;
};

interface TwitchEmbedPlayer {
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  setMuted: (muted: boolean) => void;
  getMuted: () => boolean;
  setVolume: (v: number) => void;
}

interface TwitchEmbedInstance {
  getPlayer: () => TwitchEmbedPlayer;
  addEventListener: (evt: string, cb: () => void) => void;
}

type TwitchEmbedCtor = new (elementId: string, opts: Record<string, unknown>) => TwitchEmbedInstance;

function getTwitchEmbedCtor(): TwitchEmbedCtor | null {
  const g = (window as unknown as { Twitch?: { Embed?: unknown } }).Twitch;
  if (!g || !g.Embed) return null;
  return g.Embed as unknown as TwitchEmbedCtor;
}

const STORAGE_KEY = 'watchparty_session_v1';
const SYNC_DRIFT_SECONDS = 2;

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveSession(s: Session | null) {
  if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  else localStorage.removeItem(STORAGE_KEY);
}

export const WatchParty: React.FC<WatchPartyProps> = ({ initialRoomId }) => {
  const [session, setSession] = useState<Session | null>(() => {
    const s = loadSession();
    if (s && initialRoomId && s.roomId !== initialRoomId) return null;
    return s;
  });
  const [state, setState] = useState<PartyState | null>(null);
  const [nickDraft, setNickDraft] = useState(() => {
    return localStorage.getItem('watchparty_nick') || '';
  });
  const [roomDraft, setRoomDraft] = useState(initialRoomId || '');
  const [vodDraft, setVodDraft] = useState('');
  const [chatDraft, setChatDraft] = useState('');
  const [joining, setJoining] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const playerRef = useRef<HTMLDivElement>(null);
  const playerIdRef = useRef<string>(`wp-player-${Math.random().toString(36).slice(2, 8)}`);
  const playerInstanceRef = useRef<TwitchEmbedPlayer | null>(null);
  const currentVodKeyRef = useRef<string>('');
  const lastSentVodRef = useRef<{ id: string; kind: string; pos: number; playing: boolean; at: number } | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const sinceRef = useRef<number>(0);

  // Poll state
  const pollState = useCallback(async (sess: Session) => {
    try {
      const url = `${API_BASE}/api/party/${sess.roomId}/state?pid=${sess.pid}&since=${sinceRef.current}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        if (resp.status === 404) {
          setErr('Party ended');
          setSession(null);
          saveSession(null);
        }
        return;
      }
      const data: PartyState = await resp.json();
      setState(prev => {
        const merged = prev ? {
          ...data,
          messages: [...prev.messages, ...data.messages].slice(-500),
        } : data;
        return merged;
      });
      if (data.latestSeq > sinceRef.current) sinceRef.current = data.latestSeq;
    } catch (e) {
      // transient
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    pollState(session);
    const i = setInterval(() => pollState(session), 2000);
    return () => clearInterval(i);
  }, [session, pollState]);

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollTop = chatEndRef.current.scrollHeight;
    }
  }, [state?.messages.length]);

  const isHost = !!(session && state && session.pid === state.hostPid);

  // Load / recreate the Twitch embed when VOD changes
  useEffect(() => {
    if (!session || !state?.vod) return;
    const vodKey = `${state.vod.kind}:${state.vod.id}`;
    if (currentVodKeyRef.current === vodKey) return;
    if (!playerRef.current) return;

    currentVodKeyRef.current = vodKey;
    playerRef.current.innerHTML = '';
    const container = document.createElement('div');
    container.id = playerIdRef.current + '-' + Math.random().toString(36).slice(2, 6);
    container.style.width = '100%';
    container.style.height = '100%';
    playerRef.current.appendChild(container);

    const parent = window.location.hostname;

    const EmbedCtor = getTwitchEmbedCtor();
    if (!EmbedCtor) {
      // fallback iframe
      const iframe = document.createElement('iframe');
      if (state.vod.kind === 'video') {
        iframe.src = `https://player.twitch.tv/?video=v${state.vod.id}&parent=${parent}&autoplay=true&time=${Math.floor(state.vod.position)}s`;
      } else {
        iframe.src = `https://clips.twitch.tv/embed?clip=${state.vod.id}&parent=${parent}&autoplay=true`;
      }
      iframe.width = '100%';
      iframe.height = '100%';
      iframe.allowFullscreen = true;
      iframe.frameBorder = '0';
      iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
      playerRef.current.innerHTML = '';
      playerRef.current.appendChild(iframe);
      playerInstanceRef.current = null;
      return;
    }

    try {
      const embedOpts: Record<string, unknown> = {
        width: '100%',
        height: '100%',
        parent: [parent],
        layout: 'video',
        autoplay: true,
        muted: false,
        allowfullscreen: true,
      };
      if (state.vod.kind === 'video') {
        embedOpts.video = `v${state.vod.id}`;
        embedOpts.time = `${Math.floor(state.vod.position)}s`;
      } else {
        embedOpts.collection = undefined;
        embedOpts.video = undefined;
        // Clips don't embed via Twitch.Embed the same way; use iframe fallback
        const iframe = document.createElement('iframe');
        iframe.src = `https://clips.twitch.tv/embed?clip=${state.vod.id}&parent=${parent}&autoplay=true`;
        iframe.width = '100%';
        iframe.height = '100%';
        iframe.allowFullscreen = true;
        iframe.frameBorder = '0';
        iframe.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
        playerRef.current.innerHTML = '';
        playerRef.current.appendChild(iframe);
        playerInstanceRef.current = null;
        return;
      }
      const embed = new EmbedCtor(container.id, embedOpts);
      embed.addEventListener('video.ready', () => {
        try {
          playerInstanceRef.current = embed.getPlayer();
        } catch {
          playerInstanceRef.current = null;
        }
      });
    } catch (e) {
      console.error('WatchParty embed failed', e);
    }
  }, [session, state?.vod]);

  // Sync playback (non-host follows host position)
  useEffect(() => {
    if (!session || !state?.vod || isHost) return;
    const player = playerInstanceRef.current;
    if (!player) return;
    if (state.vod.kind !== 'video') return;

    try {
      const elapsed = (Date.now() - state.vod.updatedAt) / 1000;
      const expected = state.vod.playing ? state.vod.position + elapsed : state.vod.position;
      const current = player.getCurrentTime();
      if (Number.isFinite(current) && Math.abs(current - expected) > SYNC_DRIFT_SECONDS) {
        player.seek(expected);
      }
      if (state.vod.playing) player.play(); else player.pause();
    } catch {
      // embed API flaky right after video.ready
    }
  }, [session, state?.vod, isHost]);

  // Host pushes playback state periodically
  useEffect(() => {
    if (!session || !isHost || !state?.vod) return;
    const push = async () => {
      const player = playerInstanceRef.current;
      if (!player) return;
      let pos = state.vod!.position;
      const playing = state.vod!.playing;
      try {
        const t = player.getCurrentTime();
        if (Number.isFinite(t)) pos = t;
      } catch {}
      const last = lastSentVodRef.current;
      const now = Date.now();
      const changed = !last
        || last.id !== state.vod!.id
        || last.kind !== state.vod!.kind
        || Math.abs(last.pos - pos) > 1.5
        || last.playing !== playing
        || now - last.at > 10000;
      if (!changed) return;
      lastSentVodRef.current = { id: state.vod!.id, kind: state.vod!.kind, pos, playing, at: now };
      try {
        await fetch(`${API_BASE}/api/party/${session.roomId}/vod`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pid: session.pid,
            hostToken: session.hostToken,
            vod: `v${state.vod!.id}`,
            position: pos,
            playing,
          }),
        });
      } catch {}
    };
    const i = setInterval(push, 3000);
    return () => clearInterval(i);
  }, [session, state?.vod, isHost]);

  const createParty = useCallback(async () => {
    const nick = nickDraft.trim() || 'guest';
    setJoining(true);
    setErr(null);
    try {
      const resp = await fetch(`${API_BASE}/api/party/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nick }),
      });
      if (!resp.ok) throw new Error('Create failed');
      const data = await resp.json();
      const s: Session = {
        roomId: data.roomId,
        pid: data.pid,
        nick: data.nick,
        hostToken: data.hostToken,
      };
      localStorage.setItem('watchparty_nick', nick);
      saveSession(s);
      setSession(s);
      sinceRef.current = 0;
      window.history.replaceState({}, '', `/party/${data.roomId}`);
    } catch (e: unknown) {
      setErr('Could not create party');
    } finally {
      setJoining(false);
    }
  }, [nickDraft]);

  const joinParty = useCallback(async () => {
    const nick = nickDraft.trim() || 'guest';
    const room = roomDraft.trim().toLowerCase();
    if (!room) { setErr('Enter a room id'); return; }
    setJoining(true);
    setErr(null);
    try {
      const resp = await fetch(`${API_BASE}/api/party/${room}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nick }),
      });
      if (!resp.ok) {
        if (resp.status === 404) throw new Error('Party not found');
        throw new Error('Join failed');
      }
      const data = await resp.json();
      const s: Session = {
        roomId: data.roomId,
        pid: data.pid,
        nick: data.nick,
      };
      localStorage.setItem('watchparty_nick', nick);
      saveSession(s);
      setSession(s);
      sinceRef.current = 0;
      window.history.replaceState({}, '', `/party/${data.roomId}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not join';
      setErr(msg);
    } finally {
      setJoining(false);
    }
  }, [nickDraft, roomDraft]);

  const leaveParty = useCallback(async () => {
    if (!session) return;
    try {
      await fetch(`${API_BASE}/api/party/${session.roomId}/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: session.pid }),
      });
    } catch {}
    saveSession(null);
    setSession(null);
    setState(null);
    currentVodKeyRef.current = '';
    playerInstanceRef.current = null;
    sinceRef.current = 0;
    window.history.replaceState({}, '', '/party');
  }, [session]);

  const setVod = useCallback(async () => {
    if (!session) return;
    const input = vodDraft.trim();
    if (!input) return;
    try {
      const resp = await fetch(`${API_BASE}/api/party/${session.roomId}/vod`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pid: session.pid,
          hostToken: session.hostToken,
          vod: input,
          position: 0,
          playing: true,
        }),
      });
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        setErr(d.error || 'Could not set VOD');
        return;
      }
      setVodDraft('');
      setErr(null);
      currentVodKeyRef.current = ''; // force embed rebuild
      lastSentVodRef.current = null;
      pollState(session);
    } catch {
      setErr('Could not set VOD');
    }
  }, [session, vodDraft, pollState]);

  const sendChat = useCallback(async () => {
    if (!session) return;
    const text = chatDraft.trim();
    if (!text) return;
    setChatDraft('');
    try {
      await fetch(`${API_BASE}/api/party/${session.roomId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: session.pid, text }),
      });
      pollState(session);
    } catch {}
  }, [session, chatDraft, pollState]);

  const shareLink = useMemo(() => {
    if (!session) return '';
    return `${window.location.origin}/party/${session.roomId}`;
  }, [session]);

  const copyShareLink = useCallback(() => {
    if (!shareLink) return;
    navigator.clipboard?.writeText(shareLink);
  }, [shareLink]);

  if (!session) {
    return (
      <div className="watchparty-lobby">
        <div className="watchparty-lobby-card">
          <h1>🎬 Watch Party</h1>
          <p className="watchparty-subtitle">Watch Twitch VODs and clips with friends, chat together.</p>

          <label className="watchparty-label">
            Nickname
            <input
              type="text"
              maxLength={24}
              value={nickDraft}
              onChange={e => setNickDraft(e.target.value)}
              placeholder="your nick"
            />
          </label>

          <div className="watchparty-lobby-actions">
            <button className="watchparty-btn watchparty-btn-primary" onClick={createParty} disabled={joining}>
              Create new party
            </button>

            <div className="watchparty-divider"><span>or</span></div>

            <label className="watchparty-label">
              Join with room code
              <div className="watchparty-row">
                <input
                  type="text"
                  value={roomDraft}
                  onChange={e => setRoomDraft(e.target.value)}
                  placeholder="e.g. ab3k7p"
                  onKeyDown={e => e.key === 'Enter' && joinParty()}
                />
                <button className="watchparty-btn" onClick={joinParty} disabled={joining}>Join</button>
              </div>
            </label>
          </div>

          {err && <div className="watchparty-error">{err}</div>}

          <div className="watchparty-hint">
            Paste a Twitch VOD link (<code>twitch.tv/videos/…</code>) or clip link once inside.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="watchparty-container">
      <div className="watchparty-header">
        <div className="watchparty-header-left">
          <span className="watchparty-title">🎬 Watch Party</span>
          <span className="watchparty-room">#{session.roomId}</span>
          <button className="watchparty-copy" onClick={copyShareLink} title="Copy invite link">Copy link</button>
          {isHost && <span className="watchparty-host-badge">HOST</span>}
        </div>
        <div className="watchparty-header-right">
          <span className="watchparty-viewers">{state?.participants.length || 1} watching</span>
          <button className="watchparty-btn watchparty-btn-danger" onClick={leaveParty}>Leave</button>
        </div>
      </div>

      {isHost && (
        <div className="watchparty-vod-bar">
          <input
            type="text"
            value={vodDraft}
            onChange={e => setVodDraft(e.target.value)}
            placeholder="Paste Twitch VOD or clip link…"
            onKeyDown={e => e.key === 'Enter' && setVod()}
          />
          <button className="watchparty-btn" onClick={setVod}>Play for everyone</button>
        </div>
      )}

      <div className="watchparty-main">
        <div className="watchparty-player-wrap">
          {state?.vod ? (
            <div className="watchparty-player" ref={playerRef} />
          ) : (
            <div className="watchparty-empty">
              {isHost
                ? 'Paste a Twitch VOD or clip link above to start watching.'
                : 'Waiting for the host to pick something to watch…'}
            </div>
          )}
        </div>

        <div className="watchparty-side">
          <div className="watchparty-people">
            <div className="watchparty-section-title">In the room</div>
            <div className="watchparty-people-list">
              {(state?.participants || []).map(p => (
                <div key={p.pid} className="watchparty-person">
                  <span className="watchparty-dot" />
                  <span className="watchparty-nick">{p.nick}</span>
                  {p.host && <span className="watchparty-host-tag">host</span>}
                  {p.pid === session.pid && <span className="watchparty-you-tag">you</span>}
                </div>
              ))}
            </div>
          </div>

          <div className="watchparty-chat">
            <div className="watchparty-section-title">Chat</div>
            <div className="watchparty-messages" ref={chatEndRef}>
              {(state?.messages || []).map(m => (
                <div key={m.seq} className={`watchparty-msg ${m.pid === session.pid ? 'mine' : ''}`}>
                  <span className="watchparty-msg-nick">{m.nick}</span>
                  <span className="watchparty-msg-text">{m.text}</span>
                </div>
              ))}
              {!state?.messages.length && (
                <div className="watchparty-msg-empty">Say hi 👋</div>
              )}
            </div>
            <div className="watchparty-chat-input">
              <input
                type="text"
                value={chatDraft}
                maxLength={500}
                onChange={e => setChatDraft(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendChat()}
                placeholder="Message the party…"
              />
              <button className="watchparty-btn" onClick={sendChat}>Send</button>
            </div>
          </div>
        </div>
      </div>

      {err && <div className="watchparty-error watchparty-error-float">{err}</div>}
    </div>
  );
};
