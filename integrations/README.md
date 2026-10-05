# Integrations

External workflow exports and integration contracts live here.

- [`n8n/`](n8n/) contains the credential-free local tender-intake and outcome
  workflow, synthetic webhook fixtures, its response/receipt contract, and its
  reproducible walkthrough. The workflow records API outcomes but owns neither
  pricing nor real outbound information requests. The
  [Milestone 7 verification receipt](../docs/milestone-7-verification.md) records
  the export checks, the fresh n8n `1.112.6` execution matrix, and the merge
  commit on `main`. Document registration/upload and PDF intake remain deferred.
