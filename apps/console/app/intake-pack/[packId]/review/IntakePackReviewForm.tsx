'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { IntakePackFlow } from '../../IntakePackFlow';
import {
  INTAKE_PACK_ENTRY_NAME,
  displayIntakeStatus,
  intakeStatusTone,
  type IntakeApiErrorBody,
  type IntakePackView,
} from '../../../../src/intake-pack';
import {
  UNASSIGNED_REVIEW_BUCKET,
  acceptedCandidateIdsFromDraft,
  assignableReviewSiteIds,
  buildIntakeDraftPatch,
  canConfirmIntakeDraftReview,
  canOpenIntakeDraftReview,
  candidatesForReviewBucket,
  competingCandidatesForAssignment,
  confirmationRunId,
  conflictGroups,
  describeConcurrentDraftChanges,
  displayDraftField,
  displaySiteLabel,
  documentPageNumbers,
  emptyReviewFieldEdits,
  extractionPage,
  intakeCaseDetailPath,
  intakeConfirmIdempotencyKey,
  isDraftStaleError,
  isIntakeDraftReadOnly,
  leaveUnassignedCandidate,
  matchingAcceptedIds,
  operatorFieldState,
  packLevelCandidates,
  parseAnnualConsumption,
  rebaseReviewSession,
  resolveConflictChoice,
  reviewFieldEditsFromDraft,
  reviewSaveIssues,
  reviewSiteIds,
  siteEditForDisplay,
  sourceFocusForCandidate,
  splitAroundQuote,
  unassignedConflictGroups,
  type IntakeCandidate,
  type IntakeDraft,
  type IntakeDraftField,
  type ReviewFieldEdits,
  type ReviewSourceFocus,
} from '../../../../src/intake-pack-review';

interface Props {
  packId: string;
}

type BucketId = typeof UNASSIGNED_REVIEW_BUCKET | string;

