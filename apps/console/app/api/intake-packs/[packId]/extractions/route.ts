import { NextRequest } from 'next/server';
import { proxyIntakePackRequest } from '../../../../../src/intake-pack-proxy';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ packId: string }> },
) {
  const { packId } = await params;
  return proxyIntakePackRequest(request, `/intake-packs/${encodeURIComponent(packId)}/extractions`);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ packId: string }> },
) {
  const { packId } = await params;
  return proxyIntakePackRequest(request, `/intake-packs/${encodeURIComponent(packId)}/extractions`);
}
