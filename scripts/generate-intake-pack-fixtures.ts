import { writeIntakePackFixtures } from './intake-pack-fixtures.js';

const includeGenerated = process.argv.includes('--include-generated');
const result = await writeIntakePackFixtures({ includeGenerated });
console.info(
  `Wrote ${result.written.length} Intake pack fixture files${includeGenerated ? ' including generated limit blobs' : ''}.`,
);
console.info(result.manifestPath);
