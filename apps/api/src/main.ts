import { resolve } from 'node:path';
import { JsonFileTenderRepository, FileStateStore } from './file-repository.js';
import { MockPricingGateway } from './pricing-gateway.js';
import { createTenderServer } from './server.js';
import { TenderService } from './service.js';

const port = parsePort(process.env.PORT ?? '3000');
const statePath = resolve(process.env.TENDER_STATE_PATH ?? './data/tender-state.json');
const repository = new JsonFileTenderRepository(new FileStateStore(statePath));
const service = new TenderService(repository, new MockPricingGateway(repository));
const server = createTenderServer(service);

server.listen(port, () => {
  console.info(JSON.stringify({ event: 'api.listening', port, statePath }));
});

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535.');
  }
  return port;
}
