import {
  conflictingDatesTender,
  cleanTender,
  missingConsumptionTender,
} from '../tests/fixtures/tenders.js';

const apiBase = (process.env.TENDER_API_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const examples = [cleanTender, missingConsumptionTender, conflictingDatesTender];

for (const tender of examples) {
  const response = await fetch(`${apiBase}/tenders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tender),
  });
  const result = (await response.json()) as {
    tenderId?: string;
    route?: string;
    status?: string;
    failure?: { code: string };
    error?: string;
  };

  if (!response.ok) {
    throw new Error(`Unable to seed ${tender.tender.tenderId}: ${result.error ?? response.status}`);
  }

  console.info(
    `${result.tenderId}: ${result.route ?? result.status}${result.failure ? ` (${result.failure.code})` : ''}`,
  );
}
