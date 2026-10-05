import { INTAKE_PACK_ENTRY_NAME } from '../../../../src/intake-pack';
import { IntakePackReviewForm } from './IntakePackReviewForm';

export function IntakePackReviewScreen({ packId }: { packId: string }) {
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CONSOLE INTAKE</span>
          <h1>{INTAKE_PACK_ENTRY_NAME}</h1>
          <p>
            Review extraction candidates beside the source page. Candidates do not fill structured
            tender fields until you write them.
          </p>
        </div>
        <span className="pill pill-neutral">Review</span>
      </div>
      <div className="notice notice-info" role="note">
        <strong>Synthetic demonstration data</strong>
        <span>
          PDFs, notes, meters, sites, and company names used here are synthetic. This is not a real
          tender, customer, or broker record, and it is not tem production data.
        </span>
      </div>
      <IntakePackReviewForm packId={packId} />
    </>
  );
}
