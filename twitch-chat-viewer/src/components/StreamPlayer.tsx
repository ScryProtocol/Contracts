import React, { useEffect, useRef, useState } from 'react';
import { StreamWithChatRate } from '../types';
import { Settings, TimeWindow, SwitchMode, StreamSource, AutoSwitchBehavior, SpamFilterSettings } from './Settings';
import './StreamPlayer.css';

interface TwitchPlayer {
  setMuted: (muted: boolean) => void;
  getMuted: () => boolean;
  setVolume: (volume: number) => void;
  getVolume: () => number;
}

interface TwitchEmbed {
  getPlayer: () => TwitchPlayer;
  addEventListener: (event: string, callback: () => void) => void;
}

interface TwitchEmbedConstructor {
  new (elementId: string, options: {
    width: string | number;
    height: string | number;
    channel: string;
    parent: string[];
    layout?: 'video' | 'video-with-chat';
    autoplay?: boolean;
    muted?: boolean;
    allowfullscreen?: boolean;
  }): TwitchEmbed;
}

declare global {
  interface Window {
    Twitch: {
      Embed: TwitchEmbedConstructor;
    };
  }
}

interface StreamPlayerProps {
  stream: StreamWithChatRate | null;
  timeWindow: TimeWindow;
  switchMode: SwitchMode;
  threshold: number;
  languageFilter: string;
  cooldown: number;
  cooldownProgress: number;
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
  sidebarHidden: boolean;
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
  onBlacklistCurrent: () => void;
  onToggleSidebar: () => void;
}

