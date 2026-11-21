// Generates the notification PNGs from public/icons/icon-192.svg.
// Usage: node apps/web/scripts/generate-notification-icons.mjs
//  - notification-192.png: the full-colour app icon.
//  - badge-96.png: white-on-transparent glyph for the Android status bar (the OS uses only
//    the alpha channel, so the coloured tile would render as a solid square).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const iconsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
const svg = readFileSync(join(iconsDir, "icon-192.svg"));

writeFileSync(join(iconsDir, "notification-192.png"), await sharp(svg).resize(192, 192).png().toBuffer());

const badgeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <text x="48" y="66" font-family="Arial, Helvetica, sans-serif" font-size="52" font-weight="bold" fill="white" text-anchor="middle">CG</text>
</svg>`;
writeFileSync(join(iconsDir, "badge-96.png"), await sharp(Buffer.from(badgeSvg)).png().toBuffer());
console.log("notification icons written");