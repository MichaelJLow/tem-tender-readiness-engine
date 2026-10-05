import type {
  IntakeCandidate,
  IntakeDraft,
  IntakeDraftField,
  IntakeDraftSite,
  IntakeProvenance,
} from '../../../packages/domain/src/index.js';
import type { IntakeApiErrorBody, IntakeExtractionView, IntakePackView } from './intake-pack.js';

export type { IntakeCandidate, IntakeDraft, IntakeDraftField };

export const UNASSIGNED_REVIEW_BUCKET = '__unassigned__';

export const SITE_SCOPED_DRAFT_FIELDS = [
  'siteAddress',
  'meterIdentifier',
  'annualConsumptionKwh',
  'contractEndDate',
] as const satisfies ReadonlyArray<IntakeDraftField>;

export const PACK_LEVEL_DRAFT_FIELDS = [
  'customerLegalName',
  'brokerLegalName',
] as const satisfies ReadonlyArray<IntakeDraftField>;

export type SiteScopedDraftField = (typeof SITE_SCOPED_DRAFT_FIELDS)[number];

export type ReviewFieldEdits = {
  customerLegalName: string;
  brokerLegalName: string;
  sites: Record<string, ReviewSiteEdit>;
};

export type ReviewSiteEdit = {
  siteId: string;
  address: string;
  meterIdentifier: string;
  annualConsumptionKwh: string;
  contractEndDate: string;
};

export type ReviewSourceFocus = {
  sourceKind: 'DOCUMENT_PAGE' | 'NOTE';
  sourceId: string;
  documentId?: string;
  pageNumber?: number;
  quote: string;
  candidateId: string;
};

export type ReviewConflictGroup = {
  key: string;
  field: IntakeDraftField;
  siteId: string | null;
  candidates: IntakeCandidate[];
};

export type IntakeDraftPatchBody = {
  expectedDraftVersion: number;
  acceptedCandidateIds: string[];
  rejectedCandidateIds: string[];
  fieldEdits: {
    customerLegalName?: string;
    brokerLegalName?: string;
    sites?: IntakeDraftSite[];
  };
};

export type ConcurrentDraftChange = {
  label: string;
  detail: string;
};

export type ConsumptionParseResult =
  { ok: true; value: number | null } | { ok: false; message: string };

const SITE_VALUE_KEYS = [
  'address',
  'meterIdentifier',
  'annualConsumptionKwh',
  'contractEndDate',
] as const;

export function canOpenIntakeDraftReview(pack?: IntakePackView): boolean {
  if (!pack?.extraction) return false;
  return pack.status === 'REVIEWABLE' || pack.status === 'CONFIRMED';
}

export function isIntakeDraftReadOnly(pack?: IntakePackView): boolean {
  return pack?.status === 'CONFIRMED';
}

export function isSiteScopedDraftField(field: IntakeDraftField): field is SiteScopedDraftField {
  return (SITE_SCOPED_DRAFT_FIELDS as readonly string[]).includes(field);
}

export function displayDraftField(field: IntakeDraftField): string {
  switch (field) {
    case 'customerLegalName':
      return 'Customer legal name';
    case 'brokerLegalName':
      return 'Broker legal name';
    case 'siteAddress':
      return 'Site address';
    case 'meterIdentifier':
      return 'Meter identifier';
    case 'annualConsumptionKwh':
      return 'Annual consumption (kWh)';
    case 'contractEndDate':
      return 'Contract end date';
  }
}

export function displaySiteLabel(siteId: string | null | undefined): string {
  if (!siteId) return 'Unassigned';
  if (siteId === 'site-warehouse') return 'Warehouse';
  if (siteId === 'site-retail') return 'Retail';
  return siteId;
}

export function reviewSiteIds(draft: IntakeDraft, edits?: ReviewFieldEdits): string[] {
  const ids = new Set<string>();
  for (const site of draft.sites) {
    if (site.siteId) ids.add(site.siteId);
  }
  for (const candidate of draft.candidates) {
    if (candidate.siteId) ids.add(candidate.siteId);
  }
  for (const siteId of Object.keys(edits?.sites ?? {})) ids.add(siteId);
  return [...ids].sort((left, right) =>
    displaySiteLabel(left).localeCompare(displaySiteLabel(right), 'en-GB'),
  );
}

