// Content script — extracts lead data from pages

function extractLeadData() {
  const data = {
    url: window.location.href,
    domain: window.location.hostname.replace(/^www\./, ""),
    title: document.title,
  };

  const pageText = document.body?.innerText || "";

  // Emails — scan page text + mailto links
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = new Set(pageText.match(emailRegex) || []);
  document.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
    const email = a.href.replace("mailto:", "").split("?")[0];
    emails.add(email);
  });
  // Filter junk
  const junkDomains = ["example.com", "wixpress.com", "sentry.io", "w3.org", "schema.org", "googleapis.com"];
  data.emails = [...emails].filter(
    (e) => !junkDomains.some((d) => e.includes(d)) && e.length < 80
  );

  // Phones — scan page text + tel links
  const phoneRegex = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
  const phones = new Set(pageText.match(phoneRegex) || []);
  document.querySelectorAll('a[href^="tel:"]').forEach((a) => {
    phones.add(a.href.replace("tel:", "").trim());
  });
  data.phones = [...phones].slice(0, 5);

  // Social media links
  const socials = {};
  const socialPatterns = {
    instagram: /instagram\.com\/([^\/\?\s"#]+)/,
    facebook: /facebook\.com\/([^\/\?\s"#]+)/,
    twitter: /(twitter|x)\.com\/([^\/\?\s"#]+)/,
    linkedin: /linkedin\.com\/(company|in)\/([^\/\?\s"#]+)/,
    tiktok: /tiktok\.com\/@?([^\/\?\s"#]+)/,
    pinterest: /pinterest\.com\/([^\/\?\s"#]+)/,
    youtube: /youtube\.com\/(channel|c|@)\/([^\/\?\s"#]+)/,
  };
  document.querySelectorAll("a[href]").forEach((a) => {
    for (const [platform, regex] of Object.entries(socialPatterns)) {
      if (regex.test(a.href) && !socials[platform]) {
        socials[platform] = a.href.split("?")[0];
      }
    }
  });
  data.socials = socials;

  // Contact form detection
  const contactPaths = ["/contact", "/contact-us", "/get-in-touch", "/reach-out", "/reach-us"];
  document.querySelectorAll("a[href]").forEach((a) => {
    try {
      const path = new URL(a.href, window.location.origin).pathname.toLowerCase();
      if (contactPaths.some((p) => path.includes(p)) && !data.contactFormUrl) {
        data.contactFormUrl = a.href;
      }
    } catch {}
  });

  // Business name
  const ogName = document.querySelector('meta[property="og:site_name"]');
  data.businessName =
    ogName?.getAttribute("content") ||
    document.title.split("|")[0].split("—")[0].split("-")[0].trim();

  // Schema.org address
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      const json = JSON.parse(s.textContent);
      const addr = json.address || json?.location?.address;
      if (addr) {
        data.address = addr.streetAddress || "";
        data.city = addr.addressLocality || "";
        data.state = addr.addressRegion || "";
        data.zip = addr.postalCode || "";
      }
    } catch {}
  });

  return data;
}

// Listen for extraction requests from sidebar via background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "EXTRACT") {
    try {
      const data = extractLeadData();
      sendResponse(data);
    } catch (err) {
      sendResponse({ error: err.message });
    }
  }
});
