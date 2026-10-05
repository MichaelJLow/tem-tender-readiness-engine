'use client';

import Link from 'next/link';
import {
  INTAKE_PACK_ENTRY_NAME,
  INTAKE_PACK_FLOW_STEPS,
  type IntakePackFlowStepId,
  type IntakePackView,
} from '../../src/intake-pack';
import { canOpenIntakeDraftReview } from '../../src/intake-pack-review';

interface Props {
  pack?: IntakePackView;
  current: IntakePackFlowStepId;
}

export function IntakePackFlow({ pack, current }: Props) {
  const reviewOpen = canOpenIntakeDraftReview(pack);
  const reviewHref =
    reviewOpen && pack ? `/intake-pack/${encodeURIComponent(pack.packId)}/review` : undefined;
  const confirmed = pack?.status === 'CONFIRMED';
  const caseHref = pack?.confirmation?.runId
    ? `/tenders/${encodeURIComponent(pack.confirmation.runId)}`
    : undefined;

  return (
    <ol className="intake-flow" aria-label={`${INTAKE_PACK_ENTRY_NAME} steps`}>
      {INTAKE_PACK_FLOW_STEPS.map((step) => {
        const isCurrent = step.id === current;
        const later =
          (step.id === 'review' && !reviewOpen) ||
          (step.id === 'confirm' && !reviewOpen && !confirmed) ||
          (step.id === 'assess' && !confirmed);
        return (
          <li
            key={step.id}
            className={`intake-flow-step${isCurrent ? ' current' : ''}${later ? ' later' : ''}`}
          >
            <strong>{step.label}</strong>
            {step.id === 'review' && reviewHref && !isCurrent ? (
              <small>
                <Link className="text-link" href={reviewHref}>
                  Open review
                </Link>
              </small>
            ) : null}
            {step.id === 'review' && !reviewOpen ? (
              <small>When the pack is reviewable</small>
            ) : null}
            {step.id === 'confirm' && reviewOpen && !confirmed ? <small>From review</small> : null}
            {step.id === 'assess' && caseHref ? (
              <small>
                <Link className="text-link" href={caseHref}>
                  Open case detail
                </Link>
              </small>
            ) : null}
            {step.id === 'assess' && !confirmed ? <small>After confirm</small> : null}
          </li>
        );
      })}
    </ol>
  );
}
