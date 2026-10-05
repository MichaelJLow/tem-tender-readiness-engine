# Discovery and Assumptions

## Purpose

This document separates the operational problem being demonstrated from assumptions made for the prototype.

The project explores how an internal automation could assess whether a business-energy tender is ready to proceed to pricing. It does not claim that another company currently performs these exact checks or uses this exact architecture.

## Problem statement

The operational problem being modelled is the manual effort required to:

- inspect tender information, supporting documents, and notes,
- identify missing, conflicting, or duplicate information,
- decide whether the case can proceed,
- request missing information where the problem is clear,
- escalate ambiguity where human judgment is safer.

## Intended user

The primary synthetic user is an internal tendering or operations specialist responsible for moving submitted tenders toward pricing safely and efficiently.

A secondary user is an Engine Lead or operations owner who needs to understand:

- where automation removes manual work,
- where cases escalate,
- which error classes recur,
- whether the reasoning layer clears agreed quality thresholds,
- what operational capacity is being reclaimed.

## Known vs assumed

| Area                                                    | Status                          | Working position                                                                                         |
| ------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Tendering is relevant to the role                       | Known from public role material | Tendering and Partner Activation are explicitly named operational areas.                                 |
| TypeScript, AWS, S3, GitHub, GitHub Actions             | Known from public role material | These are part of the advertised internal automation stack.                                              |
| Evals, manual QA, precision/recall, human safety valves | Known from public role material | These are explicitly described expectations.                                                             |
| Exact tender fields                                     | Assumed                         | V1 uses plausible synthetic fields such as MPAN, annual consumption, and contract end date.              |
| Exact readiness rules                                   | Assumed                         | Every `TDR-*` rule is a demonstration rule.                                                              |
| Exact handoff to pricing                                | Unknown                         | Represented by a mocked internal pricing gateway.                                                        |
| Exact AWS services used internally                      | Unknown                         | Service choices in this repo are implementation decisions, not claims about another team's architecture. |
| Current manual handling time                            | Unknown                         | Any hours-reclaimed calculation is labelled illustrative.                                                |

## Discovery questions for a real implementation

### Current process

- What event starts a tender operationally?
- Which systems hold the source information?
- What formats arrive today: forms, APIs, email, PDFs, spreadsheets, partner notes?
- What must be true before a tender is considered ready for pricing?
- What happens immediately after readiness?

### Manual work

- Which steps consume the most human time?
- Which tasks are repetitive versus judgment-heavy?
- Where does information most commonly arrive incomplete or inconsistent?
- What are the most common reasons a tender is returned or escalated?
- What is the actual handling time for a normal clean case?

### Risk and judgment

- Which mistakes are cheap and reversible?
- Which mistakes have financial, customer, regulatory, or operational consequences?
- Which fields should never be inferred automatically?
- Which sources are authoritative when evidence disagrees?
- When should the system stop and ask a human?

### Data and feedback

- Is historical labelled data available for evals?
- Can previous bad outcomes or unnecessary escalations be identified?
- What is a true positive / false positive for each route?
- What quality bar is acceptable before live traffic?

### Operations

- Who owns errors after deployment?
- How are failures surfaced today?
- What retry and replay behaviour is safe?
- Which downstream actions require idempotency?
- How should human corrections feed future evals?

## Automation hypothesis

A meaningful proportion of clean tenders may be able to clear readiness checks without manual handling, while incomplete or ambiguous cases can be surfaced with better evidence and narrower questions for a human.

The target is not 100% automation.

Success means reducing avoidable manual work without increasing unsafe downstream actions.

## Prototype success criteria

The implemented prototype demonstrates that it can:

- receive a synthetic tender through the local API or the exported n8n webhook,
- separate deterministic validation from model reasoning,
- route clean, incomplete, duplicate, and ambiguous cases correctly on the labelled set,
- show the evidence behind every routing decision in the Console and retained reports,
- block unsafe automated progression with an API-owned pricing guard,
- evaluate model-dependent behaviour against 63 labelled synthetic cases,
- capture human corrections as audit events without changing the automatic route,
- expose technical failures and recover without duplicate side effects,
- archive and restore synthetic evidence through a private S3 snapshot.

Any hours-reclaimed calculation remains illustrative and is not presented as real customer data. Final evals and manual QA are recorded in [`evals/release-evidence.json`](../evals/release-evidence.json) and [`docs/release-qa/`](release-qa/README.md). The proposed `v1.0.0` tag is packaged in [`docs/releases/v1.0.0.md`](releases/v1.0.0.md) and is created only on the confirmed SHA after that packaging merges. Optional PDF intake remains [ENG-16](https://linear.app/workwithlayer/issue/ENG-16/optional-add-realistic-synthetic-tender-packs-and-bounded-pdf-to-text).

## Verified limitations

| Area | Verified position |
| --- | --- |
| Runtime | Local API, Console, and Studio. No hosted application URL. |
| Persistence | One JSON file, one API process. Not a concurrent database. |
| Authentication | Loopback review mutations and a demo operator label. |
| Pricing | Mock gateway only; API-owned; n8n never initiates it. |
| Documents | Structured records plus already-extracted text. No PDF intake. |
| Data | Synthetic fixtures and reports only. |
| Evals | Accepted baseline and latest passing full report are distinct. Latest is not promoted. |
| AWS | Private S3 archive verified. Promotional credit balance/expiry unverified. OIDC not implemented. |

## Non-goals

V1 will not:

- recreate Rosso,
- price electricity,
- claim to encode tem's actual business policy,
- use real customer or broker data,
- integrate with real MPAN industry services,
- optimise for maximum automation rate,
- build a general-purpose chatbot,
- create a multi-agent swarm.

## Public references

- [tem](https://www.tem.energy/)
- [Senior Automation Specialist role](https://app.welcometothejungle.com/jobs/JD8rtxLu)

## Product principle

> The job is not to automate everything. The job is to identify repeatable work, automate what can be made reliable, use model reasoning where it adds real value, and preserve human judgment where uncertainty or accountability matters.
