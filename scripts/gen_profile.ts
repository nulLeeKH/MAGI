import { createCanvas, loadImage } from "canvas";
import { renderMagiImage } from "../src/image/renderer.ts";
import { getPersonaConfigs } from "../src/groq/personas.ts";
import type { MagiDeliberation } from "../src/magi/types.ts";

// Derive models from persona configs — no hardcoded model names
const pc = getPersonaConfigs("ja");

const deliberation: MagiDeliberation = {
  question: "Profile Image",
  language: "ja",
  melchior: {
    persona: pc.melchior.name,
    content: "",
    verdict: "APPROVE",
    model: pc.melchior.model,
    latencyMs: 0,
  },
  balthasar: {
    persona: pc.balthasar.name,
    content: "",
    verdict: "CONDITIONAL",
    model: pc.balthasar.model,
    latencyMs: 0,
  },
  casper: {
    persona: pc.casper.name,
    content: "",
    verdict: "DENY",
    model: pc.casper.model,
    latencyMs: 0,
  },
  searchFailed: true,
};

// Render with operator name for realistic README showcase
const fullBuf = renderMagiImage(deliberation, "IKARI GENDO");

// Crop to 1:1 square — centered on core area (cx=775)
// Left panel (x≤320), divider (x=350), footer (y≥825) all outside crop
const CONTENT = 700;
const PADDING = 100;
const SIZE = CONTENT + PADDING * 2; // 900x900
const cropX = 425; // 775 - 700/2
const cropY = 70;  // core positions shifted -40px up

const img = await loadImage(fullBuf);
const cropCanvas = createCanvas(SIZE, SIZE);
const cropCtx = cropCanvas.getContext("2d");
cropCtx.fillStyle = "#0a0408"; // match renderer bg
cropCtx.fillRect(0, 0, SIZE, SIZE);
cropCtx.drawImage(img, cropX, cropY, CONTENT, CONTENT, PADDING, PADDING, CONTENT, CONTENT);

const outDir = "docs/img";
Deno.mkdirSync(outDir, { recursive: true });

const fullPath = `${outDir}/magi_full.png`;
const profilePath = `${outDir}/magi_profile.png`;

Deno.writeFileSync(fullPath, fullBuf);
Deno.writeFileSync(profilePath, cropCanvas.toBuffer());

console.log(`Full image:    ${fullPath} (1200x900)`);
console.log(`Profile image: ${profilePath} (${SIZE}x${SIZE})`);
