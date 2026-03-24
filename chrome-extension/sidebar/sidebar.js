// Sidebar logic

let extractedData = null;
let matchedProspect = null;
let selectedProspectId = null;

// DOM refs
const $ = (id) => document.getElementById(id);

const stateUnconfigured = $("state-unconfigured");
const stateLoading = $("state-loading");
const stateMain = $("state-main");
const domainName = $("domain-name");
const matchStatus = $("match-status");
const btnSave = $("btn-save");
const btnSettings = $("btn-settings");
const btnOpenSettings = $("btn-open-settings");
const searchInput = $("search-input");
const searchResults = $("search-results");
const noteInput = $("note-input");
const stateSuccess = $("state-success");
const stateError = $("state-error");
const linkProspect = $("link-prospect");

// Init
document.addEventListener("DOMContentLoaded", async () => {
  const config = await chrome.storage.sync.get(["frameUrl", "apiKey"]);

  if (!config.frameUrl || !config.apiKey) {
    show(stateUnconfigured);
    return;
  }

  show(stateLoading);
  await extractAndMatch();
});

// Settings buttons
btnSettings.addEventListener("click", () => chrome.runtime.openOptionsPage());
btnOpenSettings.addEventListener("click", () => chrome.runtime.openOptionsPage());

// Save button
btnSave.addEventListener("click", saveToLead);

// Search
let searchTimeout;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    searchResults.innerHTML = "";
    return;
  }
  searchTimeout = setTimeout(() => searchProspects(q), 300);
});

// ── Core Functions ──

async function extractAndMatch() {
  try {
    // Extract data from active tab
    extractedData = await sendMessage({ type: "EXTRACT_DATA" });

    if (extractedData?.error) {
      showError(extractedData.error);
      show(stateMain);
      return;
    }

    // Display extracted data
    domainName.textContent = extractedData.domain || "Unknown";
    renderExtractedData();

    // Try to match by domain
    if (extractedData.domain) {
      try {
        const result = await apiRequest("GET", `/api/v1/ext/match?domain=${encodeURIComponent(extractedData.domain)}`);
        if (result.prospect) {
          matchedProspect = result.prospect;
          selectedProspectId = result.prospect.id;
          matchStatus.className = "match-status matched";
          matchStatus.textContent = `✅ Matched: ${result.prospect.name}`;
          matchStatus.classList.remove("hidden");
          btnSave.textContent = `💾 Update ${result.prospect.name}`;
          btnSave.disabled = false;
          $("section-search").classList.add("hidden");
        } else {
          showNewProspectState();
        }
      } catch {
        showNewProspectState();
      }
    } else {
      showNewProspectState();
    }

    show(stateMain);
  } catch (err) {
    show(stateMain);
    showError("Failed to extract data. Try refreshing the page.");
  }
}

function showNewProspectState() {
  matchStatus.className = "match-status new";
  matchStatus.textContent = "🆕 No match — will create new prospect";
  matchStatus.classList.remove("hidden");
  btnSave.textContent = `💾 Create New Prospect`;
  btnSave.disabled = false;
  $("section-search").classList.remove("hidden");
}

function renderExtractedData() {
  if (!extractedData) return;

  let hasData = false;

  // Emails
  if (extractedData.emails?.length) {
    hasData = true;
    $("group-emails").classList.remove("hidden");
    $("list-emails").innerHTML = extractedData.emails
      .map((e, i) => checkboxItem("email", i, e))
      .join("");
  }

  // Phones
  if (extractedData.phones?.length) {
    hasData = true;
    $("group-phones").classList.remove("hidden");
    $("list-phones").innerHTML = extractedData.phones
      .map((p, i) => checkboxItem("phone", i, p))
      .join("");
  }

  // Socials
  const socialKeys = Object.keys(extractedData.socials || {});
  if (socialKeys.length) {
    hasData = true;
    $("group-socials").classList.remove("hidden");
    $("list-socials").innerHTML = socialKeys
      .map((platform) => {
        const url = extractedData.socials[platform];
        const label = `${platformEmoji(platform)} ${platform}: ${url.replace(/https?:\/\/(www\.)?/, "")}`;
        return checkboxItem("social", platform, label, url);
      })
      .join("");
  }

  // Contact form
  if (extractedData.contactFormUrl) {
    hasData = true;
    $("group-contact-form").classList.remove("hidden");
    $("list-contact-form").innerHTML = checkboxItem("contactform", 0, extractedData.contactFormUrl);
  }

  // Address
  if (extractedData.address) {
    hasData = true;
    $("group-address").classList.remove("hidden");
    const parts = [extractedData.address, extractedData.city, extractedData.state, extractedData.zip].filter(Boolean);
    $("text-address").textContent = parts.join(", ");
  }

  if (!hasData) {
    $("no-data").classList.remove("hidden");
  }
}

