import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  draftStructuredFieldsAreEmpty,
  evaluateReadiness,
  intakeLayerMayInvokePricing,
  snapshotDraftForConfirmation,
} from '../packages/domain/src/index.js';
import { buildIntakePackFixtureCatalog } from '../scripts/intake-pack-fixtures.js';
import { MemoryIntakeOriginalsStore } from '../apps/api/src/intake-pack/originals-store.js';
import { MemoryIntakePackRepository } from '../apps/api/src/intake-pack/repository.js';
import { IntakePackService } from '../apps/api/src/intake-pack/service.js';

const catalog = buildIntakePackFixtureCatalog();

async function registerFixture(
  service: IntakePackService,
  packId: string,
  fixturePackId: string,
): Promise<void> {
  const spec = catalog.specs.find((item) => item.packId === fixturePackId);
  if (!spec) throw new Error(`Missing fixture pack ${fixturePackId}`);
  for (const file of spec.files) {
    if (file.kind === 'NOTE') {
      await service.addNote({ packId, text: file.bytes.toString('utf8') });
      continue;
    }
    await service.addDocument({
      packId,
      fileName: file.fileName,
      contentType: file.contentType,
      bytes: new Uint8Array(file.bytes),
    });
  }
}

describe('Intake pack safety invariants', () => {
  it('keeps extraction, draft, and confirmation layers from importing readiness or pricing', async () => {
    const files = [
      'apps/api/src/intake-pack/service.ts',
      'apps/api/src/intake-pack/http.ts',
      'apps/api/src/intake-pack/confirmation-adapter.ts',
      'apps/api/src/intake-pack/pdf-parser.ts',
      'packages/domain/src/intake-pack-draft.ts',
    ];
    for (const relative of files) {
      const source = await readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
      expect(source, relative).not.toMatch(/\bevaluateReadiness\b/);
      expect(source, relative).not.toMatch(/MockPricingGateway|pricingGateway/);
    }
    expect(intakeLayerMayInvokePricing('extraction')).toBe(false);
    expect(intakeLayerMayInvokePricing('draft')).toBe(false);
    expect(intakeLayerMayInvokePricing('confirmation')).toBe(false);
    expect(intakeLayerMayInvokePricing('ready-tender')).toBe(true);
  });

  it('maps confirmed extraction text onto existing DOCUMENT_TEXT and NOTE sources with empty readiness signals', async () => {
    const service = new IntakePackService(
      new MemoryIntakePackRepository(),
      new MemoryIntakeOriginalsStore(),
    );
    const created = await service.createPack();
    await registerFixture(service, created.packId, 'pack-clean-single-site');
    await service.extract(created.packId);
    const draft = await service.getDraft(created.packId);
    expect(draftStructuredFieldsAreEmpty(draft)).toBe(true);

    const pack = await service.getPack(created.packId);
    const confirmation = snapshotDraftForConfirmation({
      confirmationId: 'confirmation-safety-001',
      pack,
      actor: 'local-demo-operator',
      idempotencyKey: `confirm:${created.packId}`,
      tenderId: `tender-${created.packId}`,
      customerId: `customer-${created.packId}`,
      brokerId: `broker-${created.packId}`,
      confirmedAt: '2026-10-05T21:00:00.000Z',
    });

    expect(confirmation.submission.signals.criticalFacts).toEqual([]);
    expect(confirmation.submission.signals.dateFacts).toEqual([]);
    expect(confirmation.submission.signals.documentSiteAssociations).toEqual([]);
    expect(confirmation.submission.signals.meterSiteAssociations).toEqual([]);
    expect(confirmation.submission.textSources.map((source) => source.kind).sort()).toEqual([
      'DOCUMENT_TEXT',
      'NOTE',
    ]);
    expect(
      confirmation.submission.textSources.some((source) =>
        source.text.includes('Northstar Foods Ltd'),
      ),
    ).toBe(true);
    expect(evaluateReadiness(confirmation.submission).route).toBe('NEEDS_INFORMATION');
  });
});
