import { NextRequest, NextResponse } from 'next/server';
import { getApiBase } from './api';
import { decodeIntakeFileNameHeader } from './intake-pack';

export async function proxyIntakePackRequest(
  request: NextRequest,
  apiPath: string,
): Promise<NextResponse> {
  try {
    const headers = new Headers();
    const contentType = request.headers.get('content-type');
    if (contentType) headers.set('content-type', contentType);
    const fileName = decodeIntakeFileNameHeader(request.headers.get('x-file-name'));
    if (fileName) headers.set('x-file-name', fileName);

    const method = request.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const body = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;

    const response = await fetch(`${getApiBase()}${apiPath}`, {
      method,
      headers,
      body,
      cache: 'no-store',
    });
    const responseType = response.headers.get('content-type') ?? 'application/json; charset=utf-8';
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { 'content-type': responseType },
    });
  } catch {
    return NextResponse.json({ error: 'TENDER_API_UNAVAILABLE' }, { status: 502 });
  }
}
