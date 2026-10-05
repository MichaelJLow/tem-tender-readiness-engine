import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { NavItems } from './NavItems';
import './styles.css';

export const metadata: Metadata = {
  title: 'Tender readiness | Operations',
  description: 'Local operations console for synthetic tender readiness cases.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <aside className="sidebar">
            <Link className="brand" href="/">
              <Image
                className="brand-mark"
                src="/tender-readiness-symbol.png"
                alt=""
                width={35}
                height={35}
                priority
              />
              <span>
                <strong>Tender readiness</strong>
                <small>Operations workspace</small>
              </span>
            </Link>
            <div className="nav-label">WORKSPACE</div>
            <NavItems />
            <div className="sidebar-bottom">
              <span className="online-dot" /> Local demo environment
              <small>Loopback API · synthetic data</small>
            </div>
          </aside>
          <main className="main-area">
            <header className="topbar">
              <span>Operations</span>
              <div className="operator">
                <span className="operator-avatar">D</span>
                <span>Demo operator</span>
              </div>
            </header>
            <div className="page-content">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
