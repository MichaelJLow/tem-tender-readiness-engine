'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function NavItems() {
  const pathname = usePathname();
  const queueActive = pathname === '/';
  const intakeActive = pathname === '/intake-pack' || pathname.startsWith('/intake-pack/');
  const performanceActive = pathname.startsWith('/performance');

  return (
    <nav className="nav-list" aria-label="Main navigation">
      <Link
        href="/"
        className={`nav-item${queueActive ? ' active' : ''}`}
        aria-current={queueActive ? 'page' : undefined}
      >
        <span>▦</span> Queue
      </Link>
      <Link
        href="/intake-pack"
        className={`nav-item${intakeActive ? ' active' : ''}`}
        aria-current={intakeActive ? 'page' : undefined}
      >
        <span>▤</span> Intake pack
      </Link>
      <Link
        href="/performance"
        className={`nav-item${performanceActive ? ' active' : ''}`}
        aria-current={performanceActive ? 'page' : undefined}
      >
        <span>◷</span> Performance
      </Link>
    </nav>
  );
}
