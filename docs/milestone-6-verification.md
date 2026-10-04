# Milestone 6 local archive verification

Verified on 30 September 2026 on `feat/aws-demo-archive`.

## Saved work and checks

The pre-existing Console work was backed up as a binary patch plus copies of
14 changed/untracked files. Cleanup was committed as `2e6ec89`; the archive
branch incorporates merged main, including PRs #9 and #10. The main checkout's
older, unrelated work was left intact. Milestone 5 acceptance is now checked
off in the implementation plan.

Before starting the archive, formatting, lint, typecheck, all 170 tests, and
API/Console production builds passed. After archive implementation, formatting,
lint, typecheck, all 184 tests and the API build passed. The 14 additional
archive checks cover exact state/report round trips, explicit attestations,
overwrite refusal, corrupt data, malformed schemas, unsafe handoffs, foreign
inputs, review-history errors, missing completion manifests, interrupted
uploads, path/size restrictions, baseline-pointer disagreement and common
accidental credential detection. No live model call or paid eval rerun was needed.

## Command and API evidence

A disposable copy of `data/screenshot-state-2026-09-29.json` was packaged using
`npm run demo:archive` and restored using `npm run demo:restore`. The source
was not being used by an API process. The original screenshot state stayed intact.

- Snapshot: `snapshot-2026-09-30T15-01-37-391Z-05488cbb-dbf2-48e1-b862-d78e894061d1`.
- Six members: original tender state, accepted pointer, accepted/latest JSON
  reports and their Markdown summaries. No original source documents existed
  in this fixture, and none were invented.
- Local snapshot: `data/milestone-6-local-snapshot`.
- Fresh restore: `data/milestone-6-local-restored`.

A temporary API on an automatically selected loopback port read the restored
files. HTTP queue/detail/eval projections returned successfully and verified:

- Exactly three cases: `READY_FOR_PRICING`, `NEEDS_INFORMATION`, `HUMAN_REVIEW`.
- The conflict case retained its reasoned `REQUEST_INFORMATION` disposition
  with `site-001`, `contract-a` and `contract-b`.
- Exactly one mocked handoff, belonging to `tender-clean-001`.
- Accepted run `full-2026-09-26T23-53-52.654Z` retained 49/51 workflow facts.
- Latest run `full-2026-09-28T19-39-31.237Z` retained 51/51 workflow facts.
- Restored state bytes matched the original and did not change during viewing.

## Live AWS verification

Verified on 4 October 2026 against the existing demo bucket using AWS CLI
2.37.9 and profile `tem-demo` in `us-east-2`.

- Bucket: `tender-readiness-demo-archive-20260930-7f32a19e`.
- Caller: the account root principal; the account ID is intentionally omitted
  from this public receipt. This confirms the actual caller and does not claim
  least-privilege CLI access.
- Bucket checks: all four Block Public Access settings are enabled; default
  encryption is SSE-S3 (`AES256`); versioning is enabled; object ownership is
  `BucketOwnerEnforced`.
- Fresh uploaded snapshot:
  `snapshot-2026-10-04T17-34-01-079Z-2580fa54-d3a8-423f-8cb2-c3ab64a72f66`.
  The six package members were the synthetic tender state, accepted-baseline
  pointer, and accepted/latest JSON and Markdown reports. The repository
  uploader completed successfully and publishes the manifest after members.
- Restore: `npm run demo:restore` retrieved the snapshot into the fresh path
  `data/eng2-s3-restored-2026-10-04`; checksum and schema validation passed.
  It retained the separate accepted run
  `full-2026-09-26T23-53-52.654Z` and latest run
  `full-2026-09-28T19-39-31.237Z`.
- Anonymous access: an unsigned `HEAD` request to the uploaded manifest
  returned HTTP 403.
- Existing-prefix protection: re-uploading the same package and snapshot ID
  exited unsuccessfully. S3 still showed exactly one version for each member
  and the manifest after the attempt.
- Failure-path check: the archive unit suite now explicitly verifies that a
  missing member fails before a restore directory is created. All 14 focused
  archive tests passed. The suite also checks that the manifest is written
  last and is absent after an interrupted upload.

The CLI used a temporary root-principal login because no restricted CLI role
was available in this environment. Sign out after verification; future routine
archive runs should use a dedicated principal scoped to this bucket's
`snapshots/` prefix.

## Remaining acceptance

The live archive transport, private-access checks and ENG-3 local Console
walkthrough are complete. ENG-4 tracks recording Milestone 6 acceptance and
preparing the existing archive branch for review. The AWS credit balance/expiry
was not checked during this verification. The existing budget alert was
previously recorded in Linear.

Studio experiments and raw traces are separate local evidence. This snapshot
retains portable evaluation reports and application state, without copying
Studio's database or claiming that its experiments have been restored.

## ENG-3 Console walkthrough

Verified on 4 October 2026 against a fresh local restore of the S3 snapshot above.

- Restore entrypoint: `scripts/restore-demo.ts` via the repository's `tsx`
  runtime, using the existing private bucket,
  region and snapshot listed in the live AWS verification. The destination was
  `data/eng3-s3-restored-2026-10-04`. The manifest, member hashes/sizes, tender
  state and evaluation report schemas validated before restore completed.
- The API and Console were pointed at the restored copy using
  `TENDER_STATE_PATH` and `EVALS_DIR`. The inspected queue contains exactly
  three completed fixtures: `READY_FOR_PRICING`, `NEEDS_INFORMATION` and
  `HUMAN_REVIEW`.
- The conflicting-dates case remains `HUMAN_REVIEW`. Its review event is
  `REQUEST_INFORMATION`, with the confirmation reason and citations
  `site-001`, `contract-a` and `contract-b` intact.
- The stored state contains exactly one mocked pricing handoff, belonging to
  the `tender-clean-001` ready run. Case and performance views, followed by a
  fresh API process reading the restored state, left the state-file SHA-256
  unchanged (`9404633455014D742FA1D4FB081D30E7E59D6BF1129251710F39930B8E712047`)
  and the handoff count at one.
- The accepted report remains
  `full-2026-09-26T23-53-52.654Z` with 49/51 workflow critical facts. The
  distinct latest report remains `full-2026-09-28T19-39-31.237Z` with 51/51;
  it was not promoted over the accepted pointer.
- A restore attempt targeting the already-existing destination was refused,
  and its state-file hash remained unchanged. No tender was submitted and no
  fixtures were reseeded to produce this result.

All inspected application records are synthetic. This walkthrough restores
application state and portable evaluation reports only; Studio experiments
and raw traces remain separate evidence.
