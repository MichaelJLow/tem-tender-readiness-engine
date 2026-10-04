# Milestone 7 n8n verification receipt

## Purpose and status

This receipt distinguishes inspectable repository checks from an actual n8n
execution. Milestone 7 is **awaiting human/live-runtime verification**. Unit
tests that execute exported Code-node JavaScript are useful contract evidence,
but they are not presented as a fresh n8n import or executed-canvas evidence.

## Versioned inputs

- Workflow: `integrations/n8n/tender-intake.workflow.json`
- Workflow name: `Tender intake and outcome handling`
- Required n8n version: `1.112.6`
- Source revision used to prepare this receipt: `edb7162`
- API contract: `POST /tenders`
- Walkthrough and endpoint configuration: `integrations/n8n/README.md`
- Synthetic scenario fixtures: `clean.json`, `needs-information.json`,
  `human-review.json`, `pending.json`, and `duplicate.json`

The source revision above is the starting revision. Replace it with the merged
commit SHA during review so the receipt points to the immutable accepted export.

## Automated evidence recorded on 4 October 2026

| Input                           | Action                                                  | Observed outcome                                                                                                                               |
| ------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Export and walkthrough fixtures | `npm test -- integrations/n8n/workflow.test.ts`         | Passed: 31 tests covered export shape/security, normalization, route receipts, pending behavior, technical errors, IDs, and pricing ownership. |
| Repository                      | `npm run format:check`                                  | Passed as part of `npm run check`.                                                                                                             |
| Repository                      | `npm run lint`                                          | Passed as part of `npm run check`.                                                                                                             |
| Repository                      | `npm run typecheck`                                     | Passed as part of `npm run check`.                                                                                                             |
| Repository                      | `npm test`                                              | Passed: 18 files and 226 tests as part of `npm run check`.                                                                                     |
| n8n `1.112.6` npm runtime       | `npm exec --yes --package=n8n@1.112.6 -- n8n --version` | Environment limitation: installation stopped on a `403` fetching SheetJS from `cdn.sheetjs.com`; no n8n runtime execution is claimed.          |

The export test asserts that there are no credential bindings, API keys, copied
domain rule identifiers/prompts, review mutations, mail/chat nodes, or a second
HTTP handoff. The only HTTP Request node calls the Tender API. Fixtures contain
synthetic names and references only.

## Required fresh-runtime execution record

Run the [ordered walkthrough](../integrations/n8n/README.md#reproducible-route-walkthrough)
against a clean API state and fill every row from actual n8n executions. Record
the n8n execution ID or attach a screenshot/export reference; an illustrative
canvas is not sufficient.

| Scenario input                      | Action                               | Required observed outcome                                                                    | Execution evidence |
| ----------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------ |
| `clean.json`                        | POST through active imported webhook | `READY_FOR_PRICING`; one API handoff; `PRICING_HANDOFF_RECORDED`; IDs retained               | Pending            |
| `needs-information.json`            | POST through webhook                 | `NEEDS_INFORMATION`; non-delivering information receipt; no handoff                          | Pending            |
| `human-review.json`                 | POST through webhook                 | `HUMAN_REVIEW`; Console run path and both synthetic evidence references retained; no handoff | Pending            |
| `pending.json`                      | POST through webhook                 | HTTP `202`; `PROCESSING`; no route or handoff                                                | Pending            |
| `duplicate.json` after `clean.json` | POST through webhook                 | `DUPLICATE`; clean run remains the only handoff                                              | Pending            |
| Valid fixture with API stopped      | POST through webhook                 | HTTP `502`; correlated `TECHNICAL_ERROR`; no successful business action                      | Pending            |
| API `GET /tenders` projection       | Inspect after route sequence         | All run/correlation IDs reconstructable and exactly one pricing handoff                      | Pending            |

## Review and merge gate

- [ ] Fresh import performed with n8n `1.112.6` and documented endpoint setting.
- [ ] Actual execution evidence is attached for every row above.
- [ ] Export rechecked for credentials, secrets, real recipients/customer data,
      and machine-specific credential IDs.
- [ ] Pull request URL recorded: pending.
- [ ] Merge commit recorded and substituted for the starting revision: pending.
- [ ] Reviewer confirms the API still owns the `READY_FOR_PRICING` guard.

Stop for human review after opening the PR. Mark Milestone 7 complete only after
these boxes are checked and the PR is merged.
