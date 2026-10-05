import {
  IntakeDraftSchema,
  type IntakeAssociationStatus,
  type IntakeCandidate,
  type IntakeDraft,
  type IntakeDraftField,
  type IntakeDraftSite,
  type IntakeExtraction,
  type IntakeNote,
  type IntakePack,
  type IntakeProvenance,
} from './intake-pack.js';

const SITE_SCOPED_FIELDS = new Set<IntakeDraftField>([
  'siteAddress',
  'meterIdentifier',
  'annualConsumptionKwh',
  'contractEndDate',
]);

const FIELD_ORDER: readonly IntakeDraftField[] = [
  'customerLegalName',
  'brokerLegalName',
  'siteAddress',
  'meterIdentifier',
  'annualConsumptionKwh',
  'contractEndDate',
];

const SITE_LABELS = {
  warehouse: 'site-warehouse',
  retail: 'site-retail',
} as const;

type SiteLabel = keyof typeof SITE_LABELS;

type EvidenceHit = {
  field: IntakeDraftField;
  value: string;
  siteId?: string | null;
  associationStatus: IntakeAssociationStatus;
  provenance: IntakeProvenance;
};

export type IntakeDraftPatchInput = {
  expectedDraftVersion: number;
  acceptedCandidateIds?: string[];
  rejectedCandidateIds?: string[];
  fieldEdits?: {
    customerLegalName?: string;
    brokerLegalName?: string;
    sites?: IntakeDraftSite[];
  };
};

export function canPrepareIntakeDraft(pack: IntakePack): {
  ok: boolean;
  reason: string;
} {
  if (pack.extraction) {
    return { ok: true, reason: 'Pack has immutable extracted evidence.' };
  }
  return {
    ok: false,
    reason: 'Draft preparation requires immutable extracted evidence.',
  };
}

/**
 * Build a review-only draft from extracted pages and broker notes.
 * Candidates keep source, page, supporting text, and site association status.
 * Structured tender fields stay empty — extraction cannot fill them.
 */
export function prepareIntakeDraftFromEvidence(input: {
  packId: string;
  updatedAt: string;
  extraction?: IntakeExtraction;
  notes: IntakeNote[];
  draftVersion?: number;
}): IntakeDraft {
  const hits: EvidenceHit[] = [];

  for (const page of input.extraction?.pages ?? []) {
    hits.push(
      ...scanEvidenceText(page.text, {
        sourceKind: 'DOCUMENT_PAGE',
        sourceId: page.documentId,
        documentId: page.documentId,
        pageNumber: page.pageNumber,
        locator: `page=${page.pageNumber}`,
      }),
    );
  }

  for (const note of input.notes) {
    hits.push(
      ...scanEvidenceText(note.text, {
        sourceKind: 'NOTE',
        sourceId: note.noteId,
        locator: 'note',
      }),
    );
  }

  return IntakeDraftSchema.parse({
    packId: input.packId,
    draftVersion: input.draftVersion ?? 1,
    updatedAt: input.updatedAt,
    customer: {},
    broker: {},
    sites: [],
    candidates: groupHitsIntoCandidates(hits),
  });
}

/**
 * Apply operator draft edits. Accepting a candidate is audit-only and must not
 * copy the suggested value onto structured tender fields.
 */
export function applyIntakeDraftPatch(
  draft: IntakeDraft,
  patch: IntakeDraftPatchInput,
  updatedAt: string,
): { ok: true; draft: IntakeDraft } | { ok: false; code: 'DRAFT_STALE'; message: string } {
  if (draft.draftVersion !== patch.expectedDraftVersion) {
    return {
      ok: false,
      code: 'DRAFT_STALE',
      message: `Draft version ${patch.expectedDraftVersion} is stale; current version is ${draft.draftVersion}.`,
    };
  }

  const accepted = new Set(patch.acceptedCandidateIds ?? []);
  const rejected = new Set(patch.rejectedCandidateIds ?? []);
  const candidates = draft.candidates.map((candidate) => {
    if (rejected.has(candidate.candidateId)) {
      return { ...candidate, accepted: false };
    }
    if (accepted.has(candidate.candidateId)) {
      return { ...candidate, accepted: true };
    }
    return candidate;
  });

  const customer = { ...draft.customer };
  const broker = { ...draft.broker };
  if (patch.fieldEdits?.customerLegalName !== undefined) {
    customer.legalName = patch.fieldEdits.customerLegalName;
  }
  if (patch.fieldEdits?.brokerLegalName !== undefined) {
    broker.legalName = patch.fieldEdits.brokerLegalName;
  }

  return {
    ok: true,
    draft: IntakeDraftSchema.parse({
      packId: draft.packId,
      draftVersion: draft.draftVersion + 1,
      updatedAt,
      customer,
      broker,
      sites: patch.fieldEdits?.sites ?? draft.sites,
      candidates,
    }),
  };
}