export function assignableReviewSiteIds(draft: IntakeDraft, edits: ReviewFieldEdits): string[] {
  const ids = new Set(reviewSiteIds(draft));
  for (const siteId of Object.keys(edits.sites)) ids.add(siteId);
  if (ids.size === 0) {
    ids.add('site-warehouse');
    ids.add('site-retail');
  }
  return [...ids].sort((left, right) =>
    displaySiteLabel(left).localeCompare(displaySiteLabel(right), 'en-GB'),
  );
}

export function packLevelCandidates(candidates: IntakeCandidate[]): IntakeCandidate[] {
  return candidates.filter((candidate) => !isSiteScopedDraftField(candidate.field));
}

export function candidatesForReviewBucket(
  candidates: IntakeCandidate[],
  bucketId: string,
): IntakeCandidate[] {
  if (bucketId === UNASSIGNED_REVIEW_BUCKET) {
    return candidates.filter(
      (candidate) =>
        isSiteScopedDraftField(candidate.field) &&
        (candidate.siteId == null || candidate.associationStatus !== 'RESOLVED'),
    );
  }
  return candidates.filter(
    (candidate) =>
      isSiteScopedDraftField(candidate.field) &&
      candidate.siteId === bucketId &&
      candidate.associationStatus === 'RESOLVED',
  );
}

export function conflictGroups(candidates: IntakeCandidate[]): ReviewConflictGroup[] {
  const grouped = new Map<string, IntakeCandidate[]>();
  for (const candidate of candidates) {
    if (isSiteScopedDraftField(candidate.field) && !candidate.siteId) continue;
    const siteKey = isSiteScopedDraftField(candidate.field) ? (candidate.siteId ?? '') : '';
    const key = `${candidate.field}\0${siteKey}`;
    const existing = grouped.get(key);
    if (existing) existing.push(candidate);
    else grouped.set(key, [candidate]);
  }

  const conflicts: ReviewConflictGroup[] = [];
  for (const [key, group] of grouped) {
    const values = new Set(group.map((candidate) => candidate.value));
    if (values.size < 2) continue;
    const first = group[0];
    if (!first) continue;
    conflicts.push({
      key,
      field: first.field,
      siteId: isSiteScopedDraftField(first.field) ? (first.siteId ?? null) : null,
      candidates: group,
    });
  }
  return conflicts;
}

export function unassignedConflictGroups(
  candidates: IntakeCandidate[],
  assignedSiteByCandidate: Record<string, string>,
): ReviewConflictGroup[] {
  const grouped = new Map<string, IntakeCandidate[]>();
  for (const candidate of candidates) {
    const targetSiteId = assignedSiteByCandidate[candidate.candidateId];
    if (!targetSiteId) continue;
    const key = `${candidate.field}\0${targetSiteId}`;
    const existing = grouped.get(key);
    if (existing) existing.push(candidate);
    else grouped.set(key, [candidate]);
  }

  const conflicts: ReviewConflictGroup[] = [];
  for (const [key, group] of grouped) {
    const values = new Set(group.map((candidate) => candidate.value));
    if (values.size < 2) continue;
    const first = group[0];
    if (!first) continue;
    conflicts.push({
      key,
      field: first.field,
      siteId: assignedSiteByCandidate[first.candidateId] ?? null,
      candidates: group,
    });
  }
  return conflicts;
}

export function competingCandidatesForAssignment(input: {
  candidates: IntakeCandidate[];
  candidate: IntakeCandidate;
  targetSiteId: string;
  assignedSiteByCandidate: Record<string, string>;
}): IntakeCandidate[] {
  return input.candidates.filter((item) => {
    if (item.field !== input.candidate.field) return false;
    if (item.candidateId === input.candidate.candidateId) return true;
    if (input.assignedSiteByCandidate[item.candidateId] === input.targetSiteId) return true;
    return item.siteId === input.targetSiteId;
  });
}

export function operatorFieldState(value: string | undefined | null): 'empty' | 'operator' {
  return value?.toString().trim() ? 'operator' : 'empty';
}

export function emptyReviewFieldEdits(): ReviewFieldEdits {
  return { customerLegalName: '', brokerLegalName: '', sites: {} };
}

export function reviewFieldEditsFromDraft(draft: IntakeDraft): ReviewFieldEdits {
  const sites: ReviewFieldEdits['sites'] = {};
  for (const site of draft.sites) {
    if (!site.siteId) continue;
    sites[site.siteId] = siteEditFromDraft(site);
  }
  return {
    customerLegalName: draft.customer.legalName ?? '',
    brokerLegalName: draft.broker.legalName ?? '',
    sites,
  };
}

