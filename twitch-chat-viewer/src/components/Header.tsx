import React from 'react';
import './Header.css';

interface HeaderProps {
  onToggleSidebar?: () => void;
  sidebarVisible?: boolean;
  sharedListOwner?: string | null;
}

export const Header: React.FC<HeaderProps> = ({ onToggleSidebar, sidebarVisible, sharedListOwner }) => {
  return (
    <header className="twitch-header">
      <div className="header-left">
        {onToggleSidebar && (
          <button className="mobile-menu-btn" onClick={onToggleSidebar} title={sidebarVisible ? "Close menu" : "Open menu"}>
            {sidebarVisible ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            ) : (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12h18M3 6h18M3 18h18" />
              </svg>
            )}
          </button>
        )}
        {sharedListOwner && (
          <span style={{ marginLeft: '12px', color: '#9146FF', fontSize: '14px' }}>
            Viewing <strong>@{sharedListOwner}</strong>'s list
          </span>
        )}
      </div>
      <div className="header-right">
        <a
          href="/party"
          className="watchparty-entry"
          title="Watch Twitch VODs & clips with friends"
        >
          🎬 Watch Party
        </a>
      </div>
    </header>
  );
};