export const StreamPlayer: React.FC<StreamPlayerProps> = ({
  stream,
  timeWindow,
  switchMode,
  threshold,
  languageFilter,
  cooldown,
  cooldownProgress,
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
  sidebarHidden,
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
  onBlacklistCurrent,
  onToggleSidebar,
}) => {
  const playerRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const currentStreamIdRef = useRef<string | null>(null);
  const embedRef = useRef<TwitchEmbed | null>(null);
  const [isMuted, setIsMuted] = useState(false); // Start unmuted
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Listen for fullscreen changes and track state
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (!stream || !playerRef.current || !chatRef.current) return;

    // Only reload if the stream ID actually changed
    if (currentStreamIdRef.current === stream.id) {
      return;
    }

    currentStreamIdRef.current = stream.id;

    // Clear previous embeds
    playerRef.current.innerHTML = '';
    chatRef.current.innerHTML = '';
    embedRef.current = null;

    // Use hostname without port for Twitch embed
    const parentDomain = window.location.hostname;

    // Create player container with unique ID
    const playerContainer = document.createElement('div');
    playerContainer.id = `twitch-embed-${stream.id}`;
    playerContainer.style.width = '100%';
    playerContainer.style.height = '100%';
    playerRef.current.appendChild(playerContainer);

    // Use Twitch Embed API - this respects user's Twitch login for ad-free viewing
    if (window.Twitch && window.Twitch.Embed) {
      try {
        embedRef.current = new window.Twitch.Embed(playerContainer.id, {
          width: '100%',
          height: '100%',
          channel: stream.user_login,
          parent: [parentDomain],
          layout: 'video',
          autoplay: true,
          muted: false,
          allowfullscreen: true,
        });
        console.log('Twitch Embed API player created for channel:', stream.user_login);
      } catch (err) {
        console.error('Failed to create Twitch Embed:', err);
        // Fallback to iframe
        const playerEmbed = document.createElement('iframe');
        playerEmbed.src = `https://player.twitch.tv/?channel=${stream.user_login}&parent=${parentDomain}&autoplay=true&muted=false&volume=0.5`;
        playerEmbed.width = '100%';
        playerEmbed.height = '100%';
        playerEmbed.allowFullscreen = true;
        playerEmbed.frameBorder = '0';
        playerEmbed.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
        playerRef.current.innerHTML = '';
        playerRef.current.appendChild(playerEmbed);
      }
    } else {
      // Fallback to iframe if Twitch Embed not loaded
      const playerEmbed = document.createElement('iframe');
      playerEmbed.src = `https://player.twitch.tv/?channel=${stream.user_login}&parent=${parentDomain}&autoplay=true&muted=false&volume=0.5`;
      playerEmbed.width = '100%';
      playerEmbed.height = '100%';
      playerEmbed.allowFullscreen = true;
      playerEmbed.frameBorder = '0';
      playerEmbed.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
      playerRef.current.innerHTML = '';
      playerRef.current.appendChild(playerEmbed);
    }

    // Create Twitch chat embed
    const chatEmbed = document.createElement('iframe');
    chatEmbed.src = `https://www.twitch.tv/embed/${stream.user_login}/chat?parent=${parentDomain}&darkpopout`;
    chatEmbed.width = '100%';
    chatEmbed.height = '100%';
    chatEmbed.frameBorder = '0';
    chatRef.current.appendChild(chatEmbed);

    // Reset mute state when switching streams
    setIsMuted(false);
  }, [stream]);

  // Handle mute toggle using Twitch Embed API
  const toggleMute = () => {
    const newMutedState = !isMuted;
    setIsMuted(newMutedState);

    if (embedRef.current) {
      try {
        const player = embedRef.current.getPlayer();
        player.setMuted(newMutedState);
        if (!newMutedState) {
          player.setVolume(0.5);
        }
      } catch (err) {
        console.error('Failed to toggle mute:', err);
      }
    } else {
      // Fallback: try iframe postMessage
      const iframe = playerRef.current?.querySelector('iframe');
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage(
          JSON.stringify({
            method: 'setMuted',
            args: [newMutedState]
          }),
          '*'
        );
        iframe.contentWindow.postMessage(
          JSON.stringify({
            method: 'setVolume',
            args: [newMutedState ? 0 : 0.5]
          }),
          '*'
        );
      }
    }
  };

  if (!stream) {
    return (
      <div className="stream-player-container">
        <div className="no-stream-selected">
          <div className="no-stream-content">
            <h1>Twitch Chat Viewer</h1>
            <p>Monitoring top 100 streams by chat activity</p>
            <div className="instructions">
              <p><strong>How it works:</strong></p>
              <p>• Tracks chat messages per second for top 100 live streams</p>
              <p>• Ranks streams by chat activity</p>
              <p>• Click any stream on the left to watch</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stream-player-container">
      <div className="stream-header">
        <div className="stream-header-info">
          <h1>{stream.user_name}</h1>
          <p>{stream.title}</p>
        </div>
        <div className="stream-header-stats">
          {sidebarHidden && (
            <button
              className="mute-toggle"
              onClick={onToggleSidebar}
              title="Show sidebar"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <path d="M3 2h14v16H3V2zm2 2v12h3V4H5z"/>
                <path d="M9 6l4 4-4 4" stroke="currentColor" strokeWidth="2" fill="none"/>
              </svg>
            </button>
          )}
          <button
            className="mute-toggle"
            onClick={() => {
              const container = document.querySelector('.app');
              if (isFullscreen) {
                document.exitFullscreen();
              } else if (container) {
                (container as HTMLElement).requestFullscreen();
              }
            }}
            title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {isFullscreen ? (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <path d="M3 3h5v2H5v3H3V3zm9 0h5v5h-2V5h-3V3zM3 12h2v3h3v2H3v-5zm14 0h2v5h-5v-2h3v-3z"/>
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <path d="M3 3h5v2H6v2H4V3zm9 0h5v4h-2V5h-3V3zM4 11h2v2h2v2H3v-5h1zm11 0h2v4h-5v-2h3v-2z"/>
              </svg>
            )}
          </button>
          <button
            className="mute-toggle mute-btn"
            onClick={toggleMute}
            title={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted ? (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <path d="M7.5 3.5L4 7H1v6h3l3.5 3.5v-13zM15 10l2.5-2.5-1-1L14 9l-2.5-2.5-1 1L13 10l-2.5 2.5 1 1L14 11l2.5 2.5 1-1L15 10z"/>
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
                <path d="M7.5 3.5L4 7H1v6h3l3.5 3.5v-13zM14 10c0-1.5-1-3-2.5-3.5v7c1.5-.5 2.5-2 2.5-3.5zM11.5 2v1.5c2.5.5 4.5 3 4.5 6s-2 5.5-4.5 6V17c3.5-.5 6-4 6-7s-2.5-6.5-6-7z"/>
              </svg>
            )}
          </button>
          <span className="badge game">{stream.game_name}</span>
          <span style={{
            background: 'linear-gradient(135deg, #7c3aed 0%, #6d28d9 100%)',
            color: 'white',
            padding: '5px 12px',
            borderRadius: '20px',
            fontSize: '11px',
            fontWeight: 600,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px'
          }} title="Viewer count">
            👁️ {stream.viewer_count.toLocaleString()}
          </span>
          <span className="stat-badge stat-current" style={{
            background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
            color: 'white',
            padding: '5px 12px',
            borderRadius: '20px',
            fontSize: '11px',
            fontWeight: 600,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px'
          }} title="Last 10 seconds">
            <span className="stat-icon">⚡</span>
            <span className="stat-value">{stream.chatRate10s?.toFixed(1) || '0.0'}/s</span>
          </span>
          <span style={{
            background: 'linear-gradient(135deg, #64748b 0%, #475569 100%)',
            color: 'white',
            padding: '5px 12px',
            borderRadius: '20px',
            fontSize: '11px',
            fontWeight: 600,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px'
          }} title="Last 5 minutes average">
            📊 {stream.chatRate5m?.toFixed(1) || '0.0'}/s
          </span>
          <span className="stat-badge stat-heat" style={{
            background: stream.chatRate5m && stream.chatRate10s && stream.chatRate10s > stream.chatRate5m * 5
              ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)'
              : stream.chatRate5m && stream.chatRate10s && stream.chatRate10s > stream.chatRate5m * 3
              ? 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)'
              : stream.chatRate5m && stream.chatRate10s && stream.chatRate10s > stream.chatRate5m * 2
              ? 'linear-gradient(135deg, #eab308 0%, #ca8a04 100%)'
              : 'linear-gradient(135deg, #71717a 0%, #52525b 100%)',
            color: 'white',
            padding: '5px 12px',
            borderRadius: '20px',
            fontSize: '11px',
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            boxShadow: stream.chatRate5m && stream.chatRate10s && stream.chatRate10s > stream.chatRate5m * 2
              ? '0 0 10px rgba(234, 179, 8, 0.4)'
              : 'none'
          }} title="Heat ratio: 10s vs 5m average">
            <span className="stat-icon">🔥</span>
            <span className="stat-value">{stream.chatRate5m && stream.chatRate5m > 0 ? ((stream.chatRate10s || 0) / stream.chatRate5m).toFixed(1) : '0.0'}x</span>
          </span>
          <button
            className="blacklist-btn"
            onClick={onBlacklistCurrent}
            title="Blacklist this stream from auto-switch"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
              <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
            </svg>
            Blacklist
          </button>
          <Settings
            timeWindow={timeWindow}
            switchMode={switchMode}
            threshold={threshold}
            languageFilter={languageFilter}
            cooldown={cooldown}
            minChatRate={minChatRate}
            gameBlacklist={gameBlacklist}
            streamBlacklist={streamBlacklist}
            favoriteStream={favoriteStream}
            streamSource={streamSource}
            customStreams={customStreams}
            autoSwitchBehavior={autoSwitchBehavior}
            spamFilter={spamFilter}
            isLoggedIn={isLoggedIn}
            sessionId={sessionId}
            onTimeWindowChange={onTimeWindowChange}
            onSwitchModeChange={onSwitchModeChange}
            onThresholdChange={onThresholdChange}
            onLanguageFilterChange={onLanguageFilterChange}
            onCooldownChange={onCooldownChange}
            onMinChatRateChange={onMinChatRateChange}
            onGameBlacklistChange={onGameBlacklistChange}
            onStreamBlacklistChange={onStreamBlacklistChange}
            onFavoriteStreamChange={onFavoriteStreamChange}
            onStreamSourceChange={onStreamSourceChange}
            onCustomStreamsChange={onCustomStreamsChange}
            onAutoSwitchBehaviorChange={onAutoSwitchBehaviorChange}
            onSpamFilterChange={onSpamFilterChange}
          />
        </div>
      </div>
      <div className="cooldown-progress-container">
        <div className="cooldown-progress-bar" style={{ width: `${cooldownProgress}%` }} />
        {cooldownProgress < 100 && (
          <div className="cooldown-text">
            {`Cooldown: ${Math.ceil(cooldown - (cooldown * cooldownProgress / 100))}s`}
          </div>
        )}
      </div>
      <div className="stream-content">
        <div className="stream-player" ref={playerRef}></div>
        <div className="stream-chat" ref={chatRef}></div>
      </div>
    </div>
  );
};
