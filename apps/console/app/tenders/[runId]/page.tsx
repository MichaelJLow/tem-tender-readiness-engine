import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiGet, displayDate, type RunDetail } from '../../../src/api';
import { ReviewForm } from './ReviewForm';

export const dynamic = 'force-dynamic';

export default async function TenderDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  let detail: RunDetail;
  try {
    detail = await apiGet<RunDetail>(`/tenders/${encodeURIComponent(runId)}`);
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('404')) notFound();
    return (
      <div className="error-page">
        <h1>Case unavailable</h1>
        <p>Start the Tender API and check the case link, then reload.</p>
        <Link className="text-link" href="/">
          ← Back to queue
        </Link>
      </div>
    );
  }

  const { run } = detail;
  const sourceIds = new Set(run.input.textSources.map((source) => source.sourceId));
  const reviewSourceIds = [
    ...new Set([
      ...run.input.textSources.map((source) => source.sourceId),
      ...run.input.tender.documents.map((document) => document.documentId),
      ...(run.result?.rules ?? [])
        .filter((rule) => !rule.passed && rule.severity !== 'info')
        .flatMap((rule) =>
          rule.evidence.flatMap((evidence) => (evidence.sourceId ? [evidence.sourceId] : [])),
        ),
    ]),
  ];
  const dateEvidenceRows = [
    ...run.input.tender.sites
      .filter((site) => site.contractEndDate)
      .map((site) => ({
        id: 'site-record-' + site.siteId,
        siteId: site.siteId,
        source: 'Submitted site record',
        value: site.contractEndDate ?? '',
        credible: true,
      })),
    ...run.input.signals.dateFacts.map((fact) => ({
      id: fact.factId,
      siteId: fact.siteId,
      source: fact.evidence
        .map((evidence) => evidence.sourceId + ' (' + evidence.sourceType.toLowerCase() + ')')
        .join(', '),
      value: fact.value,
      credible: fact.credible,
    })),
  ].sort((left, right) => left.siteId.localeCompare(right.siteId));
  const fieldValues = run.input.tender.sites
    .flatMap((site) => [
      { site: site.siteId, field: 'Address', value: site.address },
      { site: site.siteId, field: 'Meter identifier', value: site.meterIdentifier },
      {
        site: site.siteId,
        field: 'Annual consumption',
        value: site.annualConsumptionKwh?.toLocaleString('en-GB'),
      },
      { site: site.siteId, field: 'Contract end', value: site.contractEndDate },
    ])
    .filter((fact) => fact.value);

  return (
    <>
      <Link className="back-link" href="/">
        ← Back to queue
      </Link>
      <div className="detail-header page-heading">
        <div>
          <span className="eyebrow">TENDER DETAIL</span>
          <h1>{run.tenderId}</h1>
          <div className="detail-meta">
            Run {run.runId} · Received {displayDate(run.createdAt)}
            <br />
            Customer {run.input.tender.customer.legalName} · Broker{' '}
            {run.input.tender.broker.legalName}
          </div>
        </div>
        <div className="route-stack">
          <span className={`pill ${tone(run.route)}`}>
            {run.route?.replaceAll('_', ' ') ?? 'No final route'}
          </span>
          <span className="pill pill-neutral">{run.status}</span>
        </div>
      </div>
      {run.failure ? (
        <div className="notice notice-error">
          <strong>{run.failure.code}</strong>
          <span>
            {run.failure.message}{' '}
            {run.failure.retryable ? 'This failure is retryable.' : 'This failure is terminal.'}
          </span>
        </div>
      ) : null}
      <div className="two-column">
        <div>
          <section className="detail-card">
            <h2>Readiness checks</h2>
            {run.result?.rules.map((rule) => (
              <div className="rule-row" key={rule.ruleId}>
                <div className="rule-title">
                  <span>{rule.ruleId}</span>
                  <span
                    className={`pill ${rule.passed ? 'pill-success' : rule.severity === 'review' ? 'pill-review' : 'pill-warning'}`}
                  >
                    {rule.passed ? 'Passed' : rule.severity}
                  </span>
                </div>
                <p>{rule.reason}</p>
                {rule.evidence.map((evidence, index) => (
                  <small className="subline" key={`${evidence.sourceId ?? 'evidence'}-${index}`}>
                    Evidence: {evidence.sourceId ?? evidence.locator ?? 'structured tender data'}
                  </small>
                ))}
              </div>
            )) ?? <p className="muted">No completed readiness result is available.</p>}
          </section>
          <section className="detail-card">
            <h2>Submitted tender facts</h2>
            <div className="facts-list">
              {fieldValues.map((fact) => (
                <div className="fact" key={`${fact.site}-${fact.field}`}>
                  <span>
                    {fact.site} · {fact.field}
                  </span>
                  <strong>{fact.value}</strong>
                </div>
              ))}
            </div>
            {run.input.tender.documents.length > 0 ? (
              <div className="facts-list">
                {run.input.tender.documents.map((document) => (
                  <div className="fact" key={document.documentId}>
                    <span>Document · {document.documentId}</span>
                    <strong>{document.fileName}</strong>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
          {run.input.signals.dateFacts.length > 0 ? (
            <section className="detail-card">
              <h2>Contract end date evidence</h2>
              <p className="source-copy">
                Compare the submitted site date with recorded source facts. A source reference does
                not establish which date is authoritative.
              </p>
              <div className="facts-list date-evidence-list">
                {dateEvidenceRows.map((fact) => (
                  <div className="fact" key={fact.id}>
                    <span>
                      {fact.siteId} · {fact.source}
                      {fact.credible ? '' : ' · not marked credible'}
                    </span>
                    <strong>{fact.value}</strong>
                  </div>
                ))}
              </div>
              {run.input.tender.documents.length === 0 ? (
                <p className="fine-print">
                  The source references in this demo do not include the original contract files.
                </p>
              ) : null}
            </section>
          ) : null}
          <section className="detail-card">
            <h2>Source evidence</h2>
            {run.input.textSources.length === 0 ? (
              <p className="muted">This case has no submitted notes or extracted document text.</p>
            ) : (
              <div className="evidence-list">
                {run.input.textSources.map((source) => (
                  <article className="evidence-item" key={source.sourceId}>
                    <span className="source-label">
                      {source.sourceId} · {source.kind}
                    </span>
                    <p className="source-copy">{source.text}</p>
                  </article>
                ))}
              </div>
            )}
          </section>
          {run.interpretation ? (
            <section className="detail-card">
              <h2>AI evidence interpretation</h2>
              <p className="source-copy">
                {run.interpretation.summary ?? 'Structured interpretation available.'}
              </p>
              {run.interpretation.observations?.map((observation, index) => (
                <div className="rule-row" key={`${observation.field}-${index}`}>
                  <div className="rule-title">
                    <span>
                      {observation.field}: {observation.value}
                    </span>
                    <small>{observation.siteIds.join(', ') || 'No site attribution'}</small>
                  </div>
                  {observation.evidence.map((citation, citationIndex) => (
                    <blockquote
                      className="evidence-quote"
                      key={`${citation.sourceId}-${citationIndex}`}
                    >
                      “{citation.quote}”{' '}
                      <small>
                        — {citation.sourceId}
                        {sourceIds.has(citation.sourceId) ? '' : ' (source not in current input)'}
                      </small>
                    </blockquote>
                  ))}
                </div>
              ))}
            </section>
          ) : null}
          {run.modelTrace ? (
            <section className="detail-card">
              <h2>Model run</h2>
              <div className="version-row">
                <span className="version-tag">{run.modelTrace.model}</span>
                <span className="version-tag">{run.modelTrace.promptVersion}</span>
                <span className="version-tag">
                  {run.modelTrace.outcome} · {run.modelTrace.durationMs} ms
                </span>
              </div>
            </section>
          ) : null}
        </div>
        <aside>
          {run.route === 'HUMAN_REVIEW' ? (
            <section className="detail-card">
              <h2>
                Human review{' '}
                <span
                  className={`pill ${detail.reviewState === 'OPEN' ? 'pill-review' : 'pill-success'}`}
                >
                  {detail.reviewState}
                </span>
              </h2>
              <p className="source-copy">
                Record a reasoned disposition. This does not rewrite the automated decision or
                trigger pricing.
              </p>
              <ReviewForm
                runId={run.runId}
                state={detail.reviewState}
                version={detail.reviewVersion}
                sourceIds={reviewSourceIds}
              />
            </section>
          ) : (
            <section className="detail-card">
              <h2>Review</h2>
              <p className="source-copy">This route does not require a human-review action.</p>
            </section>
          )}
          <section className="detail-card">
            <h2>Review history</h2>
            {detail.reviewEvents.length === 0 ? (
              <p className="muted">No review events recorded.</p>
            ) : (
              <div className="timeline">
                {[...detail.reviewEvents].reverse().map((event) => (
                  <article className="timeline-item" key={event.eventId}>
                    <strong>{event.action.replaceAll('_', ' ')}</strong>
                    <small>
                      {event.actor} · {displayDate(event.createdAt)}
                    </small>
                    <p>{event.reason}</p>
                    {event.sourceIds.length ? (
                      <small>Evidence: {event.sourceIds.join(', ')}</small>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

function tone(route?: string): string {
  if (route === 'READY_FOR_PRICING') return 'pill-success';
  if (route === 'HUMAN_REVIEW') return 'pill-review';
  if (route === 'NEEDS_INFORMATION') return 'pill-warning';
  return 'pill-neutral';
}
