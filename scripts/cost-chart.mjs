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

const ink = { primary: "#0b0b0b", secondary: "#52514e", rule: "#c3c2b7" };
const color = { claude: "#eb6834", astra: "#2a78d6", polling: "#4a3aa7" };
const font = `-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`;
const width = 720;
const pad = 40;
const barHeight = 52;
const scale = (width - 2 * pad - 150) / Math.max(...runs.map((r) => r.total));
const usd = (value) => `$${value.toFixed(2)}`;
const delta = (value) => `${value < 0 ? "−" : "+"}${usd(Math.abs(value))}`;

const text = (
  x,
  y,
  content,
  { size = 20, weight = 400, fill = ink.primary, anchor = "start" } = {},
) =>
  `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${content}</text>`;

// Flat at the baseline, 4px rounded data end.
const segment = (x0, x1, y, fill, roundEnd) =>
  roundEnd
    ? `<path d="M${x0} ${y}H${x1 - 4}Q${x1} ${y} ${x1} ${y + 4}V${y + barHeight - 4}Q${x1} ${y + barHeight} ${x1 - 4} ${y + barHeight}H${x0}Z" fill="${fill}"/>`
    : `<rect x="${x0}" y="${y}" width="${x1 - x0}" height="${barHeight}" fill="${fill}"/>`;

const bracket = (x0, x1, y) =>
  `<path d="M${x0 + 1} ${y - 8}V${y}H${x1 - 1}V${y - 8}" fill="none" stroke="${ink.rule}" stroke-width="2"/>`;

const swatch = (x, y, fill) =>
  `<rect x="${x}" y="${y - 16}" width="18" height="18" rx="4" fill="${fill}"/>`;

function runBlock(run, top) {
  const bar = top + 18;
  const x = (value) => pad + value * scale;
  const claudeEnd = x(run.claude);
  const pollingStart = x(run.total - run.polling);
  const end = x(run.total);
  const parts = [
    text(pad, top, run.label, { size: 22, weight: 700 }),
    segment(pad, claudeEnd - 2, bar, color.claude, false),
    segment(
      claudeEnd,
      run.polling ? pollingStart - 2 : end,
      bar,
      color.astra,
      !run.polling,
    ),
    text(end + 16, bar + 40, usd(run.total), { size: 40, weight: 700 }),
    bracket(pad, claudeEnd - 2, bar + barHeight + 14),
    bracket(claudeEnd, end, bar + barHeight + 14),
    text(
      pad,
      bar + barHeight + 42,
      `Claude <tspan font-weight="700">${usd(run.claude)}</tspan>`,
      { size: 22 },
    ),
    text(
      claudeEnd,
      bar + barHeight + 42,
      `Astra <tspan font-weight="700">${usd(run.astra)}</tspan>`,
      { size: 22 },
    ),
    text(
      claudeEnd,
      bar + barHeight + 68,
      run.polling
        ? `incl. ${usd(run.polling)} identified polling`
        : "no identified polling",
      { size: 18, fill: ink.secondary },
    ),
  ];
  if (run.polling) {
    parts.push(
      segment(pollingStart, end, bar, "url(#hatch)", true),
      text((pollingStart + end) / 2, bar + 34, usd(run.polling), {
        size: 22,
        weight: 700,
        fill: "#ffffff",
        anchor: "middle",
      }),
    );
  }
  return parts.join("\n  ");
}

const [before, after] = runs;
const changes = [
  ["Claude, I → J", after.claude - before.claude, color.claude],
  ["Astra, I → J", after.astra - before.astra, color.astra],
  ["Total, I → J", after.total - before.total, null],
];
const height = 772;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family='${font}' role="img" aria-labelledby="title desc">
  <title id="title">Estimated cost of the same task with polling and with a direct MCP call</title>
  <desc id="desc">Run I with polling cost ${usd(before.total)}. Claude ${usd(before.claude)}, Astra ${usd(before.astra)} including ${usd(before.polling)} identified polling. Run J with a direct MCP wait cost ${usd(after.total)}. Claude ${usd(after.claude)}, Astra ${usd(after.astra)}, no identified polling.</desc>
  <defs>
    <pattern id="hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="10" height="10" fill="${color.polling}"/>
      <rect width="3" height="10" fill="#ffffff" fill-opacity="0.22"/>
    </pattern>
  </defs>
  <rect width="${width}" height="${height}" rx="16" fill="#fcfcfb"/>
  ${text(pad, 58, "Same task, polling vs. a direct MCP call", { size: 30, weight: 700 })}
  ${text(pad, 92, "Astra → Opus 5.5 → Astra review · estimated API-equivalent USD", { size: 19, fill: ink.secondary })}
  ${swatch(pad, 140, color.claude)}${text(pad + 28, 140, "Claude (Opus 5.5)", { size: 20 })}
  ${swatch(pad + 220, 140, color.astra)}${text(pad + 248, 140, "Astra, excluding identified polling", { size: 20 })}
  ${swatch(pad, 172, "url(#hatch)")}${text(pad + 28, 172, "Identified Astra polling", { size: 20 })}
  ${runBlock(before, 222)}
  ${runBlock(after, 420)}
  <line x1="${pad}" y1="580" x2="${width - pad}" y2="580" stroke="#e1e0d9" stroke-width="1"/>
  ${changes
    .map(([label, value, fill], index) => {
      const x = pad + (index * (width - 2 * pad)) / 3;
      return [
        fill ? swatch(x, 618, fill) : "",
        text(fill ? x + 28 : x, 618, label, { size: 19, fill: ink.secondary }),
        text(x, 662, delta(value), { size: 36, weight: 700 }),
      ].join("");
    })
    .join("\n  ")}
  ${text(pad, 712, "Two runs of the same task. Implementation &amp; review also differed, so polling", { size: 18, fill: ink.secondary })}
  ${text(pad, 736, "does not explain the whole difference. Estimates, not subscription spend.", { size: 18, fill: ink.secondary })}
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
