import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('bootstrap dependencies', () => {
  it('loads Zod for boundary validation', () => {
    const schema = z.object({ tenderId: z.string().min(1) });

    expect(schema.parse({ tenderId: 'synthetic-tender-001' })).toEqual({
      tenderId: 'synthetic-tender-001',
    });
  });
});
