import type { IntakeConfirmedSubmission } from '../../../../packages/domain/src/index.js';
import { TenderProcessingError, type TenderService } from '../service.js';

export type IntakeConfirmationHandoffResult = {
  tenderId: string;
  runId: string;
};

export type IntakeConfirmationHandoff = {
  submitConfirmed(
    submission: IntakeConfirmedSubmission,
    correlationId: string,
  ): Promise<IntakeConfirmationHandoffResult>;
};

/**
 * Map a confirmed Intake pack snapshot onto the existing TenderService.submit path.
 * This adapter never imports or calls the pricing gateway; only TenderService may,
 * and only after a final READY_FOR_PRICING route.
 */
export function createIntakeConfirmationHandoff(
  tenderService: TenderService,
): IntakeConfirmationHandoff {
  return {
    async submitConfirmed(submission, correlationId) {
      try {
        const response = await tenderService.submit(submission, correlationId);
        return { tenderId: response.tenderId, runId: response.runId };
      } catch (error) {
        if (error instanceof TenderProcessingError && error.response.runId) {
          return { tenderId: error.response.tenderId, runId: error.response.runId };
        }
        throw error;
      }
    },
  };
}
