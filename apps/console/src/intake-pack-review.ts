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

export function canOpenIntakeDraftReview(pack?: IntakePackView): boolean {
  return Boolean(pack?.extraction);
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

export function reviewSiteIds(draft: IntakeDraft): string[] {
  const ids = new Set<string>();
  for (const site of draft.sites) {
    if (site.siteId) ids.add(site.siteId);
  }
  for (const candidate of draft.candidates) {
    if (candidate.siteId) ids.add(candidate.siteId);
  }
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
    return {
      edits: first
        ? clearOperatorField(
            input.edits,
            first.field,
            isSiteScopedDraftField(first.field) ? (input.siteId ?? first.siteId ?? null) : null,
          )
        : input.edits,
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
  const token = needle.split(/\s+/).find((part) => part.length >= 6);
  if (token) {
    const tokenIndex = text.toLowerCase().indexOf(token.toLowerCase());
    if (tokenIndex >= 0) {
      return {
        kind: 'hit',
        before: text.slice(0, tokenIndex),
        match: text.slice(tokenIndex, tokenIndex + token.length),
        after: text.slice(tokenIndex + token.length),
      };
    }
  }
  return { kind: 'miss', text };
}

export function acceptedCandidateIdsFromDraft(draft: IntakeDraft): string[] {
  return draft.candidates.filter((candidate) => candidate.accepted).map((c) => c.candidateId);
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
  const consumption = parseConsumption(edit.annualConsumptionKwh);
  return {
    siteId: edit.siteId,
    address: edit.address.trim() || undefined,
    meterIdentifier: edit.meterIdentifier.trim() || null,
    annualConsumptionKwh: consumption,
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

function parseConsumption(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
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
