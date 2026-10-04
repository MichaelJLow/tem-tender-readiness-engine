# ADR-003: Archive the local demo as private S3 snapshots

## Status

Accepted and verified for Milestone 6. Live S3 upload, fresh restore,
private-access checks, and the restored Console walkthrough completed on
2026-10-04; see the [acceptance receipt](../milestone-6-verification.md).
Promotional AWS credit balance/expiry is a non-blocking account follow-up.

## Context

The API and Operations Console already demonstrate the decision path locally.
The portfolio needs a useful AWS boundary and retained evidence without adding
hosted runtime, authentication or concurrent database work. The user narrowed
Milestone 6 to a small archive. Local tender state is one versioned JSON file;
Mastra Studio has its own separate experiment and observability storage.

## Decision

- Keep the live API, Console and Studio local. The local repository continues
  to own tender state, review events, idempotency and mocked pricing handoffs.
- Use one private S3 bucket with public access blocked, encryption and
  versioning. Account, credits, region and a budget alert are checked before
  resource creation. S3 is an archive, never the live transactional database.
- Prepare a snapshot only after the API using its state file is stopped.
  Require an explicit synthetic-data attestation. The first implementation
  accepts the three known Console fixtures with a cited request-information
  disposition and one ready-only mocked pricing handoff.
- Retain original state bytes, the accepted baseline pointer, accepted and
  latest completed full JSON reports, and available Markdown summaries.
  Optional synthetic source files are individually selected; no directory
  scan, environment file or Studio database is included.
- Use the existing AWS CLI v2 credential chain; require region and expected
  account owner. Upload under a generated snapshot prefix using conditional
  writes, and publish the completion manifest last. No new AWS SDK is needed.
- Validate manifest paths, sizes, SHA-256 checksums and application schemas
  before restoring. Create a fresh destination exclusively and never overwrite
  existing state. A partial local write has no completion manifest.
- Preserve the distinction between accepted and latest reports. Restoration
  copies evidence; it neither reprocesses tenders nor invokes pricing.

## Alternatives considered

- A hosted API, Console, database and authentication: deferred because the
  local demo meets the immediate requirement and hosting expands the scope.
- S3 as a writable state database: rejected because object storage does not
  replace the repository's review/idempotency concurrency guarantees.
- A recursive directory backup: rejected because it could include secrets,
  unrelated data and mutable Studio files.
- A new SDK or infrastructure framework: unnecessary for this manual demo;
  the CLI and explicit bucket setup are sufficient.

## Consequences

The demo remains simple and can be reproduced from retained evidence. Upload
and restore use a few bounded objects with checksums. S3 conditional writes
protect the tool's existing snapshot keys; they are not Object Lock or a
cryptographic authenticity guarantee. Checksums detect mismatched bytes, while
bucket permissions establish who may change the objects and manifest.

The initial archive intentionally supports the three-case Console walkthrough,
not arbitrary application backups. Expand its contract deliberately if the demo
fixtures change. Reviewer notes and optional files still require human inspection
as synthetic; common credential detection is an additional guard, not proof.
Studio experiments and traces remain separate; portable eval reports are retained.
Real upload/restore, private-access verification, and the restored Console
walkthrough completed before Milestone 6 was accepted. Cloud hosting requires
its own later decision.
