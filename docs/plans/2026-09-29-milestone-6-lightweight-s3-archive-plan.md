# Milestone 6 — Lightweight AWS evidence archive

## Outcome

Add one useful, inexpensive AWS element to the synthetic demo: a private S3 bucket containing reproducible snapshots of local tender state, accepted and latest eval reports, and any synthetic source files used in the walkthrough. Keep the Tender API, Mastra Studio, and Operations Console running locally. A snapshot can be downloaded into a fresh local path and used to reproduce the queue, review history, and Performance view.

S3 is object storage. The live review and idempotency state remains the existing local JSON repository; the S3 copy is a backup/archive, not a concurrent database. This matches the user's direction to keep the demo small and avoid time-consuming hosting work.

## Context and evidence

- docs/implementation-plan.md originally describes Milestone 6 as S3, AWS state, runtime, IAM, and infrastructure code. The user has now narrowed the goal to a modest AWS demonstration and wants to avoid cloud-hosting complexity.
- apps/api/src/main.ts uses JsonFileTenderRepository and TENDER_STATE_PATH. FileStateStore provides atomic local writes for one API process; TenderService serializes work in that process. This remains suitable for the local demo.
- apps/api/src/eval-reports.ts serves retained report files and the accepted-baseline pointer. The Console reads these projections from the local API. Studio stores its own local experiment/tracing data and does not receive API runs automatically.
- docs/runbook.md already defines a repeatable three-case synthetic seed. The latest full report and accepted baseline are distinct and must remain distinct in any archive.
- The current feat/ops-console worktree contains pre-existing uncommitted API/Console/runbook changes and screenshots. They must remain untouched by the archive work.
- The user has about $100 in AWS credits, but account-specific eligibility and expiry are unverified. AWS S3 charges for stored bytes and requests, with no minimum charge; a small demo should be low cost, but it is not guaranteed to be free.

## Decisions

1. Use one private S3 bucket in one AWS region. Enable Block Public Access, default encryption, and versioning. Keep the original local files and do not publish S3 URLs.
2. Archive only synthetic files. The first snapshot includes the versioned tender-state JSON, the accepted-baseline pointer and its report, the latest completed full report, and a small manifest of object keys, sizes, SHA-256 checksums, and snapshot time. Synthetic source-document files can be added where they exist; do not invent PDFs or add parsing in this milestone.
3. Use a small explicit upload/restore command or script with the normal AWS credential chain/profile. Never embed keys in code, environment examples, or committed files. An AWS CLI plus a short script is sufficient; do not introduce CDK, DynamoDB, Cognito, Lambda, or a new application framework.
4. Use immutable snapshot prefixes. Do not overwrite accepted reports or silently change which run is accepted. A restore writes to a new local directory/path, validates the manifest and state/report schema, and never overwrites an existing working state file.
5. Keep cloud backup manual for the demo. Stop the local API before snapshotting its mutable state file so the copy is consistent. Document the command and the resulting S3 layout in the runbook.
6. Cloud hosting of the API and Console is deferred. If a public hosted demo later becomes important, plan it as a separate piece of work with a cost estimate and reviewer authentication. The local Console continues to show the real seeded workflow now.

## Scope

### In scope

- Private S3 bucket definition or minimal reproducible setup instructions, a budget/credit check before creation, and limited IAM access.
- One archive command and one restore/verify command for synthetic state and durable eval evidence.
- A fresh-path restore walkthrough demonstrating the queue, the conflicting-date review record, and accepted-versus-latest Performance.
- Documentation that distinguishes local live state, S3 snapshots, and local Mastra Studio traces.

### Out of scope

- S3 as a live transactional database; DynamoDB or another database; hosting the API, Console, or Studio; public access; Cognito; automated schedules; long-term raw Studio trace migration; PDF extraction; real tender data; model, domain-rule, or pricing-policy changes.

## High-level design

Local API/Console and local JSON state remain the decision path. A manual archive tool copies a consistent state file and selected eval artifacts into a private, versioned S3 snapshot prefix and writes a manifest last. The restore tool downloads a selected complete snapshot, verifies each checksum, validates state/report structure, and writes files to a new local destination. The user points TENDER_STATE_PATH and EVALS_DIR to the restored copy, starts the local API/Console, and sees the same synthetic cases and metrics.

## Implementation units

### U-001 — Confirm AWS scope, cost, and access

- Depends on: none.
- Files: docs/runbook.md and infra/README.md.
- Outcome: choose region and bucket name, inspect the actual credit/expiry state, set a modest billing alert, and decide who may upload/download. Record that provider API charges are separate from AWS credits.
- Check: no resource creation until the account, region, permissions, and expected small usage are understood.

