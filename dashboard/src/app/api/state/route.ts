import { NextResponse } from "next/server";
import { getDashboardState } from "@/lib/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const campaign = new URL(request.url).searchParams.get("campaign") ?? undefined;
  try {
    const state = await getDashboardState(campaign);
    return NextResponse.json(state);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