export function IntakePackReviewForm({ packId }: Props) {
  const router = useRouter();
  const [pack, setPack] = useState<IntakePackView | null>(null);
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const [edits, setEdits] = useState<ReviewFieldEdits>(emptyReviewFieldEdits());
  const [acceptedIds, setAcceptedIds] = useState<string[]>([]);
  const [bucketId, setBucketId] = useState<BucketId>(UNASSIGNED_REVIEW_BUCKET);
  const [focus, setFocus] = useState<ReviewSourceFocus | undefined>();
  const [viewerDocumentId, setViewerDocumentId] = useState('');
  const [viewerPage, setViewerPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [assignSiteByCandidate, setAssignSiteByCandidate] = useState<Record<string, string>>({});

  const applyLoadedDraft = useCallback((next: IntakeDraft, nextPack: IntakePackView | null) => {
    const nextEdits = reviewFieldEditsFromDraft(next);
    setDraft(next);
    setEdits(nextEdits);
    setAcceptedIds(acceptedCandidateIdsFromDraft(next));
    setAssignSiteByCandidate({});
    const sites = reviewSiteIds(next, nextEdits);
    setBucketId((current) => {
      if (current === UNASSIGNED_REVIEW_BUCKET || sites.includes(current)) return current;
      return sites[0] ?? UNASSIGNED_REVIEW_BUCKET;
    });
    const firstExtracted = nextPack?.documents.find((document) => document.status === 'EXTRACTED');
    setViewerDocumentId((current) => current || firstExtracted?.documentId || '');
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const packResponse = await fetch(`/api/intake-packs/${encodeURIComponent(packId)}`, {
        cache: 'no-store',
      });
      const packBody = await readJson<IntakePackView & IntakeApiErrorBody>(packResponse);
      if (!packResponse.ok) {
        throw new Error(
          packBody.message ?? packBody.error ?? `Unable to load ${INTAKE_PACK_ENTRY_NAME}.`,
        );
      }
      setPack(packBody);
      if (!packBody.extraction) {
        setDraft(null);
        return;
      }
      const draftResponse = await fetch(`/api/intake-packs/${encodeURIComponent(packId)}/draft`, {
        cache: 'no-store',
      });
      const draftBody = await readJson<IntakeDraft & IntakeApiErrorBody>(draftResponse);
      if (!draftResponse.ok) {
        throw new Error(
          draftBody.message ?? draftBody.error ?? 'Unable to prepare the review draft.',
        );
      }
      applyLoadedDraft(draftBody, packBody);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load review.');
    } finally {
      setLoading(false);
    }
  }, [applyLoadedDraft, packId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!focus) return;
    if (focus.sourceKind === 'DOCUMENT_PAGE' && focus.documentId) {
      setViewerDocumentId(focus.documentId);
      if (focus.pageNumber) setViewerPage(focus.pageNumber);
    }
  }, [focus]);

  const reviewOpen = canOpenIntakeDraftReview(pack ?? undefined);
  const readOnly = isIntakeDraftReadOnly(pack ?? undefined);
  const caseRunId = confirmationRunId(pack?.confirmation);
  const siteIds = useMemo(() => (draft ? reviewSiteIds(draft, edits) : []), [draft, edits]);
  const assignableSites = useMemo(
    () => (draft ? assignableReviewSiteIds(draft, edits) : ['site-warehouse', 'site-retail']),
    [draft, edits],
  );
  const effectiveAcceptedIds = useMemo(
    () =>
      draft
        ? matchingAcceptedIds({
            candidates: draft.candidates,
            edits,
            acceptedIds,
            assignedSiteByCandidate: assignSiteByCandidate,
          })
        : acceptedIds,
    [acceptedIds, assignSiteByCandidate, draft, edits],
  );
  const patch = useMemo(
    () =>
      draft
        ? buildIntakeDraftPatch({
            expectedDraftVersion: draft.draftVersion,
            original: draft,
            edits,
            acceptedIds: effectiveAcceptedIds,
          })
        : null,
    [draft, edits, effectiveAcceptedIds],
  );
  const dirty = Boolean(
    patch &&
    (patch.acceptedCandidateIds.length > 0 ||
      patch.rejectedCandidateIds.length > 0 ||
      Object.keys(patch.fieldEdits).length > 0),
  );
  const canConfirm = canConfirmIntakeDraftReview({
    pack: pack ?? undefined,
    draft,
    dirty,
  });
  const saveIssues = useMemo(() => reviewSaveIssues(edits), [edits]);
  const bucketCandidates = useMemo(() => {
    if (!draft) return [];
    return candidatesForReviewBucket(draft.candidates, bucketId);
  }, [bucketId, draft]);
  const packCandidates = useMemo(
    () => (draft ? packLevelCandidates(draft.candidates) : []),
    [draft],
  );
  const bucketConflicts = useMemo(
    () =>
      bucketId === UNASSIGNED_REVIEW_BUCKET
        ? unassignedConflictGroups(bucketCandidates, assignSiteByCandidate)
        : conflictGroups(bucketCandidates),
    [assignSiteByCandidate, bucketCandidates, bucketId],
  );
  const packConflicts = useMemo(() => conflictGroups(packCandidates), [packCandidates]);
  const conflictCount = draft
    ? conflictGroups(packLevelCandidates(draft.candidates)).length +
      reviewSiteIds(draft, edits).reduce(
        (total, id) =>
          total + conflictGroups(candidatesForReviewBucket(draft.candidates, id)).length,
        0,
      ) +
      unassignedConflictGroups(
        candidatesForReviewBucket(draft.candidates, UNASSIGNED_REVIEW_BUCKET),
        assignSiteByCandidate,
      ).length
    : 0;

  const pageNumbers = documentPageNumbers(pack?.extraction, viewerDocumentId);
  const currentPage = pageNumbers.includes(viewerPage) ? viewerPage : (pageNumbers[0] ?? 1);
  const page = extractionPage(pack?.extraction, viewerDocumentId, currentPage);
  const viewingNotes = focus?.sourceKind === 'NOTE';
  const note = pack?.notes.find((item) => item.noteId === focus?.sourceId) ?? pack?.notes[0];
  const viewerText = viewingNotes ? (note?.text ?? '') : (page?.text ?? '');
  const quoteSplit = focus
    ? splitAroundQuote(viewerText, focus.quote)
    : { kind: 'miss' as const, text: viewerText };
  const viewerFileName =
    pack?.documents.find((document) => document.documentId === viewerDocumentId)?.fileName ??
    'Extracted page';

  function openCandidate(candidate: IntakeCandidate, provenanceIndex = 0) {
    setFocus(sourceFocusForCandidate(candidate, provenanceIndex));
  }

  function useCandidate(candidate: IntakeCandidate, siteId?: string | null) {
    const group = conflictGroups(
      isPackField(candidate.field) ? packCandidates : bucketCandidates,
    ).find((item) => item.candidates.some((entry) => entry.candidateId === candidate.candidateId));
    const result = resolveConflictChoice({
      edits,
      acceptedIds: effectiveAcceptedIds,
      group: group?.candidates ?? [candidate],
      chosenCandidateId: candidate.candidateId,
      siteId: siteId ?? candidate.siteId,
    });
    setEdits(result.edits);
    setAcceptedIds(result.acceptedIds);
    openCandidate(candidate);
  }

  function assignUnassigned(candidate: IntakeCandidate, siteId: string) {
    if (!draft || readOnly) return;
    const group = competingCandidatesForAssignment({
      candidates: draft.candidates,
      candidate,
      targetSiteId: siteId,
      assignedSiteByCandidate: assignSiteByCandidate,
    });
    const result = resolveConflictChoice({
      edits,
      acceptedIds: effectiveAcceptedIds,
      group,
      chosenCandidateId: candidate.candidateId,
      siteId,
    });
    setEdits(result.edits);
    setAcceptedIds(result.acceptedIds);
    setAssignSiteByCandidate((current) => ({ ...current, [candidate.candidateId]: siteId }));
    setBucketId(siteId);
    openCandidate(candidate);
  }

  function leaveUnresolved(group: IntakeCandidate[], siteId?: string | null) {
    if (readOnly) return;
    const first = group[0];
    const result = resolveConflictChoice({
      edits,
      acceptedIds: effectiveAcceptedIds,
      group,
      chosenCandidateId: null,
      siteId: siteId ?? (bucketId === UNASSIGNED_REVIEW_BUCKET ? null : bucketId),
    });
    setEdits(result.edits);
    setAcceptedIds(result.acceptedIds);
    if (first) openCandidate(first);
  }

  function leaveUnassigned(candidate: IntakeCandidate) {
    if (readOnly) return;
    const left = leaveUnassignedCandidate({
      edits,
      acceptedIds: effectiveAcceptedIds,
      candidate,
      assignedSiteByCandidate: assignSiteByCandidate,
    });
    setEdits(left.edits);
    setAcceptedIds(left.acceptedIds);
    setAssignSiteByCandidate(left.assignedSiteByCandidate);
    openCandidate(candidate);
  }

  function leaveUnassignedGroup(group: IntakeCandidate[]) {
    if (readOnly) return;
    let nextEdits = edits;
    let nextAccepted = effectiveAcceptedIds;
    let nextAssign = assignSiteByCandidate;
    for (const candidate of group) {
      const left = leaveUnassignedCandidate({
        edits: nextEdits,
        acceptedIds: nextAccepted,
        candidate,
        assignedSiteByCandidate: nextAssign,
      });
      nextEdits = left.edits;
      nextAccepted = left.acceptedIds;
      nextAssign = left.assignedSiteByCandidate;
    }
    setEdits(nextEdits);
    setAcceptedIds(nextAccepted);
    setAssignSiteByCandidate(nextAssign);
    if (group[0]) openCandidate(group[0]);
  }

  async function save() {
    if (!draft || !patch || !dirty || readOnly) return;
    if (saveIssues.length > 0) {
      setError(saveIssues.join(' '));
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/intake-packs/${encodeURIComponent(packId)}/draft`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await readJson<IntakeDraft & IntakeApiErrorBody>(response);
      if (isDraftStaleError(response.status, body)) {
        const latest = body.pack?.draft;
        if (latest) {
          const rebased = rebaseReviewSession({
            base: draft,
            latest,
            edits,
            acceptedIds: effectiveAcceptedIds,
          });
          setDraft(latest);
          setEdits(rebased.edits);
          setAcceptedIds(rebased.acceptedIds);
          setNotice(
            `Draft version changed to ${latest.draftVersion}. ${describeConcurrentDraftChanges(rebased.concurrentChanges)} Save again to write your remaining edits.`,
          );
        } else {
          await load();
          setNotice('Draft version changed. Reload complete — save again if your edits remain.');
        }
        throw new Error(
          body.failure?.message ??
            body.message ??
            'Someone else saved this draft. Your unchanged fields were kept from the latest version; save again.',
        );
      }
      if (!response.ok) {
        throw new Error(
          body.failure?.message ?? body.message ?? body.error ?? 'Unable to save draft.',
        );
      }
      applyLoadedDraft(body, pack);
      setNotice(`Saved operator edits as draft version ${body.draftVersion}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save draft.');
    } finally {
      setSaving(false);
    }
  }

  async function confirmPack() {
    if (!draft || !canConfirm) return;
    setConfirming(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/intake-packs/${encodeURIComponent(packId)}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedDraftVersion: draft.draftVersion,
          idempotencyKey: intakeConfirmIdempotencyKey(packId),
        }),
      });
      const body = await readJson<{ runId?: string; tenderId?: string } & IntakeApiErrorBody>(
        response,
      );
      if (isDraftStaleError(response.status, body)) {
        await load();
        throw new Error(
          body.failure?.message ??
            body.message ??
            'This draft version is stale. Reload the latest version, save if needed, then confirm again.',
        );
      }
      if (!response.ok && !body.runId) {
        throw new Error(
          body.failure?.message ?? body.message ?? body.error ?? 'Unable to confirm this pack.',
        );
      }
      if (!body.runId) {
        throw new Error('Confirmation succeeded without a case id.');
      }
      router.push(intakeCaseDetailPath(body.runId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to confirm this pack.');
    } finally {
      setConfirming(false);
    }
  }

  return (
    <>
      <IntakePackFlow pack={pack ?? undefined} current="review" />

      {loading ? (
        <div className="notice notice-info">
          <strong>Loading review</strong>
          <span>Preparing the review-only draft from extracted pages and notes.</span>
        </div>
      ) : null}

      {pack && !pack.extraction ? (
        <div className="notice notice-warning">
          <strong>Extract first</strong>
          <span>
            Draft review needs immutable extracted evidence.{' '}
            <Link className="text-link" href={`/intake-pack/${encodeURIComponent(packId)}`}>
              Return to Drop + extract
            </Link>
          </span>
        </div>
      ) : null}

      {pack && pack.extraction && !reviewOpen ? (
        <div className="notice notice-warning">
          <strong>Not reviewable yet</strong>
          <span>
            Review opens when this pack is REVIEWABLE.{' '}
            <Link className="text-link" href={`/intake-pack/${encodeURIComponent(packId)}`}>
              Return to Drop + extract
            </Link>
          </span>
        </div>
      ) : null}

      {readOnly ? (
        <div className="notice notice-info" role="status">
          <strong>Confirmed pack</strong>
          <span>
            This draft is read-only. Confirmation already handed off into the existing case path
            {caseRunId ? (
              <>
                .{' '}
                <Link className="text-link" href={intakeCaseDetailPath(caseRunId)}>
                  Open case detail
                </Link>
              </>
            ) : (
              '. Confirm does not force READY_FOR_PRICING.'
            )}
          </span>
        </div>
      ) : null}

      {pack && draft && reviewOpen ? (
        <div className="stat-grid intake-stats">
          <article className="stat-card">
            <span>Pack status</span>
            <strong className="intake-status-value">
              <span className={`pill ${intakeStatusTone(pack.status)}`}>
                {displayIntakeStatus(pack.status)}
              </span>
            </strong>
            <small>{pack.packId}</small>
          </article>
          <article className="stat-card">
            <span>Draft version</span>
            <strong>{draft.draftVersion}</strong>
            <small>Optimistic saves send this version. A mismatch returns DRAFT_STALE.</small>
          </article>
          <article className="stat-card">
            <span>Field conflicts</span>
            <strong>{conflictCount}</strong>
            <small>Conflicting values stay together. You may resolve one or leave them open.</small>
          </article>
        </div>
      ) : null}

      {notice ? (
        <div className="notice notice-warning" role="status">
          <strong>Draft notice</strong>
          <span>{notice}</span>
        </div>
      ) : null}

      {pack && draft && reviewOpen ? (
        <div className="review-split">
          <section className="panel intake-panel review-fields">
            <div className="panel-heading">
              <div>
                <h2>Sites and fields</h2>
                <p>
                  Extraction candidates stay as evidence. Operator values are saved separately and
                  never copy across sites.
                </p>
              </div>
            </div>
            <div className="review-panel-body">
              <FieldBlock
                title="Pack"
                fields={[
                  {
                    field: 'customerLegalName',
                    value: edits.customerLegalName,
                    onChange: (value) =>
                      setEdits((current) => ({ ...current, customerLegalName: value })),
                  },
                  {
                    field: 'brokerLegalName',
                    value: edits.brokerLegalName,
                    onChange: (value) =>
                      setEdits((current) => ({ ...current, brokerLegalName: value })),
                  },
                ]}
                candidates={packCandidates}
                conflicts={packConflicts}
                acceptedIds={effectiveAcceptedIds}
                focusId={focus?.candidateId}
                readOnly={readOnly}
                onOpen={openCandidate}
                onUse={(candidate) => useCandidate(candidate)}
                onLeaveUnresolved={(group) => leaveUnresolved(group)}
              />

              <div className="review-site-tabs" role="tablist" aria-label="Sites in this draft">
                {siteIds.map((siteId) => (
                  <button
                    key={siteId}
                    type="button"
                    role="tab"
                    aria-selected={bucketId === siteId}
                    className={`review-site-tab${bucketId === siteId ? ' selected' : ''}`}
                    onClick={() => setBucketId(siteId)}
                  >
                    {displaySiteLabel(siteId)}
                  </button>
                ))}
                <button
                  type="button"
                  role="tab"
                  aria-selected={bucketId === UNASSIGNED_REVIEW_BUCKET}
                  className={`review-site-tab${bucketId === UNASSIGNED_REVIEW_BUCKET ? ' selected' : ''}`}
                  onClick={() => setBucketId(UNASSIGNED_REVIEW_BUCKET)}
                >
                  Unassigned
                </button>
              </div>

              {bucketId === UNASSIGNED_REVIEW_BUCKET ? (
                <UnassignedBlock
                  candidates={bucketCandidates}
                  conflicts={bucketConflicts}
                  acceptedIds={effectiveAcceptedIds}
                  assignableSites={assignableSites}
                  assignSiteByCandidate={assignSiteByCandidate}
                  focusId={focus?.candidateId}
                  readOnly={readOnly}
                  onOpen={openCandidate}
                  onAssign={assignUnassigned}
                  onLeaveCandidate={leaveUnassigned}
                  onLeaveUnresolved={leaveUnassignedGroup}
                />
              ) : (
                <SiteBlock
                  siteId={bucketId}
                  edits={edits}
                  onEdits={setEdits}
                  candidates={bucketCandidates}
                  conflicts={bucketConflicts}
                  acceptedIds={effectiveAcceptedIds}
                  focusId={focus?.candidateId}
                  readOnly={readOnly}
                  onOpen={openCandidate}
                  onUse={(candidate) => useCandidate(candidate, bucketId)}
                  onLeaveUnresolved={(group) => leaveUnresolved(group, bucketId)}
                />
              )}
            </div>
          </section>

          <section className="panel intake-panel review-source">
            <div className="panel-heading">
              <div>
                <h2>Source</h2>
                <p>Each candidate opens the extracted PDF page or note that supplied its quote.</p>
              </div>
            </div>
            <div className="review-panel-body">
              <div className="review-source-toolbar">
                <label>
                  Document
                  <select
                    value={viewingNotes ? '__notes__' : viewerDocumentId}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === '__notes__') {
                        const source = pack.notes[0];
                        setFocus(
                          source
                            ? {
                                sourceKind: 'NOTE',
                                sourceId: source.noteId,
                                quote:
                                  focus?.sourceKind === 'NOTE'
                                    ? focus.quote
                                    : source.text.slice(0, 80),
                                candidateId: focus?.candidateId ?? '',
                              }
                            : undefined,
                        );
                        return;
                      }
                      setFocus((current) => (current?.sourceKind === 'NOTE' ? undefined : current));
                      setViewerDocumentId(value);
                      const pages = documentPageNumbers(pack.extraction, value);
                      setViewerPage(pages[0] ?? 1);
                    }}
                  >
                    {pack.documents.map((document) => (
                      <option key={document.documentId} value={document.documentId}>
                        {document.fileName}
                      </option>
                    ))}
                    {pack.notes.length > 0 ? <option value="__notes__">Broker notes</option> : null}
                  </select>
                </label>
                {!viewingNotes ? (
                  <div className="review-page-nav">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={pageNumbers.indexOf(currentPage) <= 0}
                      onClick={() =>
                        setViewerPage(
                          pageNumbers[pageNumbers.indexOf(currentPage) - 1] ?? currentPage,
                        )
                      }
                    >
                      Previous page
                    </button>
                    <span>
                      Page {currentPage}
                      {pageNumbers.length > 0 ? ` of ${pageNumbers[pageNumbers.length - 1]}` : ''}
                    </span>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={pageNumbers.indexOf(currentPage) >= pageNumbers.length - 1}
                      onClick={() =>
                        setViewerPage(
                          pageNumbers[pageNumbers.indexOf(currentPage) + 1] ?? currentPage,
                        )
                      }
                    >
                      Next page
                    </button>
                  </div>
                ) : null}
              </div>
              {focus ? (
                <div className="notice notice-info review-quote">
                  <strong>Supporting text</strong>
                  <span>“{focus.quote}”</span>
                </div>
              ) : null}
              <pre className="review-source-text">
                {viewingNotes ? (
                  quoteSplit.kind === 'hit' ? (
                    <>
                      {quoteSplit.before}
                      <mark>{quoteSplit.match}</mark>
                      {quoteSplit.after}
                    </>
                  ) : (
                    viewerText || 'No broker notes on this pack.'
                  )
                ) : page ? (
                  quoteSplit.kind === 'hit' ? (
                    <>
                      {quoteSplit.before}
                      <mark>{quoteSplit.match}</mark>
                      {quoteSplit.after}
                    </>
                  ) : (
                    page.text || 'This extracted page has no selectable text.'
                  )
                ) : (
                  `${viewerFileName} has no extracted page ${currentPage}. Failed or OCR-required files stay on the pack and cannot be used as selectable-text evidence.`
                )}
              </pre>
            </div>
          </section>
        </div>
      ) : null}

      {pack && draft && reviewOpen && !readOnly ? (
        <div className="review-save-bar">
          <button
            className="primary-button"
            type="button"
            disabled={!dirty || saving || confirming || saveIssues.length > 0}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save operator edits'}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={!canConfirm || saving || confirming || saveIssues.length > 0}
            onClick={() => void confirmPack()}
          >
            {confirming ? 'Confirming…' : 'Confirm'}
          </button>
          {saveIssues.length > 0 ? (
            <div className="form-error" role="alert">
              {saveIssues.join(' ')}
            </div>
          ) : null}
          <small className="action-note">
            Save writes your values through PATCH. Confirm snapshots this draft version, hands off
            into the existing tender path, and opens case detail. Confirm is not a ready route and
            does not call pricing from this screen.
          </small>
          <p>
            <Link className="text-link" href={`/intake-pack/${encodeURIComponent(packId)}`}>
              ← Back to Drop + extract
            </Link>
          </p>
        </div>
      ) : pack && draft && reviewOpen ? (
        <p>
          <Link className="text-link" href={`/intake-pack/${encodeURIComponent(packId)}`}>
            ← Back to Drop + extract
          </Link>
        </p>
      ) : null}

      {error ? (
        <div className="form-error" role="alert">
          {error}
        </div>
      ) : null}
      <p className="fine-print">
        Local demonstration using synthetic tender data. {INTAKE_PACK_ENTRY_NAME} review does not
        call pricing. Only a later READY_FOR_PRICING case on the existing tender path may.
      </p>
    </>
  );
}

