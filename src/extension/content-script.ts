// Inject the analysis engine into the page context.
// It needs page context (not isolated content script world) for getComputedStyle, etc.
function injectEngine(): void {
  const script = document.createElement("script");
  script.type = "module";
  script.src = chrome.runtime.getURL("engine.js");
  script.onload = () => script.remove();
  script.onerror = () => {
    script.remove();
    console.warn(
      "[Layout Debugger] Could not inject engine. The page's CSP may block it.",
    );
  };
  (document.head || document.documentElement).appendChild(script);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", injectEngine);
} else {
  injectEngine();
}
