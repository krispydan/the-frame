export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { fetchFairePackingSlip } from "@/modules/integrations/lib/faire/packing-slip";
import { verifyPackingSlipUrl } from "@/modules/integrations/lib/faire/signed-url";

/**
 * GET /api/v1/integrations/faire/packing-slip?order=bo_xxx&exp=...&sig=...&display=...
 *
 * Signed-URL proxy that ShipHero pulls from. ShipHero's order_add_attachment
 * mutation takes a `url` field rather than a base64 body — they fetch the
 * document themselves. This route accepts a short-lived (24h) HMAC-signed
 * URL minted at attach time, re-fetches the corresponding Faire packing-slip
 * PDF, and streams it back.
 *
 * The signed URL binds to a single Faire order id and expires automatically,
 * so leaking one URL would only expose one customer's packing slip until
 * `exp` passes — and not the Faire API token itself.
 *
 * See: docs/shiphero-webhooks-and-faire-slips.md
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const faireOrderId = url.searchParams.get("order") || "";
  const expRaw = url.searchParams.get("exp") || "";
  const sig = url.searchParams.get("sig") || "";
  const displayId = url.searchParams.get("display") || undefined;

  if (!faireOrderId || !expRaw || !sig) {
    return NextResponse.json(
      { error: "Missing order, exp, or sig parameter" },
      { status: 400 },
    );
  }

  const exp = Number(expRaw);
  const verify = verifyPackingSlipUrl({ faireOrderId, exp, signature: sig });
  if (!verify.ok) {
    return NextResponse.json({ error: verify.reason }, { status: 401 });
  }

  try {
    const slip = await fetchFairePackingSlip(faireOrderId, { displayId });
    return new NextResponse(new Uint8Array(slip.pdf), {
      status: 200,
      headers: {
        "Content-Type": slip.contentType,
        "Content-Length": String(slip.size),
        "Content-Disposition": `inline; filename="${slip.filename}"`,
        // Defense in depth — don't let the PDF be cached by any intermediary.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[faire-packing-slip-proxy]", msg);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
