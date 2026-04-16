import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Header } from './components/Header';
import { StreamList } from './components/StreamList';
import { StreamPlayer } from './components/StreamPlayer';
import { StatsPanel } from './components/StatsPanel';
import { WatchParty } from './components/WatchParty';
import { TimeWindow, SwitchMode, StreamSource, AutoSwitchBehavior, SpamFilterSettings, loadSettings } from './components/Settings';
import { getTopStreams, getAuthUrl, getUser, logout, getFollowedStreams, getRecommendedStreams, TwitchUser, trackConnect, trackDisconnect } from './services/twitchApi';
import { chatMonitor } from './services/chatMonitor';
import { StreamWithChatRate } from './types';
import './App.css';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';

// Curated recommendation list for auto-switch
const REC_STREAMERS = new Set([
  'quin69', 'summit1g', 'robcdee', 'day9tv', 'anniefuchsia', 'willneff',
  'hasanabi', 'nmplol', 'trainwreckstv', 'zackrawrr', 'nl_kripp', 'forsen',
  'cohhcarnage', 'bikeman', 'itmejp', 'sodapoppin', 'towelliee', 'lirik',
  'xqc', 'maya'
]);

const App: React.FC = () => {
  const [streams, setStreams] = useState<StreamWithChatRate[]>([]);
  const [followedStreams, setFollowedStreams] = useState<StreamWithChatRate[]>([]);
  const [selectedStream, setSelectedStream] = useState<StreamWithChatRate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<TwitchUser | null>(null);
  const [session, setSession] = useState<string | null>(() => localStorage.getItem('twitch_session'));
  const [sharedListOwner, setSharedListOwner] = useState<string | null>(null);
  const [sharedListLoading, setSharedListLoading] = useState(() => window.location.pathname.startsWith('/@'));

  // Settings state - load from localStorage
  const savedSettings = loadSettings();
  const [timeWindow, setTimeWindow] = useState<TimeWindow>(savedSettings?.timeWindow || '5s');
  const [switchMode, setSwitchMode] = useState<SwitchMode>(savedSettings?.switchMode || 'threshold');
  const [threshold, setThreshold] = useState(savedSettings?.threshold || 2.5);
  const [languageFilter, setLanguageFilter] = useState(savedSettings?.languageFilter || 'en');
  const [cooldown, setCooldown] = useState(savedSettings?.cooldown || 40);
  const [minChatRate, setMinChatRate] = useState(savedSettings?.minChatRate || 2.5);
  const [gameBlacklist, setGameBlacklist] = useState<string[]>(savedSettings?.gameBlacklist || []);
  const [streamBlacklist, setStreamBlacklist] = useState<string[]>(savedSettings?.streamBlacklist || []);
  const [favoriteStream, setFavoriteStream] = useState(savedSettings?.favoriteStream || '');
  const [streamSource, setStreamSource] = useState<StreamSource>(savedSettings?.streamSource || 'top');
  const [customStreams, setCustomStreams] = useState<string[]>(savedSettings?.customStreams || []);
  const [autoSwitchBehavior, setAutoSwitchBehavior] = useState<AutoSwitchBehavior>(savedSettings?.autoSwitchBehavior || 'auto');
  const [spamFilter, setSpamFilter] = useState<SpamFilterSettings>(savedSettings?.spamFilter || { filterVotes: true, filterCommands: true });
  const [cooldownProgress, setCooldownProgress] = useState(0);
  const [sidebarHidden, setSidebarHidden] = useState(() => window.innerWidth <= 768);
  const [showGuide, setShowGuide] = useState(() => !localStorage.getItem('guideShown'));

  // Popup switch suggestion state
  const [suggestedStream, setSuggestedStream] = useState<StreamWithChatRate | null>(null);
  const [popupTimeLeft, setPopupTimeLeft] = useState(0);
  const popupTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Track dismissed streams (stream id -> dismiss timestamp)
  const dismissedStreamsRef = useRef<Map<string, number>>(new Map());

  // Last switch timestamp for cooldown (initialize to current time minus cooldown)
  const lastSwitchTime = useRef<number>(Date.now() - (savedSettings?.cooldown || 30) * 1000);

  // Track selected stream for favorite return logic
  const selectedStreamRef = useRef<StreamWithChatRate | null>(null);

  // Track followed streams for auto-switch
  const followedStreamsRef = useRef<StreamWithChatRate[]>([]);


  useEffect(() => {
    selectedStreamRef.current = selectedStream;
  }, [selectedStream]);

  // Track visitor connection with heartbeat
  useEffect(() => {
    let visitorId = localStorage.getItem('visitor_id');

    trackConnect(visitorId || undefined, selectedStreamRef.current?.user_login).then(result => {
      if (result.visitorId && !visitorId) {
        localStorage.setItem('visitor_id', result.visitorId);
        visitorId = result.visitorId;
      }
    });

    // Heartbeat every 15 seconds to keep connection alive
    const heartbeat = setInterval(() => {
      if (visitorId) {
        trackConnect(visitorId, selectedStreamRef.current?.user_login);
      }
    }, 15000);

    // Track disconnect on page unload
    const handleUnload = () => {
      if (visitorId) {
        const blob = new Blob([JSON.stringify({ visitorId })], { type: 'application/json' });
        navigator.sendBeacon(`${process.env.REACT_APP_API_URL || ''}/api/disconnect`, blob);
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => {
      clearInterval(heartbeat);
      window.removeEventListener('beforeunload', handleUnload);
      if (visitorId) {
        trackDisconnect(visitorId);
      }
    };
  }, []);

  useEffect(() => {
    followedStreamsRef.current = followedStreams;
  }, [followedStreams]);


  // Use refs for settings to avoid recreating callback
  const settingsRef = useRef({
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
  });

  useEffect(() => {
    settingsRef.current = {
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
    };
  }, [timeWindow, switchMode, threshold, languageFilter, cooldown, minChatRate, gameBlacklist, streamBlacklist, favoriteStream, streamSource, customStreams, autoSwitchBehavior]);

  // Handle OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionParam = params.get('session');
    if (sessionParam) {
      setSession(sessionParam);
      localStorage.setItem('twitch_session', sessionParam);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // Handle /@username shared list routes - load before anything else
  useEffect(() => {
    const path = window.location.pathname;
    if (path.startsWith('/@')) {
      const handle = path.slice(2); // Remove /@
      if (handle) {
        fetch(`${API_BASE}/api/list/${handle}`)
          .then(res => res.json())
          .then(data => {
            if (data.streams && data.streams.length > 0) {
              setCustomStreams(data.streams);
              setStreamSource('custom');
              setSharedListOwner(handle);
            }
          })
          .catch(() => {})
          .finally(() => setSharedListLoading(false));
      } else {
        setSharedListLoading(false);
      }
    }
  }, []);

  // Load user on mount if session exists
  useEffect(() => {
    if (session) {
      getUser(session).then(u => {
        if (u) {
          setUser(u);
        } else {
          // Invalid session
          setSession(null);
          localStorage.removeItem('twitch_session');
        }
      });
    }
  }, [session]);

  // Fetch followed streams when user is logged in
  const fetchFollowedStreams = useCallback(async () => {
    if (!session) return;
    const followed = await getFollowedStreams(session);
    const seen = new Set<string>();
    const deduped = followed.filter(stream => {
      const key = stream.user_login.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const followedWithChatRate: StreamWithChatRate[] = deduped.map(stream => ({
      ...stream,
      chatRate: 0,
      messageCount: 0,
    }));
    // Also monitor followed streams chat (in parallel) - mark as priority
    await Promise.all(deduped.map(stream => chatMonitor.startMonitoring(stream.user_login, true)));
    setFollowedStreams(followedWithChatRate);
  }, [session]);

  useEffect(() => {
    if (user && session) {
      fetchFollowedStreams();
      // Refresh followed streams every 2 minutes
      const interval = setInterval(fetchFollowedStreams, 2 * 60 * 1000);
      return () => clearInterval(interval);
    }
  }, [user, session, fetchFollowedStreams]);

  // Monitor custom streams with priority when they change
  useEffect(() => {
    if (customStreams.length > 0) {
      // Start monitoring all custom streams as priority
      Promise.all(customStreams.map(channel => chatMonitor.startMonitoring(channel, true)));
    }
  }, [customStreams]);

  // Monitor Rec streamers with priority on mount
  useEffect(() => {
    // Start monitoring all Rec streamers as priority (over top 100)
    Promise.all(Array.from(REC_STREAMERS).map(channel => chatMonitor.startMonitoring(channel, true)));
  }, []);

  const handleLogin = async () => {
    const url = await getAuthUrl();
    window.location.href = url;
  };

  const handleLogout = async () => {
    if (session) {
      await logout(session);
      setSession(null);
      setUser(null);
      setFollowedStreams([]);
      localStorage.removeItem('twitch_session');
    }
  };

  const fetchStreams = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      
      let fetchedStreams: StreamWithChatRate[] = [];
      
      if (settingsRef.current.streamSource === 'recommended') {
         const recStreams = await getRecommendedStreams(session || '', settingsRef.current.languageFilter);
         fetchedStreams = recStreams.map(s => ({ ...s, chatRate: 0, messageCount: 0 }));
      } else {
         const topStreams = await getTopStreams(100, settingsRef.current.languageFilter);
         fetchedStreams = topStreams.map(stream => ({
            ...stream,
            chatRate: 0,
            messageCount: 0,
          }));
      }

      // Start monitoring chat for fetched streams (non-priority, will be kicked for followed/custom)
      // Use individual startMonitoring calls instead of updateChannels to preserve priority channels
      await Promise.all(fetchedStreams.map(stream => chatMonitor.startMonitoring(stream.user_login, false)));

      setStreams(fetchedStreams);

      // Select first stream if no stream is selected
      // If visiting /@handle, always use first from shared list
      // Otherwise respect user's saved settings (followed starts with followed, etc.)
      setSelectedStream(prev => {
        if (!prev && fetchedStreams.length > 0) {
          const currentSettings = settingsRef.current;
          const isSharedList = window.location.pathname.startsWith('/@');

          // For shared list URLs, always select first custom stream
          if (isSharedList && currentSettings.customStreams.length > 0) {
            const firstCustom = currentSettings.customStreams[0].toLowerCase();
            const customStream = fetchedStreams.find(s => s.user_login.toLowerCase() === firstCustom);
            if (customStream) return customStream;
            // If not in top streams, create a placeholder
            return {
              id: firstCustom,
              user_id: '',
              user_login: firstCustom,
              user_name: firstCustom,
              game_id: '',
              game_name: '',
              type: 'live',
              title: 'Loading...',
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
          }

          // For followed streams setting, select first followed
          if (currentSettings.streamSource === 'followed' && followedStreamsRef.current.length > 0) {
            return followedStreamsRef.current[0];
          }

          // Default to first top stream
          return fetchedStreams[0];
        }
        return prev;
      });

      setLoading(false);
    } catch (err) {
      console.error('Error fetching streams:', err);
      setError('Failed to fetch streams. Please check the backend server.');
      setLoading(false);
    }
  }, [session]);

  // Helper function to update a stream with chat rate metrics from frontend WebSocket
  const updateStreamWithMetrics = useCallback((stream: StreamWithChatRate): StreamWithChatRate => {
    // Get metrics directly from frontend chat monitor (already has 10s and 5m rates)
    const metric = chatMonitor.getMetrics(stream.user_login);

    const chatRate10s = metric?.chatRate10s || 0;
    const chatRate5m = metric?.chatRate5m || 0;
    const currentChatRate = chatRate10s;

    // Calculate average chat rate based on time window
    let averageChatRate = currentChatRate;
    if (settingsRef.current.timeWindow === '5m') {
      averageChatRate = chatRate5m;
    }

    return {
      ...stream,
      chatRate: averageChatRate,
      messageCount: metric?.messageCount || 0,
      chatRate10s,
      chatRate5m,
    };
  }, []);

  const updateChatRates = useCallback(async () => {
    try {
      const now = Date.now();

      // Update cooldown progress
      const timeSinceLastSwitch = (now - lastSwitchTime.current) / 1000; // in seconds
      const progress = Math.min((timeSinceLastSwitch / settingsRef.current.cooldown) * 100, 100);
      setCooldownProgress(progress);

      // Also update followed streams with chat rate metrics
      if (followedStreamsRef.current.length > 0) {
        const updatedFollowed = followedStreamsRef.current.map(stream =>
          updateStreamWithMetrics(stream)
        );
        setFollowedStreams(updatedFollowed);
        followedStreamsRef.current = updatedFollowed;
      }

      setStreams(prevStreams => {
        const updatedStreams = prevStreams.map(stream =>
          updateStreamWithMetrics(stream)
        );

        // Sort all streams for sidebar display (no filters applied here)
        const sortedStreams = [...updatedStreams].sort((a, b) => {
          if (settingsRef.current.switchMode === 'threshold' && a.chatRate5m && b.chatRate5m && a.chatRate5m > 0 && b.chatRate5m > 0) {
            // Sort by heat ratio (10s / 5m average)
            const heatA = (a.chatRate10s || 0) / a.chatRate5m;
            const heatB = (b.chatRate10s || 0) / b.chatRate5m;
            return heatB - heatA;
          }
          // Default: sort by chat rate
          return b.chatRate - a.chatRate;
        });

        // Apply filters for auto-switch only
        // Select stream pool based on streamSource setting
        let filteredForSwitch: StreamWithChatRate[];
        if (settingsRef.current.streamSource === 'followed' && followedStreamsRef.current.length > 0) {
          filteredForSwitch = followedStreamsRef.current;
        } else if (settingsRef.current.streamSource === 'recommended') {
          // Curated rec list - only include streamers from REC_STREAMERS
          filteredForSwitch = [...updatedStreams, ...followedStreamsRef.current].filter(s =>
            REC_STREAMERS.has(s.user_login.toLowerCase())
          );
        } else if (settingsRef.current.streamSource === 'custom' && settingsRef.current.customStreams.length > 0) {
          // Filter to only include streams from customStreams list
          const customStreamSet = new Set(settingsRef.current.customStreams.map(s => s.toLowerCase()));
          filteredForSwitch = [...updatedStreams, ...followedStreamsRef.current].filter(stream =>
            customStreamSet.has(stream.user_login.toLowerCase())
          );
        } else {
          filteredForSwitch = updatedStreams;
        }

        // Filter by language if not "all"
        if (settingsRef.current.languageFilter !== 'all') {
          filteredForSwitch = filteredForSwitch.filter(stream =>
            stream.language === settingsRef.current.languageFilter
          );
        }

        // Filter by minimum chat rate
        if (settingsRef.current.minChatRate > 0) {
          filteredForSwitch = filteredForSwitch.filter(stream =>
            stream.chatRate >= settingsRef.current.minChatRate
          );
        }

        // Filter out blacklisted games
        if (settingsRef.current.gameBlacklist.length > 0) {
          filteredForSwitch = filteredForSwitch.filter(stream =>
            !settingsRef.current.gameBlacklist.includes(stream.game_name)
          );
        }

        // Filter out blacklisted streams
        if (settingsRef.current.streamBlacklist.length > 0) {
          filteredForSwitch = filteredForSwitch.filter(stream =>
            !settingsRef.current.streamBlacklist.includes(stream.user_login.toLowerCase())
          );
        }

        // Auto-switch logic based on mode with cooldown
        const timeSinceLastSwitch = (now - lastSwitchTime.current) / 1000; // in seconds

        if (timeSinceLastSwitch >= settingsRef.current.cooldown) {
          let targetStream: StreamWithChatRate | null = null;

          // Try to find stream by mode (highest/random/threshold)
          if (filteredForSwitch.length > 0) {
            if (settingsRef.current.switchMode === 'highest') {
              // Sort by current chat rate (highest first)
              const streamsByChatRate = [...filteredForSwitch].sort((a, b) => {
                return b.chatRate - a.chatRate;
              });
              targetStream = streamsByChatRate[0];
            } else if (settingsRef.current.switchMode === 'random') {
              // Pick a random stream from the filtered list
              const randomIndex = Math.floor(Math.random() * filteredForSwitch.length);
              targetStream = filteredForSwitch[randomIndex];
            } else if (settingsRef.current.switchMode === 'threshold') {
              // Switch if last 10s chat rate > 5m average * threshold
              const streamsByThreshold = filteredForSwitch
                .filter(stream => {
                  // Use chatRate10s and chatRate5m from the stream object (calculated by chatMonitor)
                  const chatRate10s = stream.chatRate10s || 0;
                  const chatRate5m = stream.chatRate5m || 0;

                  if (chatRate5m === 0) return false;

                  // Check if last 10s > 5m average * threshold
                  return chatRate10s > chatRate5m * settingsRef.current.threshold;
                })
                .sort((a, b) => {
                  // Sort by highest heat ratio
                  const heatA = a.chatRate5m && a.chatRate5m > 0 ? (a.chatRate10s || 0) / a.chatRate5m : 0;
                  const heatB = b.chatRate5m && b.chatRate5m > 0 ? (b.chatRate10s || 0) / b.chatRate5m : 0;
                  return heatB - heatA;
                });

              if (streamsByThreshold.length > 0) {
                targetStream = streamsByThreshold[0];
              }
            }
          }

          // If no target found by mode, fallback to favorite stream
          if (!targetStream && settingsRef.current.favoriteStream) {
            // Search in all available streams
            const allStreams = [...updatedStreams, ...followedStreamsRef.current];
            const favStream = allStreams.find(s =>
              s.user_login.toLowerCase() === settingsRef.current.favoriteStream.toLowerCase()
            );
            if (favStream) {
              targetStream = favStream;
            }
          }

          // Switch to target stream if found and different from current
          if (targetStream) {
            // Clean up old dismissed entries (older than 5 minutes)
            const fiveMinutesAgo = now - 5 * 60 * 1000;
            dismissedStreamsRef.current.forEach((timestamp, id) => {
              if (timestamp < fiveMinutesAgo) {
                dismissedStreamsRef.current.delete(id);
              }
            });

            // Skip if this stream was dismissed in the last 5 minutes
            const dismissedAt = dismissedStreamsRef.current.get(targetStream.id);
            if (dismissedAt && now - dismissedAt < 5 * 60 * 1000) {
              return sortedStreams; // Skip this stream
            }

            setSelectedStream(prev => {
              if (!prev || prev.id !== targetStream!.id) {
                // Check if we should auto-switch or show popup
                if (settingsRef.current.autoSwitchBehavior === 'popup') {
                  // Show popup instead of auto-switching
                  setSuggestedStream(targetStream);
                  setPopupTimeLeft(10);
                  // Clear any existing timer
                  if (popupTimerRef.current) {
                    clearInterval(popupTimerRef.current);
                  }
                  // Start countdown
                  popupTimerRef.current = setInterval(() => {
                    setPopupTimeLeft(t => {
                      if (t <= 1) {
                        if (popupTimerRef.current) {
                          clearInterval(popupTimerRef.current);
                          popupTimerRef.current = null;
                        }
                        setSuggestedStream(null);
                        return 0;
                      }
                      return t - 1;
                    });
                  }, 1000);
                  return prev; // Don't switch, just show popup (cooldown resets only on actual switch)
                }
                lastSwitchTime.current = now;
                return targetStream;
              }
              return prev;
            });
          }
        }

        // Update selectedStream with fresh data (check top and followed streams)
        setSelectedStream(prev => {
          if (!prev) return prev;
          let updated = sortedStreams.find(s => s.id === prev.id);
          if (!updated && followedStreamsRef.current.length > 0) {
            updated = followedStreamsRef.current.find(s => s.id === prev.id);
          }
          return updated || prev;
        });

        return sortedStreams;
      });
    } catch (error) {
      console.error('Error updating chat rates:', error);
    }
  }, [updateStreamWithMetrics]);

  useEffect(() => {
    // Wait for shared list to load first
    if (sharedListLoading) return;

    fetchStreams();

    // Update chat rates every 2 seconds
    const interval = setInterval(() => {
      updateChatRates();
    }, 2000);

    // Refresh stream list every 5 minutes
    const refreshInterval = setInterval(() => {
      fetchStreams();
    }, 5 * 60 * 1000);

    return () => {
      clearInterval(interval);
      clearInterval(refreshInterval);
      chatMonitor.stopAll();
    };
  }, [fetchStreams, updateChatRates, sharedListLoading]);

  // Refetch streams when language filter or stream source changes
  useEffect(() => {
    if (sharedListLoading) return;
    fetchStreams();
  }, [languageFilter, streamSource, fetchStreams, sharedListLoading]);

  // Update chatMonitor spam filter when settings change
  useEffect(() => {
    chatMonitor.setSpamFilter(spamFilter);
  }, [spamFilter]);

  const handleStreamSelect = (stream: StreamWithChatRate) => {
    setSelectedStream(stream);
  };

  const handleBlacklistCurrent = () => {
    if (selectedStream && !streamBlacklist.includes(selectedStream.user_login.toLowerCase())) {
      setStreamBlacklist([...streamBlacklist, selectedStream.user_login.toLowerCase()]);
    }
  };

  // Confirm switch from popup
  const confirmSuggestedSwitch = useCallback(() => {
    if (suggestedStream) {
      setSelectedStream(suggestedStream);
      setSuggestedStream(null);
      setPopupTimeLeft(0);
      lastSwitchTime.current = Date.now(); // Reset cooldown on actual switch
      if (popupTimerRef.current) {
        clearInterval(popupTimerRef.current);
        popupTimerRef.current = null;
      }
    }
  }, [suggestedStream]);

  // Dismiss popup
  const dismissSuggestedSwitch = useCallback(() => {
    if (suggestedStream) {
      // Track dismissed stream for 5 minutes
      dismissedStreamsRef.current.set(suggestedStream.id, Date.now());
    }
    setSuggestedStream(null);
    setPopupTimeLeft(0);
    if (popupTimerRef.current) {
      clearInterval(popupTimerRef.current);
      popupTimerRef.current = null;
    }
  }, [suggestedStream]);

  // Hotkey handler for 'S' key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only trigger if not typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (e.key.toLowerCase() === 's' && suggestedStream) {
        e.preventDefault();
        confirmSuggestedSwitch();
      }
      if (e.key.toLowerCase() === 'd' && suggestedStream) {
        e.preventDefault();
        dismissSuggestedSwitch();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [suggestedStream, confirmSuggestedSwitch, dismissSuggestedSwitch]);

  if (loading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner"></div>
        <p>Loading top 100 Twitch streams...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app-error">
        <h2>Connection Error</h2>
        <p>{error}</p>
        <button onClick={fetchStreams}>Retry</button>
      </div>
    );
  }

  const handleMobileStreamSelect = (stream: StreamWithChatRate) => {
    handleStreamSelect(stream);
    // Auto-hide sidebar on mobile after selecting a stream
    if (window.innerWidth <= 768) {
      setSidebarHidden(true);
    }
  };

  const dismissGuide = () => {
    setShowGuide(false);
    localStorage.setItem('guideShown', 'true');
  };

  // Check if on /stats page
  if (window.location.pathname === '/stats') {
    return <StatsPanel />;
  }

  // Watch party mode: /party or /party/<roomId>
  if (window.location.pathname.startsWith('/party')) {
    const parts = window.location.pathname.split('/').filter(Boolean);
    const partyRoom = parts.length > 1 ? parts[1] : null;
    return <WatchParty initialRoomId={partyRoom} />;
  }

  return (
    <div className="app-container">
      {showGuide && (
        <div className="guide-overlay" onClick={dismissGuide}>
          <div className="guide-popup" onClick={e => e.stopPropagation()}>
            <h2>Welcome to pogchamp.tv!</h2>
            <div className="guide-content">
              <p><strong>Pogchamp automatically switches to the hottest streams on Twitch based on chat activity. Find new streams and catch all the best moments live.</strong></p>

              <div className="guide-section">
                <h3>How it works:</h3>
                <ul>
                  <li><span className="stat-icon-guide">⚡</span> <strong>Current</strong> - Chat messages per second (last 10s)</li>
                  <li><span className="stat-icon-guide">🔥</span> <strong>Heat</strong> - How much chat spiked vs 5-min average</li>
                  <li>When heat exceeds your threshold, the app auto-switches!</li>
                </ul>
              </div>

              <div className="guide-section">
                <h3>Favorite Stream:</h3>
                <ul>
                  <li>Set a favorite streamer in settings to return to when nothing's hot</li>
                  <li>Great for keeping a "home base" while catching peak moments elsewhere</li>
                </ul>
              </div>

              <div className="guide-section">
                <h3>Key Options:</h3>
                <ul>
                  <li><strong>Auto-Switch Mode</strong> - Highest (most active), Threshold (heat spike), or Random</li>
                  <li><strong>Switch Behavior</strong> - Auto (instant switch) or Popup (press S to confirm)</li>
                  <li><strong>Stream Source</strong> - Top 100, Followed (login required), or Custom list. Auto-switch only happens within your selected source</li>
                </ul>
              </div>

              <div className="guide-section">
                <h3>Fine-tuning:</h3>
                <ul>
                  <li><strong>Heat Threshold</strong> - How much chat must spike to trigger (2.5x = 250% of average)</li>
                  <li><strong>Cooldown</strong> - Minimum seconds between auto-switches</li>
                  <li><strong>Language</strong> - Filter streams by language</li>
                  <li><strong>Min Chat Rate</strong> - Only switch to streams with enough activity</li>
                  <li><strong>Stream Blacklist</strong> - Block specific streams from auto-switching</li>
                </ul>
              </div>

              <div className="guide-section guide-recommend">
                <h3>Recommended:</h3>
                <p><strong>Twitch Turbo</strong> - Ad-free viewing makes auto-switching seamless without interruptions!</p>
              </div>

              <div className="guide-section guide-links">
                <h3>Join the community:</h3>
                <div className="guide-social-links">
                  <a href="https://discord.gg/CSWHkcH8Ee" target="_blank" rel="noopener noreferrer" className="guide-social-btn discord">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
                    Discord
                  </a>
                  <a href="https://x.com/not_pr0" target="_blank" rel="noopener noreferrer" className="guide-social-btn twitter">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                    Twitter
                  </a>
                </div>
              </div>
            </div>
            <button className="guide-close-btn" onClick={dismissGuide}>Got it!</button>
          </div>
        </div>
      )}
      <Header
        onToggleSidebar={() => setSidebarHidden(!sidebarHidden)}
        sidebarVisible={!sidebarHidden}
        sharedListOwner={sharedListOwner}
      />
      <div className="app">
        {!sidebarHidden && (
          <>
            <div className="mobile-overlay" onClick={() => setSidebarHidden(true)} />
            <StreamList
              streams={streams}
              followedStreams={followedStreams}
              customStreams={customStreams}
              sharedListOwner={sharedListOwner}
              selectedStream={selectedStream}
              onStreamSelect={handleMobileStreamSelect}
              onToggleSidebar={() => setSidebarHidden(true)}
              user={user}
              onLogin={handleLogin}
              onLogout={handleLogout}
              onShowGuide={() => setShowGuide(true)}
            />
          </>
        )}
        <StreamPlayer
          stream={selectedStream}
          timeWindow={timeWindow}
          switchMode={switchMode}
          threshold={threshold}
          languageFilter={languageFilter}
          cooldown={cooldown}
          cooldownProgress={cooldownProgress}
          minChatRate={minChatRate}
          gameBlacklist={gameBlacklist}
          streamBlacklist={streamBlacklist}
          favoriteStream={favoriteStream}
          streamSource={streamSource}
          customStreams={customStreams}
          autoSwitchBehavior={autoSwitchBehavior}
          spamFilter={spamFilter}
          isLoggedIn={!!user}
          sessionId={session}
          sidebarHidden={sidebarHidden}
          onTimeWindowChange={setTimeWindow}
          onSwitchModeChange={setSwitchMode}
          onThresholdChange={setThreshold}
          onLanguageFilterChange={setLanguageFilter}
          onCooldownChange={setCooldown}
          onMinChatRateChange={setMinChatRate}
          onGameBlacklistChange={setGameBlacklist}
          onStreamBlacklistChange={setStreamBlacklist}
          onFavoriteStreamChange={setFavoriteStream}
          onStreamSourceChange={setStreamSource}
          onCustomStreamsChange={setCustomStreams}
          onAutoSwitchBehaviorChange={setAutoSwitchBehavior}
          onSpamFilterChange={setSpamFilter}
          onBlacklistCurrent={handleBlacklistCurrent}
          onToggleSidebar={() => setSidebarHidden(!sidebarHidden)}
        />
        {/* Switch suggestion popup - inside .app for fullscreen support */}
        {suggestedStream && (
          <div className="switch-popup">
            <div className="switch-popup-content">
              <img
                src={suggestedStream.thumbnail_url?.replace('{width}', '440').replace('{height}', '248') || ''}
                alt=""
                className="switch-popup-bg"
              />
              <div className="switch-popup-overlay">
                <div className="switch-popup-header">
                  <span className="switch-popup-fire">🔥</span>
                  <span>Hot Stream Detected!</span>
                  <span className="switch-popup-timer">{popupTimeLeft}s</span>
                </div>
                <div className="switch-popup-stream">
                  <div className="switch-popup-info">
                    <div className="switch-popup-name">{suggestedStream.user_name}</div>
                    <div className="switch-popup-game">{suggestedStream.game_name}</div>
                    <div className="switch-popup-stats">
                      <span>⚡ {suggestedStream.chatRate?.toFixed(1)}/s</span>
                      <span>🔥 {suggestedStream.chatRate5m && suggestedStream.chatRate5m > 0
                        ? ((suggestedStream.chatRate10s || 0) / suggestedStream.chatRate5m).toFixed(1)
                        : '0'}x</span>
                    </div>
                  </div>
                </div>
                <div className="switch-popup-actions">
                  <button className="switch-popup-btn switch-popup-confirm" onClick={confirmSuggestedSwitch}>
                    Switch (S)
                  </button>
                  <button className="switch-popup-btn switch-popup-dismiss" onClick={dismissSuggestedSwitch}>
                    Dismiss (D)
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
