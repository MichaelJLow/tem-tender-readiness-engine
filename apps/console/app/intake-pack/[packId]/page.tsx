import { IntakePackScreen } from '../IntakePackScreen';

export const dynamic = 'force-dynamic';

export default async function IntakePackDetailPage({
  params,
}: {
  params: Promise<{ packId: string }>;
}) {
  const { packId } = await params;
  return <IntakePackScreen packId={packId} />;
}
