// Builds the animated terminal SVGs for the README from REAL output (no mock-ups).
//   node scripts/make-media.mjs            → docs/media/report-{light,dark}.svg
//   node scripts/make-media.mjs <session.json>  also → docs/media/claude-{light,dark}.svg
// <session.json>: { "prompt": "...", "steps": ["tool call", ...], "answer": "final text" } taken from a real `claude -p` run.
// Animated SVG uses only CSS (GitHub renders <img> SVGs without scripts or external fonts).

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = ROOT + 'docs/media/';
mkdirSync(OUT, { recursive: true });

const THEMES = {
  light: { bg: '#ffffff', bar: '#f1f3f5', border: '#d0d7de', text: '#1f2328', dim: '#6e7781', prompt: '#0969da', red: '#cf222e', yellow: '#9a6700', cyan: '#0550ae', green: '#1a7f37', user: '#8250df' },
  dark: { bg: '#0d1117', bar: '#161b22', border: '#30363d', text: '#e6edf3', dim: '#8b949e', prompt: '#58a6ff', red: '#ff7b72', yellow: '#d29922', cyan: '#79c0ff', green: '#3fb950', user: '#d2a8ff' },
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * @param {{ title: string, command: string, lines: Array<{ text: string, color?: string, bold?: boolean }>, width?: number, cycle?: number, file: string }} o
 */
function terminal(o) {
  const W = o.width || 760, LH = 19, PAD = 16, TOP = 36, FS = 13, CH = 7.83; // char width of a 13px monospace font
  const H = TOP + PAD + (o.lines.length + 1) * LH + PAD;
  const T = o.cycle || 16;
  const typeEnd = Math.min(2.4, 0.5 + o.command.length * 0.03);
  const pct = (sec) => ((sec / T) * 100).toFixed(2);
  const fadeAt = T - 1.4;
  for (const [name, c] of Object.entries(THEMES)) {
    let css = `text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:${FS}px;white-space:pre}`;
    css += `.cur{animation:cur ${T}s steps(1) infinite}@keyframes cur{0%,${pct(typeEnd)}%{opacity:1}${pct(typeEnd + 0.01)}%,100%{opacity:0}}`;
    // typing: a cover over the command slides right in steps
    css += `.cover{animation:type ${T}s steps(${o.command.length}) infinite}@keyframes type{0%,${pct(0.4)}%{transform:translateX(0)}${pct(typeEnd)}%,100%{transform:translateX(${(o.command.length + 1) * CH}px)}}`;
    let body = '';
    o.lines.forEach((l, i) => {
      const at = typeEnd + 0.5 + i * (l.text ? 0.22 : 0.08);
      css += `.l${i}{opacity:0;animation:l${i} ${T}s infinite}@keyframes l${i}{0%,${pct(at)}%{opacity:0}${pct(at + 0.12)}%,${pct(fadeAt)}%{opacity:1}${pct(fadeAt + 0.8)}%,100%{opacity:0}}`;
      body += `<text class="l${i}" x="${PAD}" y="${TOP + PAD + (i + 2) * LH - 5}" fill="${c[l.color || 'text']}"${l.bold ? ' font-weight="700"' : ''}>${esc(l.text)}</text>`;
    });
    css += `.cmd{animation:cmd ${T}s infinite}@keyframes cmd{0%,${pct(fadeAt)}%{opacity:1}${pct(fadeAt + 0.8)}%,100%{opacity:0}}`;
    const y0 = TOP + PAD + LH - 5;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.title)}">
<style>${css}</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${c.bg}" stroke="${c.border}"/>
<path d="M0.5 10.5a10 10 0 0 1 10-10h${W - 21}a10 10 0 0 1 10 10v16h-${W - 1}z" fill="${c.bar}"/>
<circle cx="18" cy="14" r="5" fill="#ff5f57"/><circle cx="36" cy="14" r="5" fill="#febc2e"/><circle cx="54" cy="14" r="5" fill="#28c840"/>
<text x="${W / 2}" y="18" text-anchor="middle" fill="${c.dim}" style="font-size:12px">${esc(o.title)}</text>
<defs><clipPath id="screen"><rect x="1" y="27" width="${W - 2}" height="${H - 28}" rx="9"/></clipPath></defs>
<g clip-path="url(#screen)">
<g class="cmd"><text x="${PAD}" y="${y0}" fill="${c.prompt}">$</text><text x="${PAD + 2 * CH}" y="${y0}" fill="${c.text}">${esc(o.command)}</text>
<g class="cover"><rect x="${PAD + 2 * CH}" y="${y0 - FS}" width="${W}" height="${LH}" fill="${c.bg}"/>
<rect class="cur" x="${PAD + 2 * CH}" y="${y0 - FS + 2}" width="${CH}" height="${FS + 2}" fill="${c.dim}"/></g></g>
${body}
</g>
</svg>
`;
    writeFileSync(OUT + `${o.file}-${name}.svg`, svg);
  }
}

// 1. Real `report` run on the synthetic Shop API example.
const r = spawnSync(process.execPath, [ROOT + 'bin/api-dead-ends.mjs', 'report', '--usage', 'examples/shop-usage-daily.csv', '--spec', 'examples/shop.openapi.json', '--out', 'examples/report'],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
if (r.status !== 0) throw new Error(r.stderr);
const out = r.stderr.trimEnd().split('\n').filter((l) => !/^Note: Node/.test(l))
  .map((l) => l.replace(' → examples/report/report.md', ' → report/report.md'))
  .flatMap((l) => (l.length > 92 && l.includes(', rare') ? [l.slice(0, l.indexOf(', rare') + 1), '  ' + l.slice(l.indexOf(', rare') + 2)] : [l]));
const color = (l) => (/^[✖▲]/.test(l) ? { color: 'red', bold: true } : /^[!↓]/.test(l) ? { color: 'yellow', bold: true } : /^○/.test(l) ? { color: 'cyan', bold: true } : /^\s+…/.test(l) ? { color: 'dim' } : /operations:|deprecated in use|→ report/.test(l) ? { color: 'green' } : {});
terminal({
  title: 'api-dead-ends — your traffic vs your OpenAPI spec',
  command: 'npx api-dead-ends report --usage usage.csv --spec openapi.json --out report/',
  lines: out.map((text) => ({ text, ...color(text) })),
  file: 'report',
});
console.log('report-{light,dark}.svg');

// 2. Optional: a real Claude Code session with the plugin.
if (process.argv[2]) {
  const s = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const wrap = (t, w = 92) => t.split('\n').flatMap((p) => { const o = []; let line = ''; for (const word of p.split(' ')) { if ((line + ' ' + word).trim().length > w) { o.push(line); line = word; } else line = (line + ' ' + word).trim(); } o.push(line); return o; });
  terminal({
    title: 'Claude Code + api-dead-ends plugin',
    command: `claude "${s.prompt}"`,
    lines: [
      ...s.steps.map((t) => ({ text: `  ⏺ ${t}`, color: 'user' })),
      { text: '' },
      ...wrap(s.answer).map((text) => ({ text, ...(/^(Broken|Undocumented|Not called|Next)/.test(text) ? { bold: true } : {}) })),
    ],
    cycle: 24,
    file: 'claude',
  });
  console.log('claude-{light,dark}.svg');
}
