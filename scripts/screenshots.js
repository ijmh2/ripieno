#!/usr/bin/env node
/**
 * Regenerate the README's screenshots.
 *
 *   npm run screenshots
 *
 * These are not mockups. `packages/extension/preview/room.html` loads the room
 * panel's real stylesheet and real script — `media/main.css` and `media/main.js`,
 * the same files the extension ships — and only stands in for the theme
 * variables VS Code injects at runtime. So what is captured is genuinely how the
 * panel renders; the conversation in it is fixture data, the way any screenshot
 * of a chat product is.
 *
 * Being a script rather than a pair of PNGs somebody made once means the images
 * can be checked: change the stylesheet, run this, and see what actually moved.
 */

const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const root = path.join(__dirname, "..");
const out = path.join(root, "docs/images");
const preview = path.join(root, "packages/extension/preview/room.html");

/** Chrome, wherever this machine keeps it. */
function findChrome() {
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      ]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((c) => existsSync(c));
}

const chrome = findChrome();
if (!chrome) {
  console.error(
    [
      "No Chrome or Chromium found, and these are captured with headless Chrome.",
      "",
      "Install it, or capture by hand: open packages/extension/preview/room.html",
      "at 480×940 and save to docs/images/room-{dark,light}.png.",
    ].join("\n")
  );
  process.exit(1);
}

mkdirSync(out, { recursive: true });

// 480 wide is a realistic sidebar; the panel is built for that column and
// screenshotting it at desktop width would show a layout nobody ever sees.
for (const theme of ["dark", "light"]) {
  const file = path.join(out, `room-${theme}.png`);
  execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--window-size=480,940",
      "--virtual-time-budget=4000",
      `--screenshot=${file}`,
      `file://${preview}?theme=${theme}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  console.log(`  ${path.relative(root, file)}`);
}

console.log(
  "\nThe provenance GIF comes from the demo instead — `vhs scripts/demo.tape`,\n" +
    "then copy dist/demo.gif to docs/images/provenance.gif. It is real output,\n" +
    "so it is rendered rather than screenshotted."
);
