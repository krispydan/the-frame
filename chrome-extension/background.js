// Background service worker — handles API calls and side panel

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// Set side panel behavior
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Listen for messages from sidebar/content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "EXTRACT_DATA") {
    // Ask the content script to extract data from the active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "EXTRACT" }, (response) => {
          sendResponse(response || { error: "No response from content script" });
        });
      } else {
        sendResponse({ error: "No active tab" });
      }
    });
    return true; // keep channel open for async response
  }

  if (message.type === "API_REQUEST") {
    handleApiRequest(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

async function handleApiRequest({ method, endpoint, body }) {
  const config = await chrome.storage.sync.get(["frameUrl", "apiKey"]);
  if (!config.frameUrl || !config.apiKey) {
    throw new Error("Extension not configured. Open settings to set Frame URL and API key.");
  }

  const url = `${config.frameUrl.replace(/\/$/, "")}${endpoint}`;
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
    },
  };

  if (body && method !== "GET") {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `API error: ${response.status}`);
  }

  return data;
}
