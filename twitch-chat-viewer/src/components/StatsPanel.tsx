import React, { useState, useEffect, useMemo } from 'react';
import './StatsPanel.css';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';

interface UserStats {
  id: string;
  stream: string | null;
  watchTime: number;
  watchTimeFormatted: string;
  active: boolean;
}

interface Stats {
  activeUsers: number;
  totalVisitors: number;
  peakConnections: number;
  twitchLogins: string[];
  allUsers: UserStats[];
}

type SortKey = 'watchTime' | 'status' | 'stream';
type SortDir = 'asc' | 'desc';

export const StatsPanel: React.FC = () => {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>('watchTime');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/stats`);
        const data = await res.json();
        setStats(data);
      } catch (err) {
        console.error('Failed to fetch stats:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, []);

  const sortedUsers = useMemo(() => {
    if (!stats) return [];
    const users = [...stats.allUsers];

    users.sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'watchTime') {
        cmp = a.watchTime - b.watchTime;
      } else if (sortKey === 'status') {
        cmp = (a.active ? 1 : 0) - (b.active ? 1 : 0);
      } else if (sortKey === 'stream') {
        cmp = (a.stream || '').localeCompare(b.stream || '');
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });

    return users;
  }, [stats, sortKey, sortDir]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const getSortIndicator = (key: SortKey) => {
    if (sortKey !== key) return '';
    return sortDir === 'desc' ? ' ▼' : ' ▲';
  };

  if (loading) {
    return (
      <div className="stats-page">
        <div className="stats-panel">
          <div className="stats-loading">Loading...</div>
        </div>
      </div>
    );
  }

  if (!stats) {
    return null;
  }

  // Calculate total watch time
  const totalWatchTimeSec = stats.allUsers.reduce((sum, u) => sum + u.watchTime, 0);
  const totalHours = Math.floor(totalWatchTimeSec / 3600);
  const totalMins = Math.floor((totalWatchTimeSec % 3600) / 60);

  return (
    <div className="stats-page">
      <div className="stats-panel">
        <a href="/" className="stats-back">&larr; Back</a>
        <h2>Site Stats</h2>

        <div className="stats-summary">
          <div className="stat-box">
            <div className="stat-value">{stats.activeUsers}</div>
            <div className="stat-label">Online Now</div>
          </div>
          <div className="stat-box">
            <div className="stat-value">{stats.totalVisitors}</div>
            <div className="stat-label">Total Visitors</div>
          </div>
          <div className="stat-box">
            <div className="stat-value">{stats.peakConnections}</div>
            <div className="stat-label">Peak Users</div>
          </div>
          <div className="stat-box">
            <div className="stat-value">{totalHours}h {totalMins}m</div>
            <div className="stat-label">Total Watch Time</div>
          </div>
        </div>

        <h3>Watch Time Leaderboard</h3>
        <div className="stats-table-container">
          <table className="stats-table">
            <thead>
              <tr>
                <th>#</th>
                <th>User</th>
                <th className="sortable" onClick={() => handleSort('watchTime')}>
                  Watch Time{getSortIndicator('watchTime')}
                </th>
                <th className="sortable" onClick={() => handleSort('status')}>
                  Status{getSortIndicator('status')}
                </th>
                <th className="sortable" onClick={() => handleSort('stream')}>
                  Watching{getSortIndicator('stream')}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedUsers.map((user, index) => (
                <tr key={user.id} className={user.active ? 'active' : ''}>
                  <td>{index + 1}</td>
                  <td className="user-id">{user.id}</td>
                  <td>{user.watchTimeFormatted}</td>
                  <td>
                    <span className={`status-dot ${user.active ? 'online' : 'offline'}`}></span>
                    {user.active ? 'Online' : 'Offline'}
                  </td>
                  <td>{user.stream || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {stats.twitchLogins.length > 0 && (
          <>
            <h3>Twitch Logins ({stats.twitchLogins.length})</h3>
            <div className="twitch-logins">
              {stats.twitchLogins.map(login => (
                <span key={login} className="twitch-login">{login}</span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
