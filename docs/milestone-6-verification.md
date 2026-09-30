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

## Remaining acceptance

No AWS resource has been created and no snapshot has been uploaded. The S3 CLI
transport still requires real account/profile setup and live verification.
Confirm account, region, credits and spending alert; configure one private
bucket; upload and restore; verify private access; then inspect the Console
against the S3-restored files. Milestone 6 remains incomplete until this is done.

Studio experiments and raw traces are separate local evidence. This snapshot
retains portable evaluation reports and application state, without copying
Studio's database or claiming that its experiments have been restored.