export function emptySiteEdit(siteId: string): ReviewSiteEdit {
  return {
    siteId,
    address: '',
    meterIdentifier: '',
    annualConsumptionKwh: '',
    contractEndDate: '',
  };
}

export function ensureReviewSite(edits: ReviewFieldEdits, siteId: string): ReviewFieldEdits {
  if (edits.sites[siteId]) return edits;
  return {
    ...edits,
    sites: { ...edits.sites, [siteId]: emptySiteEdit(siteId) },
  };
}

export function siteEditForDisplay(edits: ReviewFieldEdits, siteId: string): ReviewSiteEdit {
  return edits.sites[siteId] ?? emptySiteEdit(siteId);
}

export function applyCandidateValueToEdits(
  edits: ReviewFieldEdits,
  candidate: IntakeCandidate,
  siteId?: string | null,
): ReviewFieldEdits {
  if (candidate.field === 'customerLegalName') {
    return { ...edits, customerLegalName: candidate.value };
  }
  if (candidate.field === 'brokerLegalName') {
    return { ...edits, brokerLegalName: candidate.value };
  }
  const targetSiteId = siteId ?? candidate.siteId;
  if (!targetSiteId) return edits;
  const withSite = ensureReviewSite(edits, targetSiteId);
  const site = { ...siteEditForDisplay(withSite, targetSiteId) };
  switch (candidate.field) {
    case 'siteAddress':
      site.address = candidate.value;
      break;
    case 'meterIdentifier':
      site.meterIdentifier = candidate.value;
      break;
    case 'annualConsumptionKwh':
      site.annualConsumptionKwh = candidate.value;
      break;
    case 'contractEndDate':
      site.contractEndDate = candidate.value;
      break;
  }
  return {
    ...withSite,
    sites: { ...withSite.sites, [targetSiteId]: site },
  };
}

export function clearOperatorField(
  edits: ReviewFieldEdits,
  field: IntakeDraftField,
  siteId?: string | null,
): ReviewFieldEdits {
  if (field === 'customerLegalName') return { ...edits, customerLegalName: '' };
  if (field === 'brokerLegalName') return { ...edits, brokerLegalName: '' };
  if (!siteId) return edits;
  const site = { ...siteEditForDisplay(edits, siteId) };
  switch (field) {
    case 'siteAddress':
      site.address = '';
      break;
    case 'meterIdentifier':
      site.meterIdentifier = '';
      break;
    case 'annualConsumptionKwh':
      site.annualConsumptionKwh = '';
      break;
    case 'contractEndDate':
      site.contractEndDate = '';
      break;
  }
  return {
    ...edits,
    sites: { ...edits.sites, [siteId]: site },
  };
}

export function resolveConflictChoice(input: {
  edits: ReviewFieldEdits;
  acceptedIds: string[];
  group: IntakeCandidate[];
  chosenCandidateId: string | null;
  siteId?: string | null;
}): { edits: ReviewFieldEdits; acceptedIds: string[] } {
  const groupIds = new Set(input.group.map((candidate) => candidate.candidateId));
  const acceptedIds = input.acceptedIds.filter((id) => !groupIds.has(id));
  if (!input.chosenCandidateId) {
    const first = input.group[0];
    const targetSiteId =
      first && isSiteScopedDraftField(first.field) ? (input.siteId ?? first.siteId ?? null) : null;
    return {
      edits: first ? clearOperatorField(input.edits, first.field, targetSiteId) : input.edits,
      acceptedIds,
    };
  }
  const chosen = input.group.find((candidate) => candidate.candidateId === input.chosenCandidateId);
  if (!chosen) return { edits: input.edits, acceptedIds };
  return {
    edits: applyCandidateValueToEdits(input.edits, chosen, input.siteId ?? chosen.siteId),
    acceptedIds: [...acceptedIds, chosen.candidateId],
  };
}

