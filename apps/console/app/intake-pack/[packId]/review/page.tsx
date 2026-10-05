import { IntakePackReviewScreen } from './IntakePackReviewScreen';

export const dynamic = 'force-dynamic';

export default async function IntakePackReviewPage({
  params,
}: {
  params: Promise<{ packId: string }>;
}) {
  const { packId } = await params;
  return <IntakePackReviewScreen packId={packId} />;
}
