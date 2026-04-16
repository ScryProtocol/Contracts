import React, { useState, useEffect } from 'react';
import './Settings.css';

export type TimeWindow = '5s' | '5m';
export type SwitchMode = 'highest' | 'threshold' | 'random';
export type StreamSource = 'top' | 'recommended' | 'followed' | 'custom';
export type AutoSwitchBehavior = 'auto' | 'popup';

export interface SpamFilterSettings {
  filterVotes: boolean;    // 1, 2, 3...
  filterCommands: boolean; // !play, !join...
}

interface SettingsProps {
  timeWindow: TimeWindow;
  switchMode: SwitchMode;
  threshold: number;
  languageFilter: string;
  cooldown: number;
  minChatRate: number;
  gameBlacklist: string[];
  streamBlacklist: string[];
  favoriteStream: string;
  streamSource: StreamSource;
  customStreams: string[];
  autoSwitchBehavior: AutoSwitchBehavior;
  spamFilter: SpamFilterSettings;
  isLoggedIn: boolean;
  sessionId: string | null;
  onTimeWindowChange: (window: TimeWindow) => void;
  onSwitchModeChange: (mode: SwitchMode) => void;
  onThresholdChange: (threshold: number) => void;
  onLanguageFilterChange: (lang: string) => void;
  onCooldownChange: (cooldown: number) => void;
  onMinChatRateChange: (rate: number) => void;
  onGameBlacklistChange: (games: string[]) => void;
  onStreamBlacklistChange: (streams: string[]) => void;
  onFavoriteStreamChange: (stream: string) => void;
  onStreamSourceChange: (source: StreamSource) => void;
  onCustomStreamsChange: (streams: string[]) => void;
  onAutoSwitchBehaviorChange: (behavior: AutoSwitchBehavior) => void;
  onSpamFilterChange: (settings: SpamFilterSettings) => void;
}

// Local storage utilities
const SETTINGS_KEY = 'twitch-chat-viewer-settings';

export const saveSettings = (settings: {
  timeWindow: TimeWindow;
  switchMode: SwitchMode;
  threshold: number;
  languageFilter: string;
  cooldown: number;
  minChatRate: number;
  gameBlacklist: string[];
  streamBlacklist: string[];
  favoriteStream: string;
  streamSource: StreamSource;
  customStreams: string[];
  autoSwitchBehavior: AutoSwitchBehavior;
  spamFilter: SpamFilterSettings;
}) => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
};

export const loadSettings = () => {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
};

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';

