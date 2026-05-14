/**
 * Faire packing-slip PDF fetcher.
 *
 * Wraps Faire's external API endpoint that returns a printable packing-slip
 * PDF for a given order. Used by the ShipHero webhook handler to attach
 * Faire-formatted packing slips to outbound shipments.
 *
 * See: docs/shiphero-webhooks-and-faire-slips.md
 */

const FAIRE_API_BASE = "https://www.faire.com/external-api/v2";

export interface FairePackingSlip {
  /** Raw PDF bytes. */
  pdf: Buffer;
  /** Suggested filename like "Faire_Packing_Slip_X4ECZ86SZT.pdf". */
  filename: string;
  /** Byte size of the PDF (for logging). */
  size: number;
  /** Content-Type from Faire (should always be application/pdf). */
  contentType: string;
}

function getFaireToken(): string {
  const token = process.env.FAIRE_API_TOKEN;
  if (!token) throw new Error("FAIRE_API_TOKEN not configured");
  return token;
}

/**
 * Fetch the Faire packing-slip PDF for an order.
 * @param faireOrderId - Faire's "bo_xxx" order id.
 * @param opts.displayId - optional human-readable code (e.g. "X4ECZ86SZT")
 *   used to construct a nicer filename. If omitted, filename falls back to
 *   the faireOrderId.
 * @throws if FAIRE_API_TOKEN is unset, the request fails, or the response
 *   isn't a PDF.
 */
export async function fetchFairePackingSlip(
  faireOrderId: string,
  opts?: { displayId?: string }
): Promise<FairePackingSlip> {
  const token = getFaireToken();

  const res = await fetch(
    `${FAIRE_API_BASE}/orders/${faireOrderId}/packing-slip-pdf`,
    {
      headers: {
        "X-FAIRE-ACCESS-TOKEN": token,
      },
    }
  );

  if (!res.ok) {
    let bodyPreview = "";
    try {
      const text = await res.text();
      bodyPreview = text.slice(0, 300);
    } catch {
      // ignore
    }
    throw new Error(
      `Faire packing-slip fetch failed: ${res.status} ${res.statusText} ${bodyPreview}`
    );
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/pdf")) {
    throw new Error(
      `Faire packing-slip returned unexpected content-type: ${contentType || "(none)"}`
    );
  }

  const buf = await res.arrayBuffer();
  const pdf = Buffer.from(buf);
  const filename = `Faire_Packing_Slip_${opts?.displayId ?? faireOrderId}.pdf`;

  return {
    pdf,
    filename,
    size: pdf.byteLength,
    contentType,
  };
}

/**
 * Lightweight test that the Faire API is reachable + the token is valid.
 * Calls GET /orders?limit=1 and returns true on 2xx. Used by the settings
 * UI's "Test connection" button. Does NOT throw; returns false on any
 * failure with the reason in `error`.
 */
export async function testFaireConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    const token = getFaireToken();
    const res = await fetch(`${FAIRE_API_BASE}/orders?limit=1`, {
      headers: {
        "X-FAIRE-ACCESS-TOKEN": token,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      let bodyPreview = "";
      try {
        const text = await res.text();
        bodyPreview = text.slice(0, 200);
      } catch {
        // ignore
      }
      return {
        ok: false,
        error: `${res.status} ${res.statusText}${bodyPreview ? ` — ${bodyPreview}` : ""}`,
      };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