function scanEvidenceText(text: string, source: Omit<IntakeProvenance, 'quote'>): EvidenceHit[] {
  const hits: EvidenceHit[] = [];
  const claimed: Array<{ start: number; end: number }> = [];

  const add = (
    pattern: RegExp,
    interpret: (match: RegExpMatchArray) => Omit<EvidenceHit, 'provenance'> | undefined,
    options: { claim?: boolean } = {},
  ): void => {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const regex = new RegExp(pattern.source, flags);
    for (const match of text.matchAll(regex)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (overlaps(claimed, start, end)) continue;
      const interpreted = interpret(match);
      if (!interpreted || !interpreted.value) continue;
      hits.push({
        ...interpreted,
        provenance: {
          ...source,
          quote: supportingQuote(text, start, match[0]),
        },
      });
      if (options.claim !== false) {
        claimed.push({ start, end });
      }
    }
  };

  add(/(Warehouse|Retail)\s+site address:\s*(.+)/gi, (match) =>
    siteScopedHit('siteAddress', match[2] ?? '', match[1], text),
  );
  add(/(Warehouse|Retail)\s+MPAN\s+(\d{8,13})/gi, (match) =>
    siteScopedHit('meterIdentifier', match[2] ?? '', match[1], text),
  );
  add(/(Warehouse|Retail)\s+annual consumption\s+(\d+(?:[.,]\d+)?)\s*kWh/gi, (match) =>
    siteScopedHit('annualConsumptionKwh', digitsOnly(match[2] ?? ''), match[1], text),
  );
  add(/(Warehouse|Retail)\s+contract end date\s+(\S+)/gi, (match) =>
    siteScopedHit('contractEndDate', stripTrailingPunctuation(match[2] ?? ''), match[1], text),
  );
  add(/Schedule\s+[AB]\s+contract end date\s+(\S+)/gi, (match) =>
    siteScopedHit('contractEndDate', stripTrailingPunctuation(match[1] ?? ''), undefined, text),
  );
  add(/\bthe Harbour site\b/gi, () => ({
    field: 'siteAddress' as const,
    value: 'the Harbour site',
    siteId: null,
    associationStatus: 'AMBIGUOUS' as const,
  }));

  add(/^Customer:\s*(.+)$/gim, (match) => packLevelHit('customerLegalName', match[1] ?? ''));
  add(/^Broker:\s*(.+)$/gim, (match) => packLevelHit('brokerLegalName', match[1] ?? ''));
  add(/\bCustomer\s+([A-Z][\w .'-]*Ltd)\.?/g, (match) =>
    packLevelHit('customerLegalName', match[1] ?? ''),
  );
  add(/\bBroker\s+([A-Z][\w .'-]*Partners)\.?/g, (match) =>
    packLevelHit('brokerLegalName', match[1] ?? ''),
  );

  add(/\bsite address:\s*(.+)$/gim, (match) =>
    siteScopedHit('siteAddress', match[1] ?? '', undefined, text),
  );
  add(/\bMPAN\s+(\d{8,13})/gi, (match) =>
    siteScopedHit('meterIdentifier', match[1] ?? '', undefined, text),
  );
  add(/\b(\d+)\s*kWh\b/gi, (match) =>
    siteScopedHit('annualConsumptionKwh', digitsOnly(match[1] ?? ''), undefined, text),
  );
  add(/\bcontract end(?: date)?\s+(\S+)/gi, (match) =>
    siteScopedHit('contractEndDate', stripTrailingPunctuation(match[1] ?? ''), undefined, text),
  );
  add(/\b(\d{1,4}\s+[A-Za-z][A-Za-z0-9' -]{2,40},\s*[A-Za-z][A-Za-z' -]{2,40})\b/g, (match) =>
    siteScopedHit('siteAddress', match[1] ?? '', undefined, text),
  );

  return hits;
}

function packLevelHit(
  field: Extract<IntakeDraftField, 'customerLegalName' | 'brokerLegalName'>,
  raw: string,
): Omit<EvidenceHit, 'provenance'> | undefined {
  const value = trimValue(raw);
  if (!value) return undefined;
  return {
    field,
    value,
    associationStatus: 'RESOLVED',
  };
}

function siteScopedHit(
  field: IntakeDraftField,
  raw: string,
  explicitLabel: string | undefined,
  sourceText: string,
): Omit<EvidenceHit, 'provenance'> | undefined {
  const value = field === 'annualConsumptionKwh' ? digitsOnly(raw) : trimValue(raw);
  if (!value) return undefined;
  const association = associateSite(explicitLabel, sourceText, field);
  return {
    field,
    value,
    ...association,
  };
}

function associateSite(
  explicitLabel: string | undefined,
  sourceText: string,
  field: IntakeDraftField,
): { siteId?: string | null; associationStatus: IntakeAssociationStatus } {
  if (!SITE_SCOPED_FIELDS.has(field)) {
    return { associationStatus: 'RESOLVED' };
  }

  const labeled = normalizeSiteLabel(explicitLabel);
  if (labeled) {
    return { siteId: SITE_LABELS[labeled], associationStatus: 'RESOLVED' };
  }

  const cues = collectSiteCues(sourceText);
  if (cues.labels.size === 1) {
    const only = [...cues.labels][0]!;
    return { siteId: SITE_LABELS[only], associationStatus: 'RESOLVED' };
  }
  if (cues.labels.size > 1 || cues.harbour) {
    return { siteId: null, associationStatus: 'AMBIGUOUS' };
  }
  return { siteId: null, associationStatus: 'UNRESOLVED' };
}

function collectSiteCues(text: string): { labels: Set<SiteLabel>; harbour: boolean } {
  const labels = new Set<SiteLabel>();
  if (/\bWarehouse\b/i.test(text)) labels.add('warehouse');
  if (/\bRetail\b/i.test(text)) labels.add('retail');
  return {
    labels,
    harbour: /\bHarbour site\b/i.test(text),
  };
}

function normalizeSiteLabel(value: string | undefined): SiteLabel | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'warehouse' || normalized === 'retail') return normalized;
  return undefined;
}

function groupHitsIntoCandidates(hits: EvidenceHit[]): IntakeCandidate[] {
  const grouped = new Map<string, EvidenceHit[]>();
  for (const hit of hits) {
    const key = [hit.field, hit.value, hit.siteId ?? '', hit.associationStatus].join('\0');
    const existing = grouped.get(key);
    if (existing) existing.push(hit);
    else grouped.set(key, [hit]);
  }

  const candidates: IntakeCandidate[] = [];
  for (const group of grouped.values()) {
    const first = group[0];
    if (!first) continue;
    const provenance = uniqueProvenance(group.map((hit) => hit.provenance)).slice(0, 8);
    if (provenance.length === 0) continue;
    candidates.push({
      candidateId: '',
      field: first.field,
      value: first.value,
      siteId: first.siteId,
      associationStatus: first.associationStatus,
      accepted: false,
      provenance,
    });
  }

  candidates.sort((left, right) => compareCandidates(left, right));
  return candidates.slice(0, 200).map((candidate, index) => ({
    ...candidate,
    candidateId: `candidate-${String(index + 1).padStart(3, '0')}`,
  }));
}

function uniqueProvenance(items: IntakeProvenance[]): IntakeProvenance[] {
  const seen = new Set<string>();
  const unique: IntakeProvenance[] = [];
  for (const item of items) {
    const key = [
      item.sourceKind,
      item.sourceId,
      item.documentId ?? '',
      item.pageNumber ?? '',
      item.quote,
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function compareCandidates(left: IntakeCandidate, right: IntakeCandidate): number {
  const fieldDelta = FIELD_ORDER.indexOf(left.field) - FIELD_ORDER.indexOf(right.field);
  if (fieldDelta !== 0) return fieldDelta;
  const valueDelta = left.value.localeCompare(right.value);
  if (valueDelta !== 0) return valueDelta;
  const siteDelta = (left.siteId ?? '').localeCompare(right.siteId ?? '');
  if (siteDelta !== 0) return siteDelta;
  return left.associationStatus.localeCompare(right.associationStatus);
}

function overlaps(
  claimed: Array<{ start: number; end: number }>,
  start: number,
  end: number,
): boolean {
  return claimed.some((span) => start < span.end && end > span.start);
}

function supportingQuote(text: string, index: number, matched: string): string {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const lineEnd = text.indexOf('\n', index);
  const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
  const quote = (line || matched).trim().slice(0, 500);
  return quote.length > 0 ? quote : matched.trim().slice(0, 500);
}

function trimValue(raw: string): string {
  return stripTrailingPunctuation(raw.replace(/\s+/g, ' ').trim()).slice(0, 256);
}

function stripTrailingPunctuation(raw: string): string {
  return raw.trim().replace(/[.,;:]+$/u, '');
}

function digitsOnly(raw: string): string {
  return raw.replace(/[^\d]/g, '').slice(0, 256);
}