export function leaveUnassignedCandidate(input: {
  edits: ReviewFieldEdits;
  acceptedIds: string[];
  candidate: IntakeCandidate;
  assignedSiteByCandidate: Record<string, string>;
}): {
  edits: ReviewFieldEdits;
  acceptedIds: string[];
  assignedSiteByCandidate: Record<string, string>;
} {
  const targetSiteId = input.assignedSiteByCandidate[input.candidate.candidateId];
  const resolved = resolveConflictChoice({
    edits: input.edits,
    acceptedIds: input.acceptedIds,
    group: [input.candidate],
    chosenCandidateId: null,
    siteId: targetSiteId ?? null,
  });
  const assignedSiteByCandidate = { ...input.assignedSiteByCandidate };
  delete assignedSiteByCandidate[input.candidate.candidateId];
  return {
    edits: resolved.edits,
    acceptedIds: resolved.acceptedIds,
    assignedSiteByCandidate,
  };
}

export function sourceFocusForCandidate(
  candidate: IntakeCandidate,
  provenanceIndex = 0,
): ReviewSourceFocus | undefined {
  const provenance = candidate.provenance[provenanceIndex] ?? candidate.provenance[0];
  if (!provenance) return undefined;
  return sourceFocusFromProvenance(candidate.candidateId, provenance);
}

export function sourceFocusFromProvenance(
  candidateId: string,
  provenance: IntakeProvenance,
): ReviewSourceFocus {
  return {
    sourceKind: provenance.sourceKind,
    sourceId: provenance.sourceId,
    documentId: provenance.documentId,
    pageNumber: provenance.pageNumber,
    quote: provenance.quote,
    candidateId,
  };
}

export function extractionPage(
  extraction: IntakeExtractionView | undefined,
  documentId: string,
  pageNumber: number,
): IntakeExtractionView['pages'][number] | undefined {
  return extraction?.pages.find(
    (page) => page.documentId === documentId && page.pageNumber === pageNumber,
  );
}

export function documentPageNumbers(
  extraction: IntakeExtractionView | undefined,
  documentId: string,
): number[] {
  return (extraction?.pages ?? [])
    .filter((page) => page.documentId === documentId)
    .map((page) => page.pageNumber)
    .sort((left, right) => left - right);
}

export function splitAroundQuote(
  text: string,
  quote: string,
): { kind: 'hit'; before: string; match: string; after: string } | { kind: 'miss'; text: string } {
  const needle = quote.trim();
  if (!needle) return { kind: 'miss', text };
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index >= 0) {
    return {
      kind: 'hit',
      before: text.slice(0, index),
      match: text.slice(index, index + needle.length),
      after: text.slice(index + needle.length),
    };
  }
  return { kind: 'miss', text };
}

export function acceptedCandidateIdsFromDraft(draft: IntakeDraft): string[] {
  return draft.candidates.filter((candidate) => candidate.accepted).map((c) => c.candidateId);
}

export function matchingAcceptedIds(input: {
  candidates: IntakeCandidate[];
  edits: ReviewFieldEdits;
  acceptedIds: string[];
  assignedSiteByCandidate?: Record<string, string>;
}): string[] {
  return input.acceptedIds.filter((id) => {
    const candidate = input.candidates.find((item) => item.candidateId === id);
    if (!candidate) return false;
    const operatorValue = operatorValueForCandidate(
      input.edits,
      candidate,
      input.assignedSiteByCandidate?.[id] ?? candidate.siteId,
    );
    if (!operatorValue.trim()) return true;
    return operatorValue.trim() === candidate.value;
  });
}