function checkboxItem(group, key, label, value) {
  const id = `cb-${group}-${key}`;
  const dataVal = value ? `data-value="${escapeHtml(value)}"` : "";
  return `<div class="checkbox-item">
    <input type="checkbox" id="${id}" checked ${dataVal}>
    <label for="${id}">${escapeHtml(label)}</label>
  </div>`;
}

async function saveToLead() {
  btnSave.disabled = true;
  btnSave.textContent = "Saving...";
  stateSuccess.classList.add("hidden");
  stateError.classList.add("hidden");

  try {
    // Gather checked items
    const payload = {
      prospect_id: selectedProspectId || null,
      domain: extractedData.domain,
      website: extractedData.url,
      business_name: extractedData.businessName || extractedData.domain,
      source_url: extractedData.url,
      notes: noteInput.value.trim() || null,
    };

    // Checked emails — use first one
    const checkedEmails = getChecked("email");
    if (checkedEmails.length) payload.email = checkedEmails[0];

    // Checked phones
    const checkedPhones = getChecked("phone");
    if (checkedPhones.length) payload.phone = checkedPhones[0];

    // Checked socials
    const socials = {};
    const socialCheckboxes = document.querySelectorAll('[id^="cb-social-"]');
    socialCheckboxes.forEach((cb) => {
      if (cb.checked) {
        const platform = cb.id.replace("cb-social-", "");
        socials[platform] = cb.dataset.value || extractedData.socials[platform];
      }
    });
    if (Object.keys(socials).length) payload.socials = socials;

    // Contact form
    const cfCheck = document.getElementById("cb-contactform-0");
    if (cfCheck?.checked) payload.contact_form_url = extractedData.contactFormUrl;

    // Address
    if (extractedData.address) {
      payload.address = extractedData.address;
      payload.city = extractedData.city;
      payload.state = extractedData.state;
      payload.zip = extractedData.zip;
    }

    const result = await apiRequest("POST", "/api/v1/ext/capture", payload);

    // Success
    stateSuccess.classList.remove("hidden");
    const config = await chrome.storage.sync.get(["frameUrl"]);
    linkProspect.href = `${config.frameUrl}/sales/prospects/${result.prospect.id}`;

    if (result.created) {
      btnSave.textContent = "✅ Created!";
      selectedProspectId = result.prospect.id;
    } else {
      btnSave.textContent = "✅ Updated!";
    }

    setTimeout(() => {
      btnSave.textContent = selectedProspectId ? `💾 Update ${result.prospect.name || "Prospect"}` : "💾 Save to Lead";
      btnSave.disabled = false;
    }, 2000);
  } catch (err) {
    showError(err.message);
    btnSave.textContent = "💾 Save to Lead";
    btnSave.disabled = false;
  }
}

async function searchProspects(query) {
  try {
    const result = await apiRequest("GET", `/api/v1/ext/search?q=${encodeURIComponent(query)}`);
    searchResults.innerHTML = (result.prospects || [])
      .map(
        (p) => `<div class="search-result-item" data-id="${p.id}">
        <div class="name">${escapeHtml(p.name)}</div>
        <div class="meta">${escapeHtml([p.city, p.state].filter(Boolean).join(", ") || p.domain || "")}</div>
      </div>`
      )
      .join("");

    // Click to select
    searchResults.querySelectorAll(".search-result-item").forEach((el) => {
      el.addEventListener("click", () => {
        selectedProspectId = el.dataset.id;
        const name = el.querySelector(".name").textContent;
        matchStatus.className = "match-status matched";
        matchStatus.textContent = `✅ Linked: ${name}`;
        btnSave.textContent = `💾 Update ${name}`;
        btnSave.disabled = false;
        searchResults.innerHTML = "";
        searchInput.value = "";
      });
    });
  } catch {
    searchResults.innerHTML = '<div class="empty-msg">Search failed</div>';
  }
}

// ── Helpers ──

function getChecked(group) {
  const items = [];
  document.querySelectorAll(`[id^="cb-${group}-"]`).forEach((cb) => {
    if (cb.checked) {
      items.push(cb.nextElementSibling?.textContent || "");
    }
  });
  return items;
}

function show(el) {
  [stateUnconfigured, stateLoading, stateMain].forEach((s) => s.classList.add("hidden"));
  el.classList.remove("hidden");
}

function showError(msg) {
  stateError.textContent = `❌ ${msg}`;
  stateError.classList.remove("hidden");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function platformEmoji(p) {
  const map = {
    instagram: "📷",
    facebook: "👤",
    twitter: "🐦",
    linkedin: "💼",
    tiktok: "🎵",
    pinterest: "📌",
    youtube: "▶️",
  };
  return map[p] || "🔗";
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, resolve);
  });
}

async function apiRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "API_REQUEST", method, endpoint, body }, (response) => {
      if (response?.error) reject(new Error(response.error));
      else resolve(response);
    });
  });
}
