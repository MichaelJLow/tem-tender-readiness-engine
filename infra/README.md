# Infrastructure

Milestone 6 uses one private S3 bucket for synthetic demo evidence snapshots.
The API, Operations Console and Mastra Studio remain local. Account access,
the bucket configuration, and the S3 archive/restore transport have been
verified and accepted. The promotional AWS credit balance/expiry remains an
account-administration follow-up, not an archive correctness gate. See the
[Milestone 6 acceptance receipt](../docs/milestone-6-verification.md).

## Minimal setup

Before creating resources, confirm the AWS account, chosen region, credit
balance/expiry and a small spending alert. Provider model charges are separate.
Record only non-secret setup details; configure credentials through AWS CLI
v2's normal profile or credential chain outside this repository.

In the S3 Console create one general-purpose bucket with:

- Block all public access enabled.
- Object Ownership set to bucket owner enforced (ACLs disabled).
- Default SSE-S3 encryption enabled.
- Versioning enabled.
- No public bucket policy or website hosting.

Use a dedicated archive principal with access limited to this bucket's
`snapshots/` prefix. The archive/restore tools require `s3:PutObject` and
`s3:GetObject` there (`HeadObject` uses the same read permission). They do not
need delete, list-all-buckets or resource-administration permissions. The
account administrator can verify bucket configuration separately. Require TLS
in the bucket policy. Keep all four public-access blocks enabled and verify
authorized upload/download, denied anonymous reads and denied unauthorized
writes during the live AWS walkthrough.

The CLI requires the expected 12-digit bucket owner and explicit region for
each archive/restore. Conditional `PutObject` writes refuse existing keys;
versioning is a recovery aid, not a substitute for permission boundaries.
The completion manifest is uploaded last. Partial uploads remain diagnostic
objects under their unique prefix and are never selected for restore.

See the [archive/restore runbook](../docs/runbook.md#milestone-6-archive-and-restore)
and [ADR-003](../docs/adr/003-private-s3-demo-snapshots.md).

References: [conditional S3 uploads](https://docs.aws.amazon.com/cli/latest/reference/s3api/put-object.html),
[S3 downloads](https://docs.aws.amazon.com/cli/latest/reference/s3api/get-object.html),
[Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html).
