import React, { useState, useMemo } from 'react';
import { StreamWithChatRate } from '../types';
import { TwitchUser } from '../services/twitchApi';
import './StreamList.css';

interface StreamListProps {
  streams: StreamWithChatRate[];
  followedStreams?: StreamWithChatRate[];
  customStreams?: string[];
  sharedListOwner?: string | null;
  selectedStream: StreamWithChatRate | null;
  onStreamSelect: (stream: StreamWithChatRate) => void;
  onToggleSidebar?: () => void;
  user?: TwitchUser | null;
  onLogin?: () => void;
  onLogout?: () => void;
  onShowGuide?: () => void;
}

type SortOption = 'chat' | 'viewers' | 'heat';
type ViewMode = 'top' | 'rec' | 'followed' | 'custom';

// Curated recommendation list
const REC_STREAMERS = [
  'quin69', 'summit1g', 'robcdee', 'Day9tv', 'AnnieFuchsia', 'willneff',
  'HasanAbi', 'Nmplol', 'Trainwreckstv', 'zackrawrr', 'nl_Kripp', 'forsen',
  'CohhCarnage', 'BikeMan', 'itmeJP', 'sodapoppin', 'Towelliee', 'LIRIK',
  'xQc', 'maya'
].map(s => s.toLowerCase());

