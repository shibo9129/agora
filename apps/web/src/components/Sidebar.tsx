import type React from 'react';
import { AgoraLogo } from './AgoraLogo';
import { SettingsPanel } from '../settings/SettingsPanel';

export type PageId = 'usage' | 'kb' | 'tools' | 'memory';

const NAV_ITEMS: { id: PageId; label: string; icon: React.ReactNode }[] = [
  {
    id: 'usage',
    label: '用量看板',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3v18h18" />
        <path d="M7 15v3M12 10v8M17 5v13" />
      </svg>
    ),
  },
  {
    id: 'kb',
    label: '知识库',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13z" />
        <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
      </svg>
    ),
  },
  {
    id: 'tools',
    label: '工具中心',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.1-2.1 2.7-2.5z" />
      </svg>
    ),
  },
  {
    id: 'memory',
    label: '记忆中枢',
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="2.5" />
        <path d="M12 4.5a7.5 7.5 0 0 1 7.5 7.5M12 9a3 3 0 0 1 3 3" opacity="0.7" />
        <path d="M12 19.5A7.5 7.5 0 0 1 4.5 12" opacity="0.7" />
      </svg>
    ),
  },
];

export function Sidebar({ page, onNavigate }: { page: PageId; onNavigate: (p: PageId) => void }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <AgoraLogo size={30} />
        <div className="sidebar-brand-text">
          <div className="sidebar-brand-name">Agora</div>
          <div className="sidebar-brand-sub">本地 AI 中枢</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        <div className="sidebar-section">中枢</div>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={`sidebar-item ${page === item.id ? 'sidebar-item-active' : ''}`}
          >
            <span className="sidebar-item-icon">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <SettingsPanel />
        <span className="sidebar-version">v0.1.2</span>
      </div>
    </aside>
  );
}
