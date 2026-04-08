import { chromium } from "playwright";
import { resolve } from "path";
import { execSync, spawn } from "child_process";

const root = resolve(import.meta.dirname, "..");
const extPath = resolve(root, "dist/extension");
const testPage = `file://${resolve(root, "test-extension.html")}`;

// Initial build so the extension exists before launching
console.log("Building...");
execSync("npm run build:all", { cwd: root, stdio: "inherit" });

// Watch extension build for changes — refresh the browser to pick up updates
console.log("Watching for changes...");
spawn("npx", ["vite", "build", "--config", "vite.config.extension.ts", "--watch"], {
  cwd: root, stdio: "inherit", shell: true,
});

console.log("Launching Chrome with extension...");
const context = await chromium.launchPersistentContext("", {
  headless: false,
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
    "--auto-open-devtools-for-tabs",
  ],
});

const page = context.pages()[0] || (await context.newPage());
await page.goto(testPage);

console.log("Chrome open with extension loaded. Close the browser to exit.");
await new Promise(() => {});
