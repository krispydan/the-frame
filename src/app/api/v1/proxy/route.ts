import { NextRequest, NextResponse } from "next/server";

/**
 * Server-side proxy for embedding external websites in the review queue.
 * Fetches the target URL and strips X-Frame-Options / CSP frame-ancestors
 * so the content can be displayed in an iframe on our domain.
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  // Validate URL
  let parsed: URL;
  try {
    parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return NextResponse.json({ error: "Invalid protocol" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);

    const contentType = response.headers.get("content-type") || "";

    // Only proxy HTML content
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      // For non-HTML (images, CSS, JS), redirect to original
      return NextResponse.redirect(url);
    }

    let html = await response.text();

    // Inject <base> tag so relative URLs resolve against the original domain
    const baseUrl = `${parsed.protocol}//${parsed.host}`;
    const basePath = parsed.pathname.replace(/\/[^/]*$/, "/");
    const baseHref = `${baseUrl}${basePath}`;

    // Insert <base> tag right after <head>
    if (html.includes("<head>")) {
      html = html.replace("<head>", `<head><base href="${baseHref}">`);
    } else if (html.includes("<head ")) {
      html = html.replace(/<head\s[^>]*>/, `$&<base href="${baseHref}">`);
    } else if (html.includes("<HEAD>")) {
      html = html.replace("<HEAD>", `<HEAD><base href="${baseHref}">`);
    } else {
      // Prepend base tag
      html = `<base href="${baseHref}">${html}`;
    }

    // Build response headers — strip frame-blocking headers
    const headers = new Headers();
    headers.set("Content-Type", contentType || "text/html; charset=utf-8");
    headers.set("Cache-Control", "public, max-age=300"); // Cache 5 min

    // Explicitly do NOT copy X-Frame-Options or CSP headers
    // This allows our iframe to render the content

    return new NextResponse(html, {
      status: response.status,
      headers,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Fetch failed";
    // Return a simple error page that looks decent in the iframe
    const errorHtml = `<!DOCTYPE html>
<html><head><style>
  body { font-family: -apple-system, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f9fafb; color: #6b7280; }
  .c { text-align: center; }
  h2 { color: #374151; font-size: 16px; margin-bottom: 8px; }
  p { font-size: 13px; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style></head><body>
  <div class="c">
    <h2>Could not load site</h2>
    <p>${message.includes("abort") ? "Request timed out" : "Site is unreachable"}</p>
    <p style="margin-top:12px"><a href="${url}" target="_blank">Open in new tab ↗</a></p>
  </div>
</body></html>`;
    return new NextResponse(errorHtml, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}
