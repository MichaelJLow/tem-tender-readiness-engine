# ADR-001: Keep the bounded Mastra agent in the API workspace

## Status

Accepted

## Context

Milestone 3 adds semantic interpretation for tender notes and already-extracted document text. The API owns intake validation, persistence, deterministic readiness rules, routing, and the pricing guard. A separate agent service or repository would add deployment and transport boundaries before this milestone needs them.

## Decision

Implement one tool-free Mastra Tender Interpretation Agent inside `apps/api`. Invoke it through the `TenderInterpreter` interface only when text sources are present. The adapter uses an OpenAI-compatible API client with a configurable endpoint, model ID, and provider-specific credential. OpenAI and OpenRouter are configured directly; other compatible endpoints can use generic overrides.

The agent returns schema-validated evidence, observations, site associations, and conflicts. API code validates citations and associations, converts them into readiness signals, and leaves all final routing and pricing authorization to deterministic domain code. The agent has no pricing tools and cannot fill missing structured fields.

Document facts require a source-backed site association. Every site-scoped fact must cite a quote containing a unique known site identifier, meter identifier, or full address, including in a single-site tender. The site identity and fact value must occur in the same quote. Missing or contradictory attribution, and explicit unknown site labels even when the model omits observations, route to human review. The API classifies invalid structured model output separately from retryable provider failures.

## Alternatives considered

- Run Mastra as a separate service or repository: introduces deployment, network, and authentication concerns without a current requirement.
- Call a model directly from the API without Mastra: reduces framework dependencies but does not match the planned reasoning layer.
- Allow model output to update tender fields or choose the final route: reduces the safety separation and is excluded by project policy.

## Rationale

The API already owns the tender lifecycle, and the initial agent is a synchronous, bounded step in that lifecycle. Keeping it in the existing API workspace makes the behavior easy to test while preserving a `TenderInterpreter` port so a different provider adapter can be added later.

Provider credentials are provider-specific. Configurable endpoints do not make one provider's key valid for another provider.

## Consequences

- The API process needs the configured model-provider credential only when interpretation is requested.
- A provider outage or invalid model evidence fails the run without assigning a business route or contacting pricing.
- A local Mastra Studio instance registers the same agent definition and persists its own traces, logs, metrics, and experiment state. The tender API runs separately and retains its own model trace records; Studio does not automatically display API calls.
- A separate Mastra service can be considered later if an independent deployment or shared agent runtime becomes a concrete requirement; that would require a new ADR.
