import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const WEBSITE_URL = "https://github.com/mywwave/cursor-jev";
export const DOCS_URL = "https://docs.typesafe.ai";
export const CONSOLE_URL = "https://console.typesafe.ai";

export function readLogoSvg(root = join(here, "..")) {
  return readFileSync(join(root, "assets", "logo.svg"), "utf8");
}

export function logoDataUri(svg) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function serverIcons(svg) {
  const src = logoDataUri(svg);
  return [
    { src, mimeType: "image/svg+xml", sizes: ["128x128"] },
    { src, mimeType: "image/svg+xml", sizes: ["64x64"] },
  ];
}

export function serverInfo({ version = "0.1.0", svg } = {}) {
  const icons = serverIcons(svg ?? readLogoSvg());
  return {
    name: "cursor-jev",
    title: "Jev",
    version,
    description:
      "TypeSafe Jev for Cursor: route subagents and ask typed Choice, Score, and Noul questions.",
    websiteUrl: WEBSITE_URL,
    icons,
  };
}

export const TOOL_ICONS = (svg) => serverIcons(svg);
