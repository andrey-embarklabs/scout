import { NextResponse } from 'next/server';

// Startup/liveness probe target (helm/launchpad values): no session, catalog read or render.
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
