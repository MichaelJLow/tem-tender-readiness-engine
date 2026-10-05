# Integrations

External workflow exports and integration contracts live here.

- [`n8n/`](n8n/) contains the credential-free local tender-intake and outcome
  workflow, synthetic webhook fixtures, its response/receipt contract, and its
  reproducible walkthrough. The workflow records API outcomes but owns neither
  pricing nor real outbound information requests. The tracked
  [Milestone 7 verification receipt](../docs/milestone-7-verification.md) separates
  automated export checks from the still-required execution in a real n8n runtime.