export function rebaseReviewSession(input: {
  base: IntakeDraft;
  latest: IntakeDraft;
  edits: ReviewFieldEdits;
  acceptedIds: string[];
}): {
  edits: ReviewFieldEdits;
  acceptedIds: string[];
  concurrentChanges: ConcurrentDraftChange[];
} {
  const baseEdits = reviewFieldEditsFromDraft(input.base);
  const latestEdits = reviewFieldEditsFromDraft(input.latest);
  const concurrentChanges: ConcurrentDraftChange[] = [];

  if (latestEdits.customerLegalName !== baseEdits.customerLegalName) {
    concurrentChanges.push({
      label: displayDraftField('customerLegalName'),
      detail: latestEdits.customerLegalName || '(empty)',
    });
  }
  if (latestEdits.brokerLegalName !== baseEdits.brokerLegalName) {
    concurrentChanges.push({
      label: displayDraftField('brokerLegalName'),
      detail: latestEdits.brokerLegalName || '(empty)',
    });
  }

  const customerLegalName =
    input.edits.customerLegalName !== baseEdits.customerLegalName
      ? input.edits.customerLegalName
      : latestEdits.customerLegalName;
  const brokerLegalName =
    input.edits.brokerLegalName !== baseEdits.brokerLegalName
      ? input.edits.brokerLegalName
      : latestEdits.brokerLegalName;

  const siteIds = new Set([
    ...Object.keys(baseEdits.sites),
    ...Object.keys(latestEdits.sites),
    ...Object.keys(input.edits.sites),
  ]);
  const sites: ReviewFieldEdits['sites'] = {};
  for (const siteId of siteIds) {
    const baseSite = baseEdits.sites[siteId] ?? emptySiteEdit(siteId);
    const latestSite = latestEdits.sites[siteId] ?? emptySiteEdit(siteId);
    const localSite = input.edits.sites[siteId];
    const merged = emptySiteEdit(siteId);
    for (const key of SITE_VALUE_KEYS) {
      if (latestSite[key] !== baseSite[key]) {
        concurrentChanges.push({
          label: `${displaySiteLabel(siteId)} ${displayDraftField(fieldForSiteKey(key))}`,
          detail: latestSite[key] || '(empty)',
        });
      }
      const localChanged = Boolean(localSite && localSite[key] !== baseSite[key]);
      merged[key] = localChanged && localSite ? localSite[key] : latestSite[key];
    }
    if (latestEdits.sites[siteId] || (localSite && siteHasOperatorValue(localSite))) {
      sites[siteId] = merged;
    }
  }

  const baseAccepted = new Set(acceptedCandidateIdsFromDraft(input.base));
  const latestAccepted = new Set(acceptedCandidateIdsFromDraft(input.latest));
  const localAccepted = new Set(input.acceptedIds);
  const nextAccepted = new Set(latestAccepted);
  for (const id of baseAccepted) {
    if (!localAccepted.has(id)) nextAccepted.delete(id);
  }
  for (const id of localAccepted) {
    if (!baseAccepted.has(id)) nextAccepted.add(id);
  }
  for (const id of latestAccepted) {
    if (baseAccepted.has(id)) continue;
    const candidate = input.latest.candidates.find((item) => item.candidateId === id);
    concurrentChanges.push({
      label: 'Accepted candidate',
      detail: candidate ? `${displayDraftField(candidate.field)} · ${candidate.value}` : id,
    });
  }

  return {
    edits: { customerLegalName, brokerLegalName, sites },
    acceptedIds: [...nextAccepted],
    concurrentChanges,
  };
}

export function describeConcurrentDraftChanges(changes: ConcurrentDraftChange[]): string {
  if (changes.length === 0) {
    return 'No other fields changed. Your unsaved edits are ready to save on this version.';
  }
  return `Kept concurrent work: ${changes.map((change) => `${change.label} → ${change.detail}`).join('; ')}.`;
}

export function parseAnnualConsumption(raw: string): ConsumptionParseResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return {
      ok: false,
      message: `Annual consumption “${trimmed}” is not a valid number.`,
    };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { ok: false, message: `Annual consumption “${trimmed}” is not a valid number.` };
  }
  return { ok: true, value };
}

export function reviewSaveIssues(edits: ReviewFieldEdits): string[] {
  const issues: string[] = [];
  for (const site of Object.values(edits.sites)) {
    const parsed = parseAnnualConsumption(site.annualConsumptionKwh);
    if (!parsed.ok) {
      issues.push(`${displaySiteLabel(site.siteId)}: ${parsed.message}`);
    }
  }
  return issues;
}

function operatorValueForCandidate(
  edits: ReviewFieldEdits,
  candidate: IntakeCandidate,
  siteId: string | null | undefined,
): string {
  if (candidate.field === 'customerLegalName') return edits.customerLegalName;
  if (candidate.field === 'brokerLegalName') return edits.brokerLegalName;
  if (!siteId) return '';
  const site = edits.sites[siteId];
  if (!site) return '';
  switch (candidate.field) {
    case 'siteAddress':
      return site.address;
    case 'meterIdentifier':
      return site.meterIdentifier;
    case 'annualConsumptionKwh':
      return site.annualConsumptionKwh;
    case 'contractEndDate':
      return site.contractEndDate;
    default:
      return '';
  }
}

function fieldForSiteKey(key: (typeof SITE_VALUE_KEYS)[number]): IntakeDraftField {
  switch (key) {
    case 'address':
      return 'siteAddress';
    case 'meterIdentifier':
      return 'meterIdentifier';
    case 'annualConsumptionKwh':
      return 'annualConsumptionKwh';
    case 'contractEndDate':
      return 'contractEndDate';
  }
}

