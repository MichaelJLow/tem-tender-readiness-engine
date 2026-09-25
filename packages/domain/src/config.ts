import { z } from 'zod';

/** Demonstration threshold only; it is not derived from any real tender policy. */
export const ReadinessConfigSchema = z.object({
  minimumCriticalFactConfidence: z.number().min(0).max(1).default(0.95),
});

export type ReadinessConfig = z.infer<typeof ReadinessConfigSchema>;

export const DEFAULT_READINESS_CONFIG: ReadinessConfig = ReadinessConfigSchema.parse({});
