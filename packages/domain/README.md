# Domain package

This package owns the synthetic tender schemas, deterministic readiness rules, evidence references, and conservative route selection. It has no dependency on AI providers, AWS, n8n, or UI code.

`evaluateReadiness(unknownPayload)` validates the intake/evidence boundary with Zod and evaluates all twelve `TDR-*` rules. It returns a final business route with the rule results after required documents finish processing; while a required document is `PENDING`, it returns `PROCESSING` without a route. Model-derived interpretations can be passed later as evidence signals; the policy remains deterministic.

The confidence threshold and accepted date formats are demonstration assumptions documented in `docs/business-rules.md`.