function isPackField(field: IntakeDraftField): boolean {
  return field === 'customerLegalName' || field === 'brokerLegalName';
}

function FieldBlock(props: {
  title: string;
  fields: Array<{ field: IntakeDraftField; value: string; onChange: (value: string) => void }>;
  candidates: IntakeCandidate[];
  conflicts: ReturnType<typeof conflictGroups>;
  acceptedIds: string[];
  focusId?: string;
  readOnly: boolean;
  onOpen: (candidate: IntakeCandidate, provenanceIndex?: number) => void;
  onUse: (candidate: IntakeCandidate) => void;
  onLeaveUnresolved: (group: IntakeCandidate[]) => void;
}) {
  return (
    <div className="review-field-block">
      <h3>{props.title}</h3>
      {props.fields.map((item) => {
        const parsed =
          item.field === 'annualConsumptionKwh' ? parseAnnualConsumption(item.value) : null;
        const invalid = parsed != null && !parsed.ok;
        return (
          <label key={item.field} className="review-field">
            <span className="review-field-label">
              {displayDraftField(item.field)}
              <span
                className={`pill ${operatorFieldState(item.value) === 'empty' ? 'pill-neutral' : 'pill-success'}`}
              >
                {operatorFieldState(item.value) === 'empty' ? 'Empty' : 'Operator edit'}
              </span>
            </span>
            <input
              value={item.value}
              onChange={(event) => item.onChange(event.target.value)}
              placeholder="Empty — extraction does not fill this field"
              disabled={props.readOnly}
              aria-invalid={invalid || undefined}
            />
            {parsed && !parsed.ok ? (
              <span className="review-field-issue">{parsed.message}</span>
            ) : null}
          </label>
        );
      })}
      <CandidateList
        candidates={props.candidates}
        conflicts={props.conflicts}
        acceptedIds={props.acceptedIds}
        focusId={props.focusId}
        readOnly={props.readOnly}
        onOpen={props.onOpen}
        onUse={props.onUse}
        onLeaveUnresolved={props.onLeaveUnresolved}
      />
    </div>
  );
}

