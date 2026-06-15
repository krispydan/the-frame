export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { fetchFairePackingSlip } from "@/modules/integrations/lib/faire/packing-slip";
import { verifyPackingSlipUrl } from "@/modules/integrations/lib/faire/signed-url";

/**
 * GET /api/v1/integrations/faire/packing-slip?order=bo_xxx&sig=...&display=...
 *
 * Signed-URL proxy that ShipHero pulls from. ShipHero's order_add_attachment
 * mutation takes a `url` field rather than a base64 body — they fetch the
 * document themselves. This route accepts an HMAC-signed URL minted at
 * attach time, re-fetches the corresponding Faire packing-slip PDF, and
 * streams it back.
 *
 * The signature binds the URL to a single Faire order id. URLs do not
 * expire — the warehouse may open the attachment days or weeks after
 * allocation. Leaking a URL exposes one customer's packing slip; the
 * Faire API token itself remains protected.
 *
 * Legacy URLs that include `&exp=…` are still accepted (the verifier
 * checks the legacy signature scheme but ignores the expiry).
 *
 * See: docs/shiphero-webhooks-and-faire-slips.md
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const faireOrderId = url.searchParams.get("order") || "";
  const expRaw = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig") || "";
  const displayId = url.searchParams.get("display") || undefined;

  if (!faireOrderId || !sig) {
    return NextResponse.json(
      { error: "Missing order or sig parameter" },
      { status: 400 },
    );
  }

  const exp = expRaw !== null && expRaw !== "" ? Number(expRaw) : undefined;
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
