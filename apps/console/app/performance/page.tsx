import { apiGet, displayDate, percent, type EvalOverview, type MetricRun } from '../../src/api';

export const dynamic = 'force-dynamic';

export default async function PerformancePage() {
  let overview: EvalOverview;
  try {
    overview = await apiGet<EvalOverview>('/evals');
  } catch {
    return (
      <>
        <div className="page-heading">
          <div>
            <span className="eyebrow">EVALUATION EVIDENCE</span>
            <h1>Performance</h1>
            <p>Retained evaluation results and release safety gates.</p>
          </div>
        </div>
        <div className="notice notice-error">
          <strong>Reports unavailable</strong>
          <span>
            Start the Tender API and confirm its EVALS_DIR points at this repository’s evals
            directory.
          </span>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">EVALUATION EVIDENCE</span>
          <h1>Performance</h1>
          <p>Retained results from the agent and complete decision workflow.</p>
        </div>
        <span className="pill pill-neutral">Synthetic evals</span>
      </div>
      <div className="notice notice-info">
        <strong>How to read this page</strong>
        <span>
          The accepted baseline is the reviewed reference. The latest completed full run is shown
          separately; a passing run is not accepted automatically. Studio links are optional
          drill-down.
        </span>
      </div>
      <RunCard
        title="Accepted baseline"
        label="Reviewed reference"
        run={overview.accepted}
        studioBaseUrl={overview.studioBaseUrl}
      />
      {overview.latest ? (
        <RunCard
          title="Latest completed full run"
          label={
            overview.latest.runId === overview.accepted.runId
              ? 'Same as accepted baseline'
              : 'Not promoted to baseline'
          }
          run={overview.latest}
          studioBaseUrl={overview.studioBaseUrl}
          isLatest
        />
      ) : (
        <section className="detail-card">
          <h2>Latest full run</h2>
          <p className="muted">No completed release report is available.</p>
        </section>
      )}
      <p className="fine-print">
        Evals use synthetic cases. Their scores describe this labelled prototype dataset; they are
        not production performance claims.
      </p>
    </>
  );
}

function RunCard({
  title,
  label,
  run,
  studioBaseUrl,
  isLatest = false,
}: {
  title: string;
  label: string;
  run: MetricRun;
  studioBaseUrl: string;
  isLatest?: boolean;
}) {
  const routeMetrics = Object.entries(run.metrics.routes);
  const baselineNotComparable = isLatest && run.baselineComparison?.status !== 'compared';
  return (
    <section className="detail-card performance-card">
      <div className="performance-title">
        <div>
          <h2>{title}</h2>
          <p>
            {run.runId} · {displayDate(run.startedAt)}
          </p>
        </div>
        <span className="version-tag">{label}</span>
        <span
          className={`pill ${baselineNotComparable ? 'pill-warning' : run.verdict === 'pass' ? 'pill-success' : run.verdict === 'fail' ? 'pill-review' : 'pill-warning'}`}
        >
          {run.verdict.toUpperCase()}
          {baselineNotComparable ? ' · HISTORICAL' : ''} · {run.suiteStatus}
        </span>
      </div>
      {baselineNotComparable ? (
        <div className="notice notice-warning">
          <strong>Historical verdict and gates</strong>
          <span>
            This report was not compared with the current accepted baseline on the same dataset. Its
            verdict and gate results describe the original run and should not be treated as a pass
            against the current baseline.
          </span>
        </div>
      ) : null}
      <div className="metric-grid">
        <div className="metric-card">
          <small>Cases</small>
          <strong>{run.caseCount}</strong>
          <span>in {run.datasetId}</span>
        </div>
        <div className="metric-card">
          <small>Golden unsafe-ready</small>
          <strong>{run.metrics.unsafeReady.count ?? '—'}</strong>
          <span>of {run.metrics.unsafeReady.denominator ?? 'unknown'} total cases</span>
        </div>
        <div className="metric-card">
          <small>Human review recall</small>
          <strong>{percent(run.metrics.humanReviewRecall.value)}</strong>
          <span>
            {run.metrics.humanReviewRecall.correctlyEscalated ?? '—'} /{' '}
            {run.metrics.humanReviewRecall.denominator ?? '—'} escalated
          </span>
        </div>
        <div className="metric-card">
          <small>Critical fact precision / recall</small>
          <strong>
            {percent(run.metrics.criticalFacts.precision)} /{' '}
            {percent(run.metrics.criticalFacts.recall)}
          </strong>
          <span>
            {run.metrics.criticalFacts.matched ?? '—'} matched ·{' '}
            {run.metrics.criticalFacts.expected ?? '—'} expected
          </span>
        </div>
      </div>
      <h3 className="section-label">Route performance</h3>
      <div className="route-grid">
        {routeMetrics.map(([route, metric]) => (
          <div className="route-metric" key={route}>
            <strong>{route.replaceAll('_', ' ')}</strong>
            <small>
              Support {metric.support ?? '—'} · Precision {percent(metric.precision)} · Recall{' '}
              {percent(metric.recall)}
            </small>
          </div>
        ))}
      </div>
      <h3 className="section-label">
        {baselineNotComparable ? 'Recorded safety and quality gates' : 'Safety and quality gates'}
      </h3>
      <div className="gate-list">
        {run.metrics.gates.map((gate) => (
          <div className={`gate ${gate.passed ? '' : 'failed'}`} key={gate.id}>
            <span className="gate-mark">{gate.passed ? '✓' : '!'}</span>
            <span>
              <strong>{gate.id}</strong>
              <br />
              {gate.detail}
            </span>
          </div>
        ))}
      </div>
      <div className="version-row">
        <span className="version-tag">
          Model: {run.provider} / {run.model}
        </span>
        <span className="version-tag">Prompt: {run.promptVersion}</span>
        <span className="version-tag">Dataset: {run.datasetHash.slice(0, 12)}…</span>
        <span className="version-tag">Git: {run.gitSha.slice(0, 8)}</span>
        <span className="version-tag">
          Baseline: {run.baselineComparison?.status ?? 'not recorded'}
        </span>
      </div>
      <div className="performance-links">
        <a
          className="text-link"
          href={`/api/evals/reports/${encodeURIComponent(run.runId)}`}
          target="_blank"
          rel="noreferrer"
        >
          Open retained JSON report ↗
        </a>
        <div className="experiment-list">
          {run.studioExperiments.map((experiment) => (
            <a
              className="experiment-link"
              href={`${studioBaseUrl.replace(/\/$/, '')}/experiments/${encodeURIComponent(experiment.experimentId)}`}
              key={experiment.experimentId}
              target="_blank"
              rel="noreferrer"
            >
              Open {experiment.targetType} experiment ↗
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