function SiteBlock(props: {
  siteId: string;
  edits: ReviewFieldEdits;
  onEdits: (edits: ReviewFieldEdits) => void;
  candidates: IntakeCandidate[];
  conflicts: ReturnType<typeof conflictGroups>;
  acceptedIds: string[];
  focusId?: string;
  readOnly: boolean;
  onOpen: (candidate: IntakeCandidate, provenanceIndex?: number) => void;
  onUse: (candidate: IntakeCandidate) => void;
  onLeaveUnresolved: (group: IntakeCandidate[]) => void;
}) {
  const site = siteEditForDisplay(props.edits, props.siteId);
  function update(partial: Partial<typeof site>) {
    if (props.readOnly) return;
    props.onEdits({
      ...props.edits,
      sites: {
        ...props.edits.sites,
        [props.siteId]: { ...site, ...partial },
      },
    });
  }
  return (
    <FieldBlock
      title={displaySiteLabel(props.siteId)}
      fields={[
        {
          field: 'siteAddress',
          value: site.address,
          onChange: (value) => update({ address: value }),
        },
        {
          field: 'meterIdentifier',
          value: site.meterIdentifier,
          onChange: (value) => update({ meterIdentifier: value }),
        },
        {
          field: 'annualConsumptionKwh',
          value: site.annualConsumptionKwh,
          onChange: (value) => update({ annualConsumptionKwh: value }),
        },
        {
          field: 'contractEndDate',
          value: site.contractEndDate,
          onChange: (value) => update({ contractEndDate: value }),
        },
      ]}
      candidates={props.candidates}
      conflicts={props.conflicts}
      acceptedIds={props.acceptedIds}
      focusId={props.focusId}
      readOnly={props.readOnly}
      onOpen={props.onOpen}
      onUse={props.onUse}
      onLeaveUnresolved={props.onLeaveUnresolved}
    />
  );
}

