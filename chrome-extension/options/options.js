const frameUrlInput = document.getElementById("frame-url");
const apiKeyInput = document.getElementById("api-key");
const btnSave = document.getElementById("btn-save");
const statusEl = document.getElementById("status");

// Load saved settings
chrome.storage.sync.get(["frameUrl", "apiKey"], (config) => {
  if (config.frameUrl) frameUrlInput.value = config.frameUrl;
  if (config.apiKey) apiKeyInput.value = config.apiKey;
});

btnSave.addEventListener("click", async () => {
  const frameUrl = frameUrlInput.value.trim().replace(/\/$/, "");
  const apiKey = apiKeyInput.value.trim();

  if (!frameUrl || !apiKey) {
    showStatus("Please fill in both fields", "error");
    return;
  }

  btnSave.textContent = "Testing...";
  btnSave.disabled = true;

  try {
    // Test the connection
    const response = await fetch(`${frameUrl}/api/v1/ext/auth`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Connection failed (${response.status})`);
    }

    // Save settings
    await chrome.storage.sync.set({ frameUrl, apiKey });
    showStatus("✅ Connected successfully! You can close this tab.", "success");
  } catch (err) {
    showStatus(`❌ ${err.message}`, "error");
  } finally {
    btnSave.textContent = "Save & Test Connection";
    btnSave.disabled = false;
  }
});

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
}
