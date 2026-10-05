import { INTAKE_PACK_ENTRY_NAME } from '../../src/intake-pack';
import { IntakePackForm } from './IntakePackForm';

export function IntakePackScreen({ packId }: { packId?: string }) {
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">CONSOLE INTAKE</span>
          <h1>{INTAKE_PACK_ENTRY_NAME}</h1>
          <p>Drop synthetic PDFs and paste broker notes. There is no tender form on this path.</p>
        </div>
        <span className="pill pill-neutral">Drop + extract</span>
      </div>
      <div className="notice notice-info" role="note">
        <strong>Synthetic demonstration data</strong>
        <span>
          PDFs, notes, meters, sites, and company names used here are synthetic. This is not a real
          tender, customer, or broker record, and it is not tem production data.
        </span>
      </div>
      <IntakePackForm initialPackId={packId} />
    </>
  );
}
