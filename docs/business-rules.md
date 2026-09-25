# Business Rules and Decision Policy

> **Important:** all rules in this document are synthetic demonstration rules. They are not claims about tem's real tender policy. A real implementation would elicit and approve these rules with the relevant Engine Lead and domain experts.

## Decision outputs

The domain layer may produce four business routes:

- `READY_FOR_PRICING`
- `NEEDS_INFORMATION`
- `HUMAN_REVIEW`
- `DUPLICATE`

Technical execution separately tracks:

- `RECEIVED`
- `PROCESSING`
- `COMPLETED`
- `FAILED`

## Decision precedence

If multiple rules trigger, use the most conservative applicable route:

```text
DUPLICATE
    ↓
HUMAN_REVIEW
    ↓
NEEDS_INFORMATION
    ↓
READY_FOR_PRICING
```

A technical exception changes processing status to `FAILED` without silently changing the underlying business route.

## Rule contract

Every rule should return a consistent structure:

```ts
export type RuleResult = {
  ruleId: string
  passed: boolean
  route?: TenderRoute
  severity: "info" | "blocking" | "review"
  reason: string
  evidence: EvidenceRef[]
}
```

Rules should be independently testable and free of AWS, UI, n8n, and model-provider concerns.

## V1 rules

### TDR-001 - Customer legal name required

**Input:** normalized customer record  
**Condition:** legal name is empty after normalization  
**Route:** `NEEDS_INFORMATION`  
**Reason:** tender cannot be associated reliably with a customer  
**Tests:** blank, whitespace, valid legal name

### TDR-002 - At least one site required

**Input:** tender sites  
**Condition:** zero sites  
**Route:** `NEEDS_INFORMATION`  
**Reason:** there is no supply location to assess  
**Tests:** zero, one, multiple sites

### TDR-003 - Each site requires a meter identifier

**Input:** each site  
**Condition:** meter identifier missing  
**Route:** `NEEDS_INFORMATION`  
**Reason:** site cannot be uniquely associated with a meter for the synthetic pricing handoff  
**Tests:** all present, one missing in a multi-site case

### TDR-004 - Annual consumption required

**Input:** each site  
**Condition:** annual consumption missing or non-positive  
**Route:** `NEEDS_INFORMATION`  
**Reason:** synthetic pricing readiness requires a usable consumption figure  
**Tests:** missing, zero, negative, positive

### TDR-005 - Contract end date required and parseable

**Input:** site contract end date  
**Condition:** missing or cannot be normalized to an accepted date  
**Route:** `NEEDS_INFORMATION`  
**Reason:** timing is required for the synthetic downstream handoff  
**Tests:** ISO date, normalized UK date, malformed date, missing

### TDR-006 - Conflicting critical dates

**Input:** normalized date facts from credible sources  
**Condition:** two facts refer to the same site/field but disagree  
**Route:** `HUMAN_REVIEW`  
**Reason:** system can identify the disagreement but cannot invent source authority  
**Tests:** matching dates, conflicting dates, dates belonging to different sites

### TDR-007 - Unresolved document-to-site association

**Input:** extracted document facts and site candidates  
**Condition:** supporting evidence cannot be associated with a single site under the agreed policy  
**Route:** `HUMAN_REVIEW`  
**Reason:** applying information to the wrong site can create a false readiness decision  
**Tests:** explicit site ID, strong match, ambiguous multi-site case

### TDR-008 - Conflicting meter/site association

**Input:** meter facts, addresses, and site associations  
**Condition:** the same meter identifier appears associated with incompatible sites or evidence conflicts materially  
**Route:** `HUMAN_REVIEW`  
**Reason:** critical identity conflict  
**Tests:** consistent, duplicate formatting, genuine conflict

### TDR-009 - Duplicate tender

**Input:** normalized customer/site/contract-period identity plus idempotency key  
**Condition:** an active matching tender already exists or the intake event was already processed  
**Route:** `DUPLICATE`  
**Reason:** prevent duplicate operational cases and downstream actions  
**Tests:** repeated webhook, same tender ID, similar customer but different period

### TDR-010 - Critical extraction below safety threshold

**Input:** agent-derived critical fact  
**Condition:** required fact is ambiguous or does not satisfy the configured evidence/safety policy  
**Route:** `HUMAN_REVIEW`  
**Reason:** uncertainty on a critical extracted field should not become an automatic pricing handoff  
**Tests:** high-quality evidence, ambiguous evidence, contradictory evidence

### TDR-011 - Required document cannot be processed

**Input:** document-processing result  
**Condition:** required document is unreadable, unsupported, corrupted, or parsing fails terminally  
**Route:** `HUMAN_REVIEW`  
**Reason:** system cannot establish enough evidence to proceed safely  
**Tests:** valid text PDF, corrupted file, unsupported fixture

### TDR-012 - Readiness satisfied

**Input:** aggregate rule results  
**Condition:** no duplicate, no review rule, no missing-information rule, all mandatory checks satisfied  
**Route:** `READY_FOR_PRICING`  
**Reason:** tender is complete and consistent according to V1 synthetic policy  
**Tests:** canonical happy path, multi-site happy path

## AI output is evidence, not policy

The model may produce structured facts such as:

```json
{
  "field": "contractEndDate",
  "value": "2027-03-31",
  "sourceId": "contract-1",
  "confidence": 0.97,
  "ambiguous": false
}
```

The TypeScript policy evaluates those facts. Prompt text should not hide business rules that can be expressed explicitly in code.

## Source authority

V1 deliberately does not invent a universal source hierarchy. If two credible sources disagree on a critical fact and no explicit synthetic rule makes one authoritative, route to `HUMAN_REVIEW`.

## Safety invariant

> **No case may invoke the pricing gateway unless the final business route is `READY_FOR_PRICING`.**

This invariant must be enforced in code and covered by automated tests.

## Idempotency invariant

Repeating the same intake or replaying a failed workflow must not create duplicate tender records, pricing requests, information requests, or human-review tasks.

## Audit invariant

Every route must be reconstructable from:

- rules executed,
- facts evaluated,
- evidence sources,
- model invocation metadata where applicable,
- final routing result,
- human override where applicable.

## Change policy

A material business-rule change should include:

1. implementation change,
2. unit tests,
3. affected eval fixtures,
4. rationale where behaviour changes,
5. successful regression suite before release.
