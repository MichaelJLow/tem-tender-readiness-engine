# Domain package

This package owns the synthetic tender schemas, deterministic readiness rules, evidence references, conservative route selection, and Intake pack contracts. It has no dependency on AI providers, AWS, n8n, or UI code.

`evaluateReadiness(unknownPayload)` validates the intake/evidence boundary with Zod and evaluates all twelve `TDR-*` rules. It returns a final business route with the rule results after required documents finish processing; while a required document is `PENDING`, it returns `PROCESSING` without a route. Model-derived interpretations can be passed later as evidence signals; the policy remains deterministic.

Intake pack schemas (`intake-pack.ts`) define pack, document, extraction, candidate, provenance, draft, confirmation, limits, and failure taxonomy. They do not evaluate readiness. Only a confirmed snapshot may map onto `ReadinessInput` plus the shared `TextSource` contract used by `POST /tenders`. Extraction candidates cannot fill structured tender fields.

`intake-pack-draft.ts` turns immutable extracted pages and broker notes into a review-only draft. Conflicting values stay as multiple candidates. Uncertain site associations stay unassociated. Structured customer, broker, and site fields stay empty until an operator writes them with an explicit patch. That path does not evaluate readiness or invoke pricing. Confirmation snapshots operator-edited fields onto the existing `POST /tenders` contract; confirm is not a ready route.

`intake-pack-fixtures.ts` is the Zod inventory schema for the synthetic packs under [`fixtures/intake-packs/`](../../fixtures/intake-packs/README.md). `intake-pack-processing.ts` classifies uploads and enforces pack limits; it does not parse PDF bytes.

The confidence threshold and accepted date formats are demonstration assumptions documented in `docs/business-rules.md`.