export const StreamList: React.FC<StreamListProps> = ({
  streams,
  followedStreams = [],
  customStreams = [],
  sharedListOwner,
  selectedStream,
  onStreamSelect,
  onToggleSidebar,
  user,
  onLogin,
  onLogout,
  onShowGuide,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>('chat');
  const [viewMode, setViewMode] = useState<ViewMode>('top');

  const activeStreams = useMemo(() => {
    if (viewMode === 'rec') {
      // Show curated rec list - filter streams to only include those in REC_STREAMERS
      const allStreams = [...streams, ...followedStreams];
      const streamMap = new Map<string, StreamWithChatRate>();
      allStreams.forEach(s => {
        streamMap.set(s.user_login.toLowerCase(), s);
      });

      // Return rec streamers that are live, in order
      return REC_STREAMERS
        .map(name => streamMap.get(name))
        .filter((s): s is StreamWithChatRate => s !== undefined && s.thumbnail_url !== '');
    } else if (viewMode === 'followed') {
      if (!user) return [];
      const seen = new Set<string>();
      return followedStreams.filter(s => {
        const key = s.user_login.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } else if (viewMode === 'custom' && customStreams.length > 0) {
      // Show ALL custom streams, even if offline
      const allStreams = [...streams, ...followedStreams];
      const streamMap = new Map<string, StreamWithChatRate>();
      allStreams.forEach(s => {
        streamMap.set(s.user_login.toLowerCase(), s);
      });

      // Create entries for all custom streams
      return customStreams.map(name => {
        const existing = streamMap.get(name.toLowerCase());
        if (existing) return existing;
        // Create placeholder for offline/not-in-top streams
        return {
          id: name.toLowerCase(),
          user_id: '',
          user_login: name.toLowerCase(),
          user_name: name,
          game_id: '',
          game_name: '',
          type: 'live',
          title: '',
          viewer_count: 0,
          started_at: '',
          language: '',
          thumbnail_url: '',
          tag_ids: [],
          tags: [],
          is_mature: false,
          chatRate: 0,
          messageCount: 0,
        } as StreamWithChatRate;
      });
    }
    return streams;
  }, [viewMode, user, streams, followedStreams, customStreams]);

  const filteredAndSortedStreams = useMemo(() => {
    let result = [...activeStreams];

    // Apply search filter
    if (searchTerm.trim()) {
      const search = searchTerm.toLowerCase();
      result = result.filter(stream =>
        stream.user_name.toLowerCase().includes(search) ||
        stream.title.toLowerCase().includes(search) ||
        stream.game_name.toLowerCase().includes(search)
      );
    }

    // Apply sorting
    result.sort((a, b) => {
      switch (sortBy) {
        case 'viewers':
          return b.viewer_count - a.viewer_count;
        case 'heat':
          const heatA = a.chatRate5m && a.chatRate5m > 0
            ? (a.chatRate10s || 0) / a.chatRate5m
            : 0;
          const heatB = b.chatRate5m && b.chatRate5m > 0
            ? (b.chatRate10s || 0) / b.chatRate5m
            : 0;
          return heatB - heatA;
        case 'chat':
        default:
          return b.chatRate - a.chatRate;
      }
    });

    return result;
  }, [activeStreams, searchTerm, sortBy]);

  return (
    <div className="stream-list">
      <div className="stream-list-header">
        {/* Login Section */}
        <div className="twitch-login-section">
          {user ? (
            <div className="user-info">
              <img src={user.profile_image_url} alt={user.display_name} className="user-avatar" />
              <span className="user-name">{user.display_name}</span>
              <button className="help-btn small" onClick={onShowGuide} title="What is this?">?</button>
              <button className="logout-btn" onClick={onLogout} title="Logout">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M6 1h5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1h1v1a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v1H4V3a2 2 0 0 1 2-2z"/>
                  <path d="M1 8a.5.5 0 0 1 .5-.5h5.793L5.146 5.354a.5.5 0 1 1 .708-.708l3 3a.5.5 0 0 1 0 .708l-3 3a.5.5 0 0 1-.708-.708L7.293 8.5H1.5A.5.5 0 0 1 1 8z"/>
                </svg>
              </button>
            </div>
          ) : (
            <div className="login-row">
              <button className="twitch-login-btn" onClick={onLogin}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z"/>
                </svg>
                Connect Twitch
              </button>
              <button className="help-btn" onClick={onShowGuide} title="What is this?">?</button>
            </div>
          )}
        </div>

        {/* View Mode Tabs - always show Rec, show others if logged in or custom */}
        <div className="view-mode-tabs">
          <button
            className={`view-tab ${viewMode === 'top' ? 'active' : ''}`}
            onClick={() => setViewMode('top')}
          >
            Top
          </button>
          <button
            className={`view-tab ${viewMode === 'rec' ? 'active' : ''}`}
            onClick={() => setViewMode('rec')}
          >
            Rec
          </button>
          {user && (
              <button
                className={`view-tab ${viewMode === 'followed' ? 'active' : ''}`}
                onClick={() => setViewMode('followed')}
              >
                Following
              </button>
            )}
          {customStreams.length > 0 && (
            <button
              className={`view-tab ${viewMode === 'custom' ? 'active' : ''}`}
              onClick={() => setViewMode('custom')}
            >
              {sharedListOwner ? `@${sharedListOwner}` : 'Custom'}
            </button>
          )}
          <a
            className="view-tab view-tab-party"
            href="/party"
            title="Watch Twitch VODs & clips with friends"
          >
            🎬 Party
          </a>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <h2>
            {viewMode === 'rec' ? 'Rec' : viewMode === 'followed' ? 'Following' : viewMode === 'custom' ? (sharedListOwner ? `@${sharedListOwner}` : 'Custom') : 'Streams'} ({filteredAndSortedStreams.length})
          </h2>
          {onToggleSidebar && (
            <button
              className="mute-toggle"
              onClick={onToggleSidebar}
              title="Hide sidebar"
              style={{ marginLeft: 'auto' }}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor">
                <path d="M12 4L6 10l6 6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
        </div>
        <input
          type="text"
          placeholder="Search..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="search-input"
        />
        <div className="sort-options">
          <button
            className={`sort-btn ${sortBy === 'chat' ? 'active' : ''}`}
            onClick={() => setSortBy('chat')}
          >
            Chat
          </button>
          <button
            className={`sort-btn ${sortBy === 'viewers' ? 'active' : ''}`}
            onClick={() => setSortBy('viewers')}
          >
            Viewers
          </button>
          <button
            className={`sort-btn ${sortBy === 'heat' ? 'active' : ''}`}
            onClick={() => setSortBy('heat')}
          >
            Heat
          </button>
        </div>
      </div>
      <div className="stream-items">
        {filteredAndSortedStreams.length === 0 ? (
          <div className="no-streams">
            {viewMode === 'followed' ? (
              <p>No followed streams are live right now.</p>
            ) : viewMode === 'custom' ? (
              <p>No custom streams are live right now.</p>
            ) : (
              <p>No streams found.</p>
            )}
          </div>
        ) : (
          filteredAndSortedStreams.map((stream, index) => {
            const isOffline = !stream.thumbnail_url;
            return (
            <div
              key={stream.id}
              className={`stream-item ${selectedStream?.id === stream.id ? 'selected' : ''} ${isOffline ? 'offline' : ''}`}
              onClick={() => onStreamSelect(stream)}
            >
              <div className="stream-rank">#{index + 1}</div>
              {!isOffline && (
                <img
                  src={stream.thumbnail_url.replace('{width}', '50').replace('{height}', '70')}
                  alt={stream.title}
                  className="stream-thumbnail"
                />
              )}
              <div className="stream-info">
                <span className="stream-streamer">{stream.user_name}</span>
                {isOffline ? (
                  <div className="stream-title" style={{ color: '#666', fontStyle: 'italic' }}>Offline</div>
                ) : (
                  <>
                    <div className="stream-title">{stream.title}</div>
                    <div className="stream-game">{stream.game_name}</div>
                  </>
                )}
                {!isOffline && (
                <div className="stream-stats">
                  <span style={{
                    background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)',
                    color: 'white',
                    padding: '3px 8px',
                    borderRadius: '20px',
                    fontSize: '10px',
                    fontWeight: 600,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '3px'
                  }} title="Viewer count">
                    👁️ {stream.viewer_count.toLocaleString()}
                  </span>
                  <span style={{
                    background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                    color: 'white',
                    padding: '3px 8px',
                    borderRadius: '20px',
                    fontSize: '10px',
                    fontWeight: 600,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '3px'
                  }} title="Last 10 seconds">
                    ⚡ {stream.chatRate10s?.toFixed(1) || '0.0'}/s
                  </span>
                  <span style={{
                    background: 'linear-gradient(135deg, #64748b 0%, #475569 100%)',
                    color: 'white',
                    padding: '3px 8px',
                    borderRadius: '20px',
                    fontSize: '10px',
                    fontWeight: 600,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '3px'
                  }} title="Last 5 minutes average">
                    📊 {stream.chatRate5m?.toFixed(1) || '0.0'}/s
                  </span>
                  {!!stream.chatRate5m && stream.chatRate5m > 0 && (
                    <span style={{
                      background: stream.chatRate10s && stream.chatRate10s > stream.chatRate5m * 5
                        ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'
                        : stream.chatRate10s && stream.chatRate10s > stream.chatRate5m * 3
                        ? 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)'
                        : stream.chatRate10s && stream.chatRate10s > stream.chatRate5m * 2
                        ? 'linear-gradient(135deg, #eab308 0%, #ca8a04 100%)'
                        : 'linear-gradient(135deg, #71717a 0%, #52525b 100%)',
                      color: 'white',
                      padding: '3px 8px',
                      borderRadius: '20px',
                      fontSize: '10px',
                      fontWeight: 700,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '3px',
                      boxShadow: stream.chatRate10s && stream.chatRate10s > stream.chatRate5m * 2
                        ? '0 0 8px rgba(234, 179, 8, 0.4)'
                        : 'none'
                    }} title="Heat ratio: 10s vs 5m average">
                      🔥 {((stream.chatRate10s || 0) / stream.chatRate5m).toFixed(1)}x
                    </span>
                  )}
                </div>
                )}
              </div>
            </div>
          )})
        )}
      </div>
    </div>
  );
};