export const Settings: React.FC<SettingsProps> = ({
  timeWindow,
  switchMode,
  threshold,
  languageFilter,
  cooldown,
  minChatRate,
  gameBlacklist,
  streamBlacklist,
  favoriteStream,
  streamSource,
  customStreams,
  autoSwitchBehavior,
  spamFilter,
  isLoggedIn,
  sessionId,
  onTimeWindowChange,
  onSwitchModeChange,
  onThresholdChange,
  onLanguageFilterChange,
  onCooldownChange,
  onMinChatRateChange,
  onGameBlacklistChange,
  onStreamBlacklistChange,
  onFavoriteStreamChange,
  onStreamSourceChange,
  onCustomStreamsChange,
  onAutoSwitchBehaviorChange,
  onSpamFilterChange,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [gameInput, setGameInput] = useState('');
  const [streamInput, setStreamInput] = useState('');
  const [customStreamInput, setCustomStreamInput] = useState('');
  const [shareHandle, setShareHandle] = useState('');
  const [savedHandle, setSavedHandle] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState<string | null>(null);

  // Load user's saved list handle on mount
  useEffect(() => {
    if (sessionId) {
      fetch(`${API_BASE}/api/my-list?sessionId=${sessionId}`)
        .then(res => res.json())
        .then(data => {
          if (data.handle) {
            setSavedHandle(data.handle);
            setShareHandle(data.handle);
          }
        })
        .catch(() => {});
    }
  }, [sessionId]);

  const saveShareableList = async () => {
    if (!sessionId || !shareHandle.trim() || customStreams.length === 0) return;

    setShareStatus('Saving...');
    try {
      const res = await fetch(`${API_BASE}/api/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          handle: shareHandle.trim(),
          streams: customStreams
        })
      });
      const data = await res.json();
      if (data.success) {
        setSavedHandle(data.handle);
        setShareStatus('Saved!');
        setTimeout(() => setShareStatus(null), 2000);
      } else {
        setShareStatus(data.error || 'Failed to save');
        setTimeout(() => setShareStatus(null), 3000);
      }
    } catch {
      setShareStatus('Failed to save');
      setTimeout(() => setShareStatus(null), 3000);
    }
  };

  // Save settings whenever they change
  useEffect(() => {
    saveSettings({
      timeWindow,
      switchMode,
      threshold,
      languageFilter,
      cooldown,
      minChatRate,
      gameBlacklist,
      streamBlacklist,
      favoriteStream,
      streamSource,
      customStreams,
      autoSwitchBehavior,
      spamFilter,
    });
  }, [timeWindow, switchMode, threshold, languageFilter, cooldown, minChatRate, gameBlacklist, streamBlacklist, favoriteStream, streamSource, customStreams, autoSwitchBehavior, spamFilter]);

  const handleAddGame = () => {
    if (gameInput.trim() && !gameBlacklist.includes(gameInput.trim())) {
      onGameBlacklistChange([...gameBlacklist, gameInput.trim()]);
      setGameInput('');
    }
  };

  const handleRemoveGame = (game: string) => {
    onGameBlacklistChange(gameBlacklist.filter(g => g !== game));
  };

  const handleAddStream = () => {
    if (streamInput.trim() && !streamBlacklist.includes(streamInput.trim().toLowerCase())) {
      onStreamBlacklistChange([...streamBlacklist, streamInput.trim().toLowerCase()]);
      setStreamInput('');
    }
  };

  const handleRemoveStream = (stream: string) => {
    onStreamBlacklistChange(streamBlacklist.filter(s => s !== stream));
  };

  return (
    <div style={{ position: 'relative' }}>
      <button className="settings-toggle" onClick={() => setIsOpen(!isOpen)}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z"/>
        </svg>
        Settings
      </button>
      <div className={`settings-panel ${isOpen ? 'open' : ''}`}>
      <div className="settings-section">
        <label className="settings-label">Auto-Switch</label>
        <div className="settings-options">
          <button
            className={`settings-btn ${switchMode === 'highest' ? 'active' : ''}`}
            onClick={() => onSwitchModeChange('highest')}
          >
            Highest
          </button>
          <button
            className={`settings-btn ${switchMode === 'threshold' ? 'active' : ''}`}
            onClick={() => onSwitchModeChange('threshold')}
          >
            Threshold
          </button>
          <button
            className={`settings-btn ${switchMode === 'random' ? 'active' : ''}`}
            onClick={() => onSwitchModeChange('random')}
          >
            Random
          </button>
        </div>
      </div>

      <div className="settings-section">
        <label className="settings-label">Switch Behavior</label>
        <div className="settings-options">
          <button
            className={`settings-btn ${autoSwitchBehavior === 'auto' ? 'active' : ''}`}
            onClick={() => onAutoSwitchBehaviorChange('auto')}
          >
            Auto
          </button>
          <button
            className={`settings-btn ${autoSwitchBehavior === 'popup' ? 'active' : ''}`}
            onClick={() => onAutoSwitchBehaviorChange('popup')}
          >
            Popup (S)
          </button>
        </div>
      </div>

      <div className="settings-section">
        <label className="settings-label">Stream Source</label>
        <div className="settings-options">
          <button
            className={`settings-btn ${streamSource === 'top' ? 'active' : ''}`}
            onClick={() => onStreamSourceChange('top')}
          >
            Top 100
          </button>
          <button
            className={`settings-btn ${streamSource === 'recommended' ? 'active' : ''}`}
            onClick={() => onStreamSourceChange('recommended')}
          >
            Rec
          </button>
          {isLoggedIn && (
            <button
              className={`settings-btn ${streamSource === 'followed' ? 'active' : ''}`}
              onClick={() => onStreamSourceChange('followed')}
            >
              Followed
            </button>
          )}
          <button
            className={`settings-btn ${streamSource === 'custom' ? 'active' : ''}`}
            onClick={() => onStreamSourceChange('custom')}
          >
            Custom
          </button>
        </div>
      </div>

      {streamSource === 'custom' && (
        <div className="settings-section">
          <label className="settings-label">Custom Streams</label>
          <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
            <input
              type="text"
              value={customStreamInput}
              onChange={(e) => setCustomStreamInput(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === 'Enter' && customStreamInput.trim() && !customStreams.includes(customStreamInput.trim().toLowerCase())) {
                  onCustomStreamsChange([...customStreams, customStreamInput.trim().toLowerCase()]);
                  setCustomStreamInput('');
                }
              }}
              placeholder="Add streamer username"
              className="settings-input"
            />
            <button
              onClick={() => {
                if (customStreamInput.trim() && !customStreams.includes(customStreamInput.trim().toLowerCase())) {
                  onCustomStreamsChange([...customStreams, customStreamInput.trim().toLowerCase()]);
                  setCustomStreamInput('');
                }
              }}
              className="settings-btn"
            >
              Add
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {customStreams.map(stream => (
              <span key={stream} className="game-tag">
                {stream}
                <button onClick={() => onCustomStreamsChange(customStreams.filter(s => s !== stream))} className="remove-tag">×</button>
              </span>
            ))}
          </div>

          {/* Shareable list section */}
          {isLoggedIn && customStreams.length > 0 && (
            <div style={{ marginTop: '12px', padding: '10px', background: 'rgba(145, 70, 255, 0.1)', borderRadius: '20px' }}>
              <label className="settings-label" style={{ marginBottom: '6px', display: 'block' }}>
                Share this list
              </label>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <span style={{ color: '#9146FF' }}>pogchamp.tv/@</span>
                <input
                  type="text"
                  value={shareHandle}
                  onChange={(e) => setShareHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                  placeholder="yourname"
                  className="settings-input"
                  style={{ flex: 1 }}
                  maxLength={20}
                />
                <button onClick={saveShareableList} className="settings-btn" disabled={!shareHandle.trim()}>
                  {savedHandle ? 'Update' : 'Save'}
                </button>
              </div>
              {shareStatus && (
                <div style={{ marginTop: '6px', fontSize: '12px', color: shareStatus === 'Saved!' ? '#00ff7f' : '#ff6b6b' }}>
                  {shareStatus}
                </div>
              )}
              {savedHandle && !shareStatus && (
                <div style={{ marginTop: '6px', fontSize: '12px', color: '#9146FF' }}>
                  Live at: <a href={`/@${savedHandle}`} style={{ color: '#9146FF' }}>pogchamp.tv/@{savedHandle}</a>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {switchMode === 'threshold' && (
        <div className="settings-section">
          <label className="settings-label">
            Threshold {threshold}x
          </label>
          <input
            type="range"
            min="1.2"
            max="10"
            step="0.1"
            value={threshold}
            onChange={(e) => onThresholdChange(parseFloat(e.target.value))}
            className="settings-slider"
          />
        </div>
      )}

      <div className="settings-section">
        <label className="settings-label">Language</label>
        <select
          value={languageFilter}
          onChange={(e) => onLanguageFilterChange(e.target.value)}
          className="settings-select"
        >
          <option value="all">All</option>
          <option value="en">English</option>
          <option value="es">Español</option>
          <option value="pt">Português</option>
          <option value="fr">Français</option>
          <option value="de">Deutsch</option>
          <option value="it">Italiano</option>
          <option value="ru">Русский</option>
          <option value="ja">日本語</option>
          <option value="ko">한국어</option>
          <option value="zh">中文</option>
        </select>
      </div>

      <div className="settings-section">
        <label className="settings-label">
          Cooldown: {cooldown}s
        </label>
        <input
          type="range"
          min="5"
          max="60"
          step="5"
          value={cooldown}
          onChange={(e) => onCooldownChange(parseInt(e.target.value))}
          className="settings-slider"
        />
      </div>

      <div className="settings-section">
        <label className="settings-label">
          Min Chat Rate: {minChatRate.toFixed(1)}/s
        </label>
        <input
          type="range"
          min="0"
          max="50"
          step="0.5"
          value={minChatRate}
          onChange={(e) => onMinChatRateChange(parseFloat(e.target.value))}
          className="settings-slider"
        />
      </div>

      <div className="settings-section">
        <label className="settings-label">Spam Filter</label>
        <div className="settings-options">
          <button
            className={`settings-btn ${spamFilter.filterVotes ? 'active' : ''}`}
            onClick={() => onSpamFilterChange({ ...spamFilter, filterVotes: !spamFilter.filterVotes })}
          >
            1/2/3
          </button>
          <button
            className={`settings-btn ${spamFilter.filterCommands ? 'active' : ''}`}
            onClick={() => onSpamFilterChange({ ...spamFilter, filterCommands: !spamFilter.filterCommands })}
          >
            !cmds
          </button>
        </div>
      </div>

      <div className="settings-section">
        <label className="settings-label">Game Blacklist</label>
        <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
          <input
            type="text"
            value={gameInput}
            onChange={(e) => setGameInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleAddGame()}
            placeholder="Add game to blacklist"
            className="settings-input"
          />
          <button onClick={handleAddGame} className="settings-btn">Add</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {gameBlacklist.map(game => (
            <span key={game} className="game-tag">
              {game}
              <button onClick={() => handleRemoveGame(game)} className="remove-tag">×</button>
            </span>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <label className="settings-label">Stream Blacklist</label>
        <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
          <input
            type="text"
            value={streamInput}
            onChange={(e) => setStreamInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleAddStream()}
            placeholder="Add username to blacklist"
            className="settings-input"
          />
          <button onClick={handleAddStream} className="settings-btn">Add</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {streamBlacklist.map(stream => (
            <span key={stream} className="game-tag">
              {stream}
              <button onClick={() => handleRemoveStream(stream)} className="remove-tag">×</button>
            </span>
          ))}
        </div>
      </div>

      <div className="settings-section">
        <label className="settings-label">Favorite Stream</label>
        <input
          type="text"
          value={favoriteStream}
          onChange={(e) => onFavoriteStreamChange(e.target.value.toLowerCase())}
          placeholder="Username (auto-return)"
          className="settings-input"
        />
      </div>
    </div>
    </div>
  );
};
