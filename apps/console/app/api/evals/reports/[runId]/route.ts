import { NextRequest, NextResponse } from 'next/server';
import { getApiBase } from '../../../../../src/api';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  try {
    const response = await fetch(`${getApiBase()}/evals/reports/${encodeURIComponent(runId)}`, {
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