function UnassignedBlock(props: {
  candidates: IntakeCandidate[];
  conflicts: ReturnType<typeof conflictGroups>;
  acceptedIds: string[];
  assignableSites: string[];
  assignSiteByCandidate: Record<string, string>;
  focusId?: string;
  readOnly: boolean;
  onOpen: (candidate: IntakeCandidate, provenanceIndex?: number) => void;
  onAssign: (candidate: IntakeCandidate, siteId: string) => void;
  onLeaveCandidate: (candidate: IntakeCandidate) => void;
  onLeaveUnresolved: (group: IntakeCandidate[]) => void;
}) {
  return (
    <div className="review-field-block">
      <h3>Unassigned evidence</h3>
      <p className="source-copy">
        These site-scoped facts are unresolved or ambiguous. Assigning writes an operator value onto
        the chosen site and leaves the original unassociated candidate as evidence.
      </p>
      {props.conflicts.length > 0 ? (
        <div className="notice notice-warning">
          <strong>Conflicts in unassigned evidence</strong>
          <span>
            Values assigned to the same site that disagree are listed together. Independent
            unassigned facts stay separate until they target the same site.
          </span>
        </div>
      ) : null}
      {props.candidates.length === 0 ? (
        <p className="muted">No unassigned site-scoped candidates.</p>
      ) : (
        <ul className="review-candidate-list">
          {props.candidates.map((candidate) => (
            <UnassignedCandidateRow
              key={candidate.candidateId}
              candidate={candidate}
              accepted={props.acceptedIds.includes(candidate.candidateId)}
              assignableSites={props.assignableSites}
              assignedSiteId={props.assignSiteByCandidate[candidate.candidateId]}
              focused={props.focusId === candidate.candidateId}
              readOnly={props.readOnly}
              onOpen={props.onOpen}
              onAssign={props.onAssign}
              onLeave={() => props.onLeaveCandidate(candidate)}
            />
          ))}
        </ul>
      )}
      {props.conflicts.map((group) => (
        <div key={group.key} className="review-conflict">
          <div className="review-conflict-heading">
            <strong>
              Conflict · {displayDraftField(group.field)}
              {group.siteId ? ` · ${displaySiteLabel(group.siteId)}` : ''}
            </strong>
            <button
              type="button"
              className="secondary-button"
              disabled={props.readOnly}
              onClick={() => props.onLeaveUnresolved(group.candidates)}
            >
              Leave unresolved
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function UnassignedCandidateRow(props: {
  candidate: IntakeCandidate;
  accepted: boolean;
  assignableSites: string[];
  assignedSiteId?: string;
  focused: boolean;
  readOnly: boolean;
  onOpen: (candidate: IntakeCandidate, provenanceIndex?: number) => void;
  onAssign: (candidate: IntakeCandidate, siteId: string) => void;
  onLeave: () => void;
}) {
  const [choice, setChoice] = useState(
    props.assignedSiteId ?? props.assignableSites[0] ?? 'site-warehouse',
  );
  useEffect(() => {
    if (props.assignedSiteId) setChoice(props.assignedSiteId);
  }, [props.assignedSiteId]);
  const selectedSite = choice;

  return (
    <li className={`review-candidate${props.focused ? ' focused' : ''}`}>
      <CandidateBody candidate={props.candidate} accepted={props.accepted} onOpen={props.onOpen} />
      <div className="candidate-actions">
        <label>
          Assign to site
          <select
            value={selectedSite}
            disabled={props.readOnly}
            onChange={(event) => setChoice(event.target.value)}
          >
            {props.assignableSites.map((siteId) => (
              <option key={siteId} value={siteId}>
                {displaySiteLabel(siteId)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary-button"
          disabled={props.readOnly}
          onClick={() => props.onAssign(props.candidate, selectedSite)}
        >
          Assign as operator value
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={props.readOnly}
          onClick={props.onLeave}
        >
          Leave unresolved
        </button>
      </div>
    </li>
  );
}

function CandidateList(props: {
  candidates: IntakeCandidate[];
  conflicts: ReturnType<typeof conflictGroups>;
  acceptedIds: string[];
  focusId?: string;
  readOnly: boolean;
  onOpen: (candidate: IntakeCandidate, provenanceIndex?: number) => void;
  onUse: (candidate: IntakeCandidate) => void;
  onLeaveUnresolved: (group: IntakeCandidate[]) => void;
}) {
  if (props.candidates.length === 0) {
    return <p className="muted">No extraction candidates for these fields.</p>;
  }
  const conflictIds = new Set(
    props.conflicts.flatMap((group) => group.candidates.map((item) => item.candidateId)),
  );
  const standalone = props.candidates.filter(
    (candidate) => !conflictIds.has(candidate.candidateId),
  );
  return (
    <>
      {props.conflicts.map((group) => (
        <div key={group.key} className="review-conflict">
          <div className="review-conflict-heading">
            <strong>Conflict · {displayDraftField(group.field)}</strong>
            <button
              type="button"
              className="secondary-button"
              disabled={props.readOnly}
              onClick={() => props.onLeaveUnresolved(group.candidates)}
            >
              Leave unresolved
            </button>
          </div>
          <ul className="review-candidate-list">
            {group.candidates.map((candidate) => (
              <CandidateItem
                key={candidate.candidateId}
                candidate={candidate}
                accepted={props.acceptedIds.includes(candidate.candidateId)}
                focused={props.focusId === candidate.candidateId}
                readOnly={props.readOnly}
                onOpen={props.onOpen}
                onUse={props.onUse}
              />
            ))}
          </ul>
        </div>
      ))}
      {standalone.length > 0 ? (
        <ul className="review-candidate-list">
          {standalone.map((candidate) => (
            <CandidateItem
              key={candidate.candidateId}
              candidate={candidate}
              accepted={props.acceptedIds.includes(candidate.candidateId)}
              focused={props.focusId === candidate.candidateId}
              readOnly={props.readOnly}
              onOpen={props.onOpen}
              onUse={props.onUse}
            />
          ))}
        </ul>
      ) : null}
    </>
  );
}

function CandidateItem(props: {
  candidate: IntakeCandidate;
  accepted: boolean;
  focused: boolean;
  readOnly: boolean;
  onOpen: (candidate: IntakeCandidate, provenanceIndex?: number) => void;
  onUse: (candidate: IntakeCandidate) => void;
}) {
  return (
    <li className={`review-candidate${props.focused ? ' focused' : ''}`}>
      <CandidateBody candidate={props.candidate} accepted={props.accepted} onOpen={props.onOpen} />
      <div className="candidate-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={props.readOnly}
          onClick={() => props.onUse(props.candidate)}
        >
          Use as operator value
        </button>
      </div>
    </li>
  );
}

function CandidateBody(props: {
  candidate: IntakeCandidate;
  accepted: boolean;
  onOpen: (candidate: IntakeCandidate, provenanceIndex?: number) => void;
}) {
  return (
    <>
      <div className="review-candidate-head">
        <strong>{props.candidate.value}</strong>
        <span className="pill pill-neutral">{displayDraftField(props.candidate.field)}</span>
        <span className={`pill ${associationTone(props.candidate.associationStatus)}`}>
          {props.candidate.associationStatus.replaceAll('_', ' ')}
        </span>
        {props.accepted ? <span className="pill pill-success">Accepted audit</span> : null}
      </div>
      <ul className="review-provenance">
        {props.candidate.provenance.map((item, index) => (
          <li key={`${item.sourceId}-${item.pageNumber ?? 'note'}-${index}`}>
            <button
              type="button"
              className="text-link"
              onClick={() => props.onOpen(props.candidate, index)}
            >
              {item.sourceKind === 'DOCUMENT_PAGE'
                ? `PDF page ${item.pageNumber ?? '?'}`
                : 'Broker notes'}
            </button>
            <span>“{item.quote}”</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function associationTone(status: string): string {
  if (status === 'RESOLVED') return 'pill-success';
  if (status === 'AMBIGUOUS') return 'pill-warning';
  return 'pill-neutral';
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}