### U-002 — Define one private bucket

- Depends on: U-001.
- Files: proposed infra/s3-demo-archive.yaml or an equally small reproducible AWS CLI setup; infra/README.md.
- Outcome: one bucket with public access blocked, encryption and versioning enabled, no public bucket policy, and a narrowly scoped upload/restore principal.
- Check: authorized upload/download succeeds; anonymous object access and unauthorized writes fail.

### U-003 — Archive a consistent synthetic snapshot

- Depends on: U-002.
- Files: proposed scripts/archive-demo.ts (or small equivalent), package.json, docs/runbook.md.
- Outcome: with the API stopped, read TENDER_STATE_PATH and the validated eval baseline/latest report selection, check that all content is synthetic, compute checksums, upload under a unique snapshot prefix, and upload the manifest last. Fail visibly on missing or malformed files. Do not mutate local state or baseline selection.
- Check: a snapshot contains the three demo cases, review history, correct accepted/latest reports, and no credentials; an interrupted upload lacks a complete manifest and is not offered for restore.

### U-004 — Restore and demonstrate the archive

- Depends on: U-003.
- Files: proposed scripts/restore-demo.ts (or small equivalent), docs/runbook.md and README.md.
- Outcome: select a complete snapshot, verify checksums and schemas, restore into a new directory, then run the existing API and Console against those files. Keep current working state and existing reports intact.
- Check: the restored queue shows ready, needs-information, and human-review cases; the review disposition and evidence remain visible; Performance still labels accepted and latest separately; only the ready case has one mocked handoff.

### U-005 — Verify and update the roadmap

- Depends on: U-001–U-004.
- Files: docs/{implementation-plan,architecture,runbook}.md, infra/README.md, relevant archive/restore tests.
- Outcome: record the narrower Milestone 6 acceptance and defer cloud runtime and a hosted Console explicitly. Test archive/restore failure paths, then update milestone checkboxes only after a real synthetic S3 walkthrough.
- Check: format/lint/typecheck and relevant tests pass; a fresh restore works; no non-ready route gained a handoff; no secret or real data was archived.

## Verification scenarios

| Setup/input | Action | Expected result |
| --- | --- | --- |
| Three seeded synthetic cases and a recorded human review | Stop API and archive | Complete manifest and private objects; source local state unchanged. |
| Restore to a fresh path | Validate and start API/Console | Same three routes, audit event, accepted/latest report distinction, and one ready-only handoff. |
| Interrupted upload or missing object | Attempt restore | Clear failure before writing a usable state; no partial overwrite. |
| Modified object bytes or malformed JSON | Attempt restore | Checksum/schema failure; original local state untouched. |
| Anonymous request or wrong AWS principal | Read/write object | Access denied. |
| Baseline pointer differs from latest passing run | Archive and restore | Difference preserved; latest is not silently promoted. |

## Risks and mitigations

- S3 is not a safe drop-in replacement for the live mutable state file. Keep it an immutable backup and state that plainly in docs.
- Copying while the API writes could make a mixed snapshot. Stop the API first and publish the manifest only after all uploads complete.
- AWS credits can expire and S3 has storage/request charges. Confirm the account, keep the dataset small, and use a billing alert. OpenRouter/OpenAI calls remain separate.
- A snapshot may contain synthetic model inputs and reviewer notes. Keep it private, archive only known demo paths, and inspect the manifest before upload.
- Studio's local traces/experiments are not in the archive. The retained JSON/Markdown eval reports and case model-trace metadata are the durable evidence for this phase.

## Permission and operational impact

Creating the bucket, IAM access, budget alert, and uploading files require access to the user's AWS account and incur possible small usage. Planning does not authorize those external changes. No committed credentials, public AWS endpoint, or new model calls are needed. The existing local app remains the operational demo.

## Rollout and rollback

Create the bucket and verify its access policy before uploading. Keep every local source file. Rollback of the application is simply to stop using the archive scripts; no current runtime depends on S3. Preserve desired snapshots before any later bucket teardown, which is a separate decision.

## Open gates

1. Before implementation touches AWS: confirm region, account access, credits, and a small spending alert.
2. Before declaring completion: run one real synthetic archive/restore walkthrough, or mark cloud verification pending if credentials are unavailable.
3. Public cloud hosting can be considered later as its own plan if the portfolio genuinely needs a live URL.

## References

- S3 storage and request pricing: https://aws.amazon.com/s3/pricing/
- S3 Block Public Access: https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html
- AWS Free Tier credit terms: https://aws.amazon.com/free/terms/
- AWS Budgets pricing: https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/

Planning capability: user-selected SOL session. This plan does not authorize implementation or AWS resource creation.
