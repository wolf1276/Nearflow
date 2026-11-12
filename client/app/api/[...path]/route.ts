import { NextRequest, NextResponse } from "next/server";
import { venueGet } from "@/lib/near/venue-api";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const { status, body } = await venueGet(request.nextUrl);
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
export function POST() {
  return NextResponse.json({ error: "Mutations require a wallet-signed NEAR contract transaction" }, { status: 405, headers: { Allow: "GET" } });
}
