import Link from 'next/link';
import { apiGet, displayDate, type QueueItem } from '../src/api';

export const dynamic = 'force-dynamic';

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ route?: string; review?: string }>;
}) {
  const filters = await searchParams;
  let items: QueueItem[] = [];
  let error = '';
  try {
    const response = await apiGet<{ items: QueueItem[] }>('/tenders');
    items = response.items;
  } catch {
    error = 'Cannot reach the Tender API. Start it with npm run dev:api and reload this page.';
  }

  const filtered = items.filter((item) => {
    if (filters.route && filters.route !== 'ALL' && item.route !== filters.route) return false;
    if (
      filters.review === 'OPEN' &&
      !(item.route === 'HUMAN_REVIEW' && item.reviewState === 'OPEN')
    )
      return false;
    return true;
  });
  const openReviews = items.filter(
    (item) => item.route === 'HUMAN_REVIEW' && item.reviewState === 'OPEN',
  ).length;
  const ready = items.filter((item) => item.route === 'READY_FOR_PRICING').length;

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">TENDER OPERATIONS</span>
          <h1>Queue</h1>
          <p>Monitor incoming tenders and work through cases that need a decision.</p>
        </div>
        <span className="pill pill-neutral">{items.length} total cases</span>
      </div>
      {error ? (
        <div className="notice notice-error">
          <strong>API unavailable</strong>
          <span>{error}</span>
        </div>
      ) : null}
      <div className="stat-grid">
        <article className="stat-card">
          <span>Open human reviews</span>
          <strong>{openReviews}</strong>
          <small>Require operator attention</small>
        </article>
        <article className="stat-card">
          <span>Ready for pricing</span>
          <strong>{ready}</strong>
          <small>Automatic route only</small>
        </article>
        <article className="stat-card">
          <span>All tender runs</span>
          <strong>{items.length}</strong>
          <small>Stored in local API state</small>
        </article>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>All cases</h2>
            <p>Business route, processing status, and review state are shown separately.</p>
          </div>
          <Link className="text-link" href="/performance">
            View eval performance →
          </Link>
        </div>
        <div className="filter-row" aria-label="Queue filters">
          <Link className={`filter-chip ${!filters.review ? 'selected' : ''}`} href="/">
            All cases
          </Link>
          <Link
            className={`filter-chip ${filters.review === 'OPEN' ? 'selected' : ''}`}
            href="/?review=OPEN"
          >
            Open reviews
          </Link>
          {(
            ['ALL', 'READY_FOR_PRICING', 'NEEDS_INFORMATION', 'HUMAN_REVIEW', 'DUPLICATE'] as const
          ).map((route) => (
            <Link
              className={`filter-chip ${filters.route === route ? 'selected' : ''}`}
              href={route === 'ALL' ? '/' : `/?route=${route}`}
              key={route}
            >
              {route === 'ALL' ? 'All routes' : route.replaceAll('_', ' ')}
            </Link>
          ))}
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tender</th>
                <th>Business route</th>
                <th>Processing</th>
                <th>Review</th>
                <th>Received</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.runId}>
                  <td>
                    <strong>{item.tenderId}</strong>
                    <small className="subline">Run {item.runId.slice(0, 8)}</small>
                  </td>
                  <td>
                    <span className={`pill ${routeClass(item.route)}`}>
                      {item.route?.replaceAll('_', ' ') ?? 'No final route'}
                    </span>
                  </td>
                  <td>
                    <span className={`status-dot status-${item.status.toLowerCase()}`} />
                    {item.status}
                  </td>
                  <td>
                    {item.route === 'HUMAN_REVIEW' ? (
                      <span
                        className={`pill ${item.reviewState === 'OPEN' ? 'pill-review' : 'pill-success'}`}
                      >
                        {item.reviewState === 'OPEN' ? 'Open' : 'Resolved'}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>{displayDate(item.createdAt)}</td>
                  <td>
                    <Link className="row-link" href={`/tenders/${item.runId}`}>
                      Open case <span aria-hidden="true">→</span>
                    </Link>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 ? (
                <tr>
                  <td className="empty-cell" colSpan={6}>
                    {error
                      ? 'Cases appear here when the API is available.'
                      : 'No cases match these filters yet.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
      <p className="fine-print">
        Local demonstration using synthetic tender data. Human review records a disposition; it does
        not create a pricing handoff.
      </p>
    </>
  );
}

function routeClass(route: string | null): string {
  if (route === 'READY_FOR_PRICING') return 'pill-success';
  if (route === 'HUMAN_REVIEW') return 'pill-review';
  if (route === 'NEEDS_INFORMATION') return 'pill-warning';
  if (route === 'DUPLICATE') return 'pill-neutral';
  return 'pill-neutral';
}
