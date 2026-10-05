# ENG-12 reliability rehearsal receipt

This receipt records the Milestone 8 operational story:

`visible failure → no unsafe action → safe recovery`

ENG-8, ENG-9, and ENG-10 already own duplicate delivery, failure
classification, bounded retries, and operator replay. This rehearsal does not
rebuild those guarantees. It walks the implemented paths with disposable
synthetic fixtures and records effect counts from retained state, not HTTP
status alone.

The accepted eval baseline is unchanged. No live model eval was run. S3 is an
archive concern only; it is not in the live decision path.

Deterministic coverage: `tests/reliability-rehearsal.test.ts`, plus the
existing ENG-8/9/10 suites it reuses.

## What was already covered

| Path                                         | Already owned by    | What those tests already prove                                                                                                                                                                |
| -------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate webhook / restart replay           | ENG-8               | Same n8n fixture/key keeps one run and one ready handoff; changed payload is `409`; new key on an active tender is `DUPLICATE`; missing-information receipts and review tasks do not multiply |
| Failure code, stage, retryability, safe logs | ENG-9               | Provider, invalid output, state read/write, transport, and gateway failures stay distinguishable; logs omit secrets and source text                                                           |
| Bounded automatic retry and exhaustion       | ENG-10              | Three attempts per eligible stage; exhausted runs stay `FAILED`; a retained `READY_FOR_PRICING` route is not treated as a successful handoff                                                  |
| Archive missing member                       | Milestone 6 / ENG-2 | Restore refuses a missing object before creating the destination                                                                                                                              |

## Gap this rehearsal closes

The runbook still listed these cases as future work. There was no single
operator-facing receipt that recorded setup, observable signal, retryability,
replay action, and before/after effect counts for every required path, and no
HTTP/Console-readable demonstration of a complete recovery after a mocked
downstream `500`.

## Rehearsed cases

Counts use disposable file state: `runs`, `handoffs`,
`informationRequestReceipts`, and `reviewEvents`. Handoffs remain
API-owned and occur only for `READY_FOR_PRICING`.

### 1. Provider unavailable / timeout

| Field                    | Recorded result                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Setup                    | Synthetic clean tender plus one note. Inject a retryable `MODEL_PROVIDER_FAILED` timeout. Hold the ENG-10 backoff after attempt 1.                                 |
| Observable signal        | Retained run is `FAILED` with `failure.code=MODEL_PROVIDER_FAILED`, `stage=INTERPRETATION`, `attempt=1`. No business route. Failed model trace remains on the run. |
| Retryability             | `true` until the three-attempt budget is exhausted.                                                                                                                |
| Operator / replay action | Restore the provider and let the same submit continue, or replay the same idempotency key. Do not invent a new key for the same tender identity.                   |
| Before / after counts    | During outage: `runs=1`, `handoffs=0`, `receipts=0`, `reviewEvents=0`. After recovery: `runs=1`, `handoffs=1`. Same `runId`. Interpreter calls `2`.                |

Exhausted same-key replay stays `FAILED` with zero handoffs. That ENG-10
terminal path is unchanged.

### 2. Malformed model output

| Field                    | Recorded result                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Setup                    | Same text-bearing clean fixture. Inject schema-invalid interpreter output (`summary` empty).                                                                       |
| Observable signal        | HTTP `500`, `MODEL_OUTPUT_INVALID`, no business route, failed trace retained.                                                                                      |
| Retryability             | `false` for the same model output. Automatic retry does not run.                                                                                                   |
| Operator / replay action | Inspect the retained trace/schema diagnostics. Fix prompt/schema/eval fixtures, then use a separately approved replay. Same-key replay returns the stored failure. |
| Before / after counts    | After failure and after replay: `runs=1`, `handoffs=0`, `receipts=0`, `reviewEvents=0`. Interpreter calls remain `1`.                                              |

### 3. Persistence read / write failure