export function buildIntakeDraftPatch(input: {
  expectedDraftVersion: number;
  original: IntakeDraft;
  edits: ReviewFieldEdits;
  acceptedIds: string[];
}): IntakeDraftPatchBody {
  const originalAccepted = new Set(acceptedCandidateIdsFromDraft(input.original));
  const nextAccepted = new Set(input.acceptedIds);
  const acceptedCandidateIds = input.acceptedIds.filter((id) => !originalAccepted.has(id));
  const rejectedCandidateIds = [...originalAccepted].filter((id) => !nextAccepted.has(id));

  const fieldEdits: IntakeDraftPatchBody['fieldEdits'] = {};
  if (input.edits.customerLegalName !== (input.original.customer.legalName ?? '')) {
    fieldEdits.customerLegalName = input.edits.customerLegalName;
  }
  if (input.edits.brokerLegalName !== (input.original.broker.legalName ?? '')) {
    fieldEdits.brokerLegalName = input.edits.brokerLegalName;
  }

  const nextSites = sitesFromEdits(input.edits, input.original);
  if (!sameSites(input.original.sites, nextSites)) {
    fieldEdits.sites = nextSites;
  }

  return {
    expectedDraftVersion: input.expectedDraftVersion,
    acceptedCandidateIds,
    rejectedCandidateIds,
    fieldEdits,
  };
}

export function isDraftStaleError(status: number, body: IntakeApiErrorBody): boolean {
  return status === 409 && (body.error === 'DRAFT_STALE' || body.failure?.code === 'DRAFT_STALE');
}

function siteEditFromDraft(site: IntakeDraftSite): ReviewSiteEdit {
  return {
    siteId: site.siteId ?? '',
    address: site.address ?? '',
    meterIdentifier: site.meterIdentifier ?? '',
    annualConsumptionKwh:
      site.annualConsumptionKwh == null ? '' : String(site.annualConsumptionKwh),
    contractEndDate: site.contractEndDate ?? '',
  };
}

function sitesFromEdits(edits: ReviewFieldEdits, original: IntakeDraft): IntakeDraftSite[] {
  const originalIds = new Set(original.sites.map((site) => site.siteId).filter(Boolean));
  const sites: IntakeDraftSite[] = [];
  const ids = new Set([...originalIds, ...Object.keys(edits.sites)]);
  for (const siteId of ids) {
    if (!siteId) continue;
    const edit = edits.sites[siteId] ?? emptySiteEdit(siteId);
    const originalSite = original.sites.find((site) => site.siteId === siteId);
    const next = toDraftSite(edit);
    if (originalSite || siteHasOperatorValue(edit)) {
      sites.push(next);
    }
  }
  return sites.sort((left, right) => (left.siteId ?? '').localeCompare(right.siteId ?? ''));
}

function toDraftSite(edit: ReviewSiteEdit): IntakeDraftSite {
  const consumption = parseAnnualConsumption(edit.annualConsumptionKwh);
  return {
    siteId: edit.siteId,
    address: edit.address.trim() || undefined,
    meterIdentifier: edit.meterIdentifier.trim() || null,
    annualConsumptionKwh: consumption.ok ? consumption.value : null,
    contractEndDate: edit.contractEndDate.trim() || null,
  };
}

function siteHasOperatorValue(edit: ReviewSiteEdit): boolean {
  return Boolean(
    edit.address.trim() ||
    edit.meterIdentifier.trim() ||
    edit.annualConsumptionKwh.trim() ||
    edit.contractEndDate.trim(),
  );
}

function sameSites(left: IntakeDraftSite[], right: IntakeDraftSite[]): boolean {
  return JSON.stringify(normalizeSites(left)) === JSON.stringify(normalizeSites(right));
}

function normalizeSites(sites: IntakeDraftSite[]): IntakeDraftSite[] {
  return [...sites]
    .map((site) => ({
      siteId: site.siteId,
      address: site.address,
      meterIdentifier: site.meterIdentifier ?? null,
      annualConsumptionKwh: site.annualConsumptionKwh ?? null,
      contractEndDate: site.contractEndDate ?? null,
    }))
    .sort((left, right) => (left.siteId ?? '').localeCompare(right.siteId ?? ''));
}
