import { NextRequest } from 'next/server';
import { proxyIntakePackRequest } from '../../../src/intake-pack-proxy';

export async function POST(request: NextRequest) {
  return proxyIntakePackRequest(request, '/intake-packs');
}
