// Writes docs/images/polling-cost.svg from the curated public numbers below.
// Pass --png to also render docs/images/polling-cost.png with headless Chrome.
// Set CHROME to the browser executable if it is not in the default macOS path.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Estimated API-equivalent USD, https://kevinkern.dev/benchmarks/marlies-workflows/
// Astra includes the identified polling share.
const runs = [
  {
    label: "Run I · Astra polled for status",
    claude: 21.0968006,
    astra: 22.124908,
    polling: 9.74571,
    total: 43.2217086,
  },
  {
    label: "Run J · MCP waited for completion",
    claude: 22.9894538,
    astra: 8.11147,
    polling: 0,
    total: 31.1009238,
  },
];
for (const run of runs) {
  assert.ok(Math.abs(run.claude + run.astra - run.total) < 1e-9);
  assert.ok(run.polling <= run.astra);
}

const width = 720;
const height = 350;
const usd = (value) => `$${value.toFixed(2)}`;
const font =
  "-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif";

function card(run, index) {
  const x = 20 + index * 350;
  const accent = index === 0 ? "#765848" : "#166761";
  const title = index === 0 ? "With polling" : "With MCP waiting";
  return `<g transform="translate(${x},20)">
    <rect width="330" height="278" rx="16" fill="${index === 0 ? "#f6f0e9" : "#eaf4ee"}"/>
    <text x="24" y="38" font-size="20" font-weight="600">${title}</text>
    <text x="24" y="108" font-size="54" font-weight="700" fill="${accent}">${usd(run.total)}</text>
    <text x="24" y="156" font-size="18">Claude (Opus 5.5)</text>
    <text x="306" y="156" font-size="18" text-anchor="end">${usd(run.claude)}</text>
    <text x="24" y="190" font-size="18">Astra</text>
    <text x="306" y="190" font-size="18" text-anchor="end">${usd(run.astra)}</text>
    <line x1="24" y1="211" x2="306" y2="211" stroke="${accent}" stroke-opacity="0.2"/>
    <text x="24" y="248" font-size="17" fill="${accent}">${index === 0 ? `Includes ${usd(run.polling)} polling` : "No polling detected"}</text>
  </g>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${font}" fill="#24332e" role="img" aria-labelledby="title desc">
  <title id="title">Polling vs. MCP waiting</title>
  <desc id="desc">Estimated API-equivalent costs. Run I with polling cost $43.22, including Claude $21.10 and Astra $22.12. Astra includes $9.75 of identified polling. Run J with MCP waiting cost $31.10, including Claude $22.99 and Astra $8.11. Two different runs of the same task, not a controlled measurement of polling alone.</desc>
  <rect width="${width}" height="${height}" rx="18" fill="#fffdf9"/>
  ${runs.map(card).join("\n")}
  <text x="360" y="328" text-anchor="middle" font-size="16" fill="#59615b">Same task · runs I &amp; J · estimated API cost (USD)</text>
</svg>
`;

const svgPath = fileURLToPath(
  new URL("../docs/images/polling-cost.svg", import.meta.url),
);
writeFileSync(svgPath, svg);
console.log(`wrote ${svgPath}`);

if (process.argv.includes("--png")) {
  const pngPath = svgPath.replace(/\.svg$/, ".png");
  execFileSync(
    process.env.CHROME ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--headless",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      "--default-background-color=00000000",
      `--window-size=${width},${height}`,
      `--screenshot=${pngPath}`,
      `file://${svgPath}`,
    ],
    { stdio: "pipe" },
  );
  console.log(`wrote ${pngPath}`);
}
