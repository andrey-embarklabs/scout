import { NextResponse } from 'next/server';

// Startup/liveness probe target: no session, catalog read or render, so a slow
// page on a busy node reads as slow (readiness on /) rather than dead.
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
