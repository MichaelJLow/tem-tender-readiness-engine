# Applications

- [`api/`](api/) is the local Tender API. It owns intake validation, deterministic readiness, bounded interpretation, review audit, and the mocked pricing guard.
- [`console/`](console/) is the local operations Console. It reads API projections and records loopback review events. It does not choose routes or call pricing.
