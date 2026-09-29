import { NextRequest, NextResponse } from 'next/server';
import { getApiBase } from '../../../../../src/api';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  try {
    const response = await fetch(`${getApiBase()}/tenders/${encodeURIComponent(runId)}/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: await request.text(),
      cache: 'no-store',
    });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch {
    return NextResponse.json({ error: 'TENDER_API_UNAVAILABLE' }, { status: 502 });
  }
}
