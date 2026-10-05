# ENG-15 secrets and security check — 2026-10-05

Tracked, history-aware review of published paths before the proposed `v1.0.0`
tag. This is not a penetration test and not a claim of production security
posture.

Reviewed `main` HEAD: `1917116f1291e628a58d97882e617916ea2ea568`
(ENG-14 / PR #23). Packaging docs in this PR do not add credentials.

## Scope

- Current tree, excluding `node_modules/`, `.git/`, and `package-lock.json`
- Git history for `.env` files, private keys, AWS access-key prefixes, provider
  keys, GitHub PATs, and S3 presigned-URL query parameters
- n8n workflow export, eval reports, QA receipts, archive scripts, and
  `.env.example`
- Public claims in README and docs (synthetic data, mocked pricing, no tem
  process/Rosso reproduction)

Out of scope: live AWS account enumeration, OCR of Console screenshots, and
re-running live n8n or private S3 on SHA `9fbf16f`.

## Method

gitleaks and trufflehog were not installed in this environment. The check used
repository ignore rules, the archive credential detector, and git history:

```sh
git log --all --full-history --name-only --pretty=format: -- '.env' '.env.*'
git log --all --pickaxe-regex -S 'AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|X-Amz-Signature=|sk-or-v1-[A-Za-z0-9]{8,}' --oneline
git log --all -S 'BEGIN RSA PRIVATE KEY' --oneline
git log --all -S 'BEGIN OPENSSH PRIVATE KEY' --oneline
rg -n --hidden -g '!.git/**' -g '!node_modules/**' -g '!package-lock.json' \
  -e 'AKIA[0-9A-Z]{16}' -e 'ASIA[0-9A-Z]{16}' \
  -e 'X-Amz-(Algorithm|Credential|Signature|Security-Token|Expires)=' \
  -e 'sk-[A-Za-z0-9]{20,}' -e 'BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY' \
  -e 'aws_secret_access_key' -e 'ghp_[A-Za-z0-9]{20,}' -e 'github_pat_' \
  -e 'presigned' -e 'amazonaws\.com'
```

`.gitignore` already excludes `.env`, `.env.*` (except `.env.example`), key
material, `secrets/`, and local `data/`. `scripts/demo-archive.ts` rejects
common credential patterns before snapshotting sources.

## Findings

| Check | Result |
| --- | --- |
| Live credentials in HEAD | None found |
| Presigned S3 URLs (`X-Amz-Signature`, `amazonaws.com` query URLs) | None found in HEAD or pickaxe history |
| AWS access key IDs (`AKIA` / `ASIA`) | None found |
| Provider keys (`sk-`, OpenRouter, OpenAI) in published files | None. `.env.example` has empty `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / `MODEL_API_KEY` |
| `.env` committed | Only `.env.example` appears in history |
| n8n export | No `credentials` / `apiKey` / `password` nodes. Webhook IDs are local workflow identifiers |
| Eval reports | No `Authorization` / `Bearer` / `apiKey` fields |
| Real customer, broker, or tem operational data | Fixtures use synthetic names and site IDs. Docs state this is not tem's process or pricing |
| Account identifiers | Milestone 6 receipt names the private demo bucket and omits the AWS account ID |
| Misleading pricing/process claims | README and architecture still stop at the mocked `READY_FOR_PRICING` handoff |

Known synthetic placeholder (not a leaked secret):
`scripts/demo-archive.test.ts` writes `sk-or-v1-` plus forty `x` characters and
expects archive preparation to refuse it.

## Honest gaps

- No dedicated secret-scanning binary ran (gitleaks/trufflehog unavailable).
- Binary Console screenshots were not OCR’d; they are local UI captures of
  synthetic cases.
- Live n8n `1.112.6` and live private S3 were not re-executed on eval SHA
  `9fbf16f`. ENG-7 and ENG-4 remain those receipts.
- The association-check product fix described in eval findings is still
  unlanded; it is a behaviour limitation, not a credential leak.
- GitHub’s review list on PR #23 is empty even though `MichaelJLow` merged it.
  CODEOWNERS review of this packaging PR should avoid those protected paths.

## Local packaging checks (ENG-15)

On this packaging branch, after `npm ci`:

| Command | Result |
| --- | --- |
| `npm run check` (format, lint, typecheck, 243 tests) | Pass |
| `npm run build:api` / `npm run build:console` | Pass |
| `npm run evidence:release` | **Fail** — `9fbf16f` is not an ancestor of HEAD after the PR #23 squash. Relevant product-source diff vs that SHA is empty. Pointer files were not changed. |

## Verdict

Published paths on the reviewed `main` HEAD do not contain credentials,
presigned URLs, or real customer data. Empty key placeholders stay in
`.env.example`. The public interview snapshot should keep that boundary: no
secrets in the tag, no live-environment URLs, no claim that this is tem's
pricing stack.
