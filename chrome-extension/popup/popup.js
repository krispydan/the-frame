const statusEl = document.getElementById("status");
const btnSettings = document.getElementById("btn-settings");

btnSettings.addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.storage.sync.get(["frameUrl", "apiKey"], (config) => {
  if (config.frameUrl && config.apiKey) {
    statusEl.textContent = `✅ Connected to ${new URL(config.frameUrl).hostname}`;
    statusEl.className = "status connected";
  } else {
    statusEl.textContent = "❌ Not configured";
    statusEl.className = "status disconnected";
  }
});