| Field                    | Recorded result                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Setup                    | Inject a store read fault, then a store write fault, against an empty disposable state file.                        |
| Observable signal        | `STATE_READ_FAILED` / `STATE_WRITE_FAILED` with `retryable=true`. No run is created while storage is unavailable.   |
| Retryability             | Retryable after storage is restored. The API does not automatically retry state faults.                             |
| Operator / replay action | Preserve the file, restore readability/writes, then resubmit the same payload and idempotency key.                  |
| Before / after counts    | During both faults: `runs=0`, `handoffs=0`, `receipts=0`, `reviewEvents=0`. After recovery: `runs=1`, `handoffs=1`. |

A failure to persist another failure remains `STATE_WRITE_FAILED` with
`causeCode` set to the original classification. That ENG-9/10 path is
unchanged.

### 4. Mocked downstream 500 — complete visible recovery

This is the API/Console/n8n demonstration.

| Field                    | Recorded result                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup                    | Submit `integrations/n8n/fixtures/clean.json` to `POST /tenders`. Inject a mocked gateway `500` and hold backoff after attempt 1.                                                                                                                                                                                                                                         |
| Observable signal        | `GET /tenders` and `GET /tenders/:runId` show `FAILED` + retained `READY_FOR_PRICING` + `PRICING_GATEWAY_FAILED` attempt 1. n8n records `TECHNICAL_ERROR` with `outboundMessagesSent=0`. Console queue/detail read these same projections.                                                                                                                                |
| Retryability             | `true` after the first failed attempt.                                                                                                                                                                                                                                                                                                                                    |
| Operator / replay action | Restore the mocked gateway and let the in-flight retry complete, or replay the same key. n8n does not call pricing.                                                                                                                                                                                                                                                       |
| Before / after counts    | During the `500`: `runs=1`, `handoffs=0`. After recovery: HTTP `200`, `COMPLETED`, same `runId`, `handoffs=1`. n8n outcome becomes `PRICING_HANDOFF_RECORDED` with `handoffAttemptsInitiatedByWorkflow=0`. A second webhook-equivalent POST stays `replayed=true` with `handoffs=1`. The gateway is consulted for the existing key and does not persist a second handoff. |

The retained ready route during the outage is the business decision only. It
does not authorize a second handoff or treat the failed run as a successful
pricing call.

### 5. Duplicate webhook delivery

| Field                    | Recorded result                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Setup                    | Normalize and submit the same n8n clean fixture twice through the existing workflow JS and Tender API.                                                 |
| Observable signal        | First delivery is `COMPLETED` / `READY_FOR_PRICING` / `PRICING_HANDOFF_RECORDED`. Redelivery is `replayed=true` with the same `runId` and outcome key. |
| Retryability             | Not a failure. Idempotent replay.                                                                                                                      |
| Operator / replay action | Repeat the unchanged fixture. Do not change the payload under the same key.                                                                            |
| Before / after counts    | After first and second delivery: `runs=1`, `handoffs=1`, `receipts=0`, `reviewEvents=0`.                                                               |

### 6. Archive read / missing-object failure

| Field                    | Recorded result                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup                    | Prepare a synthetic demo snapshot from the three seeded Console cases. Restore with the state member missing.                                                                                        |
| Observable signal        | Restore throws `Object not found.` and does not create the destination directory.                                                                                                                    |
| Retryability             | Retryable after the snapshot is repaired or a complete prefix is selected. This is an archive/restore fault, not a live intake failure code.                                                         |
| Operator / replay action | Preserve the incomplete destination if one exists from a later write error. Use a new empty destination after the snapshot is complete. Do not reseed or resubmit live tenders to "fix" the archive. |
| Before / after counts    | Live decision state is unchanged: `runs=3`, `handoffs=1`, one synthetic `NOT_SENT` information-request receipt, one review event. No new pricing handoff.                                            |

S3/object storage is not consulted by `POST /tenders`, readiness rules,
interpretation, or the mocked pricing guard.

## Safety invariants checked

- No non-ready route created a pricing handoff.
- No recovery created a second handoff, information-request receipt, or review
  event.
- Invalid model output and exhausted retries stayed `FAILED`.
- The accepted baseline pointer and latest-vs-accepted distinction were not
  modified.
