import { resolve } from "path";
import { execSync, spawn } from "child_process";
import { pathToFileURL } from "url";

const root = resolve(import.meta.dirname, "..");
const extPath = resolve(root, "dist/extension");
const testPage = pathToFileURL(resolve(root, "test-extension.html")).href;

// Initial build so the extension exists before launching
console.log("Building...");
execSync("npm run build:all", { cwd: root, stdio: "inherit" });

// Watch extension build for changes — web-ext reloads automatically
console.log("Watching for changes...");
spawn("npx", ["vite", "build", "--config", "vite.config.extension.ts", "--watch"], {
  cwd: root, stdio: "inherit", shell: true,
});

console.log("Launching Firefox with extension...");
const child = spawn(
  "npx",
  ["web-ext", "run", "--source-dir", extPath, "--start-url", testPage],
  { cwd: root, stdio: "inherit", shell: true },
);

child.on("close", (code) => process.exit(code ?? 0));
