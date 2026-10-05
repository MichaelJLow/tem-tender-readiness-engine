# Applications

- [`api/`](api/) is the local Tender API. It owns intake validation, deterministic readiness, bounded interpretation, review audit, and the mocked pricing guard.
- [`console/`](console/) is the local operations Console. It reads API projections, records loopback review events, and hosts the **Intake pack** Drop/upload processing page. It does not choose routes or call pricing.
