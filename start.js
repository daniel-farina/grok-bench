#!/usr/bin/env node
// grok-bench launcher: spawn the rewriting proxy + the bench server in the
// same Node process. Optional --dev flag also starts the Vite dev server
// for HMR during frontend work.
//
// Usage:
//   node start.js              # serve built UI from bench-ui/dist (production)
//   node start.js --dev        # also spawn `vite dev` in bench-ui/ for HMR

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';

import { start as startProxy } from './proxy.js';
import { start as startBench } from './bench-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Default: keep all runtime state out of the source tree in a hidden .bench-data dir.
const DEFAULT_ROOT = path.join(__dirname, '.bench-data');
const ROOT = path.resolve(process.env.BENCH_ROOT || DEFAULT_ROOT);
const BENCH_PORT = parseInt(process.env.BENCH_PORT || '7900', 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '18180', 10);
const VITE_PORT = parseInt(process.env.VITE_PORT || '7901', 10);
const DEV = process.argv.includes('--dev');

// ─── ANSI colors (respect NO_COLOR; default on for terminal-ish parents) ─
const COLOR = !process.env.NO_COLOR && (
  process.env.FORCE_COLOR === '1' ||
  process.env.FORCE_COLOR === 'true' ||
  process.stdout.isTTY ||
  // npm pipes stdout, so isTTY is false even when the parent is a terminal.
  // If npm is invoking us, lean on the terminal emulator hint instead.
  (process.env.npm_lifecycle_event && process.env.TERM_PROGRAM)
);
const rgb = (r, g, b) => COLOR ? `\x1b[38;2;${r};${g};${b}m` : '';
const bg  = (r, g, b) => COLOR ? `\x1b[48;2;${r};${g};${b}m` : '';
const bold  = COLOR ? '\x1b[1m'  : '';
const dim   = COLOR ? '\x1b[2m'  : '';
const reset = COLOR ? '\x1b[0m'  : '';
// Palette mirroring the dashboard
const TEAL  = rgb(94, 234, 212);
const BLUE  = rgb(121, 192, 255);
const GOOD  = rgb(134, 239, 172);
const WARN  = rgb(251, 191, 36);
const RED   = rgb(255, 123, 114);
const MUTED = rgb(134, 147, 164);
const DIM   = rgb(74, 83, 96);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read version from package.json so the banner stays accurate
let pkgVersion = '0.0.0';
try {
  pkgVersion = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || pkgVersion;
} catch {}

// 6-line "GROK" ANSI-Shadow figlet
const BANNER = [
  '   ██████╗ ██████╗  ██████╗ ██╗  ██╗',
  '  ██╔════╝ ██╔══██╗██╔═══██╗██║ ██╔╝',
  '  ██║  ███╗██████╔╝██║   ██║█████╔╝ ',
  '  ██║   ██║██╔══██╗██║   ██║██╔═██╗ ',
  '  ╚██████╔╝██║  ██║╚██████╔╝██║  ██╗',
  '   ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝',
];
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
function baseRgbForLine(i) {
  const t = i / (BANNER.length - 1);
  return [lerp(94, 121, t), lerp(234, 192, t), lerp(212, 255, t)];
}
function bannerLineColored(lineIdx, shimmerX) {
  // shimmerX = null disables the shimmer (final resting state)
  const line = BANNER[lineIdx];
  const [br, bg_, bb] = baseRgbForLine(lineIdx);
  // Per-line column count varies; render char by char
  let out = '';
  let lastColor = null;
  for (let x = 0; x < line.length; x++) {
    const ch = line[x];
    let r = br, g = bg_, b = bb;
    if (shimmerX !== null) {
      // Glow falls off with distance (gaussian-ish)
      const d = Math.abs(x - shimmerX);
      const intensity = Math.exp(-(d * d) / 18);  // ~0 beyond ~6 cols
      r = Math.min(255, r + Math.round(intensity * 90));
      g = Math.min(255, g + Math.round(intensity * 50));
      b = Math.min(255, b + Math.round(intensity * 30));
    }
    const colorStr = `${r};${g};${b}`;
    if (colorStr !== lastColor) {
      out += `\x1b[38;2;${colorStr}m`;
      lastColor = colorStr;
    }
    out += ch;
  }
  return out + reset;
}
function staticFrame() {
  let out = '';
  for (let i = 0; i < BANNER.length; i++) out += bannerLineColored(i, null) + '\n';
  return out;
}
function shimmerFrame(shimmerX) {
  let out = '';
  for (let i = 0; i < BANNER.length; i++) out += bannerLineColored(i, shimmerX) + '\n';
  return out;
}

// ---- explosion + shrink helpers ----
const SPARKLES = ['·', '*', '+', '·', '✦', '✧', '⋆', '∗', '·', '◦'];
function rand(n) { return Math.floor(Math.random() * n); }
function flashFrame() {
  // Everything pure white
  let out = '';
  for (let i = 0; i < BANNER.length; i++) {
    out += `\x1b[38;2;255;255;255m\x1b[1m${BANNER[i]}${reset}\n`;
  }
  return out;
}
function explosionFrame(intensity) {
  // intensity: 0..1 — at 1 most chars get replaced by sparkles in bright random hues
  let out = '';
  for (let i = 0; i < BANNER.length; i++) {
    const line = BANNER[i];
    const [br, bg_, bb] = baseRgbForLine(i);
    let lineOut = '';
    let lastColor = null;
    for (let x = 0; x < line.length; x++) {
      const ch = line[x];
      if (ch === ' ') { lineOut += ' '; continue; }
      const replace = Math.random() < intensity;
      let r, g, b, glyph;
      if (replace) {
        // Sparkle with a hot color (white-ish / teal-ish, randomized)
        r = 200 + rand(56);
        g = 200 + rand(56);
        b = 200 + rand(56);
        glyph = SPARKLES[rand(SPARKLES.length)];
      } else {
        // Keep the base gradient color but brighten randomly
        const boost = rand(50);
        r = Math.min(255, br + boost);
        g = Math.min(255, bg_ + boost);
        b = Math.min(255, bb + boost);
        glyph = ch;
      }
      const colorStr = `${r};${g};${b}`;
      if (colorStr !== lastColor) {
        lineOut += `\x1b[38;2;${colorStr}m`;
        lastColor = colorStr;
      }
      lineOut += glyph;
    }
    out += lineOut + reset + '\n';
  }
  return out;
}
// Final compact form: a 1-line mini logo
function compactLogo() {
  // tiny block-art tag + name + version, gradient teal → blue inline
  return `  ${TEAL}▰${BLUE}▰${TEAL}▰${reset} ${bold}Grok Bench${reset} ${DIM}v${pkgVersion}${reset}`;
}

// Subtitle that goes directly under the figlet (matches the LOGO.txt layout)
function bannerSubtitle() {
  return `${MUTED}              ·  ${TEAL}${bold}Bench${reset}${MUTED}  ·  ${DIM}v${pkgVersion}${reset}`;
}

async function printBanner() {
  const animate = COLOR && process.stdout.isTTY && !process.env.NO_ANIMATE;
  if (!animate) {
    // Static fallback: print the full banner + subtitle + disclaimer.
    process.stdout.write(staticFrame());
    process.stdout.write(bannerSubtitle() + '\n');
    process.stdout.write('\n');
    process.stdout.write(`  ${RED}⚠ Not affiliated with xAI or grok.${reset}\n`);
    process.stdout.write(`  ${MUTED}Community benchmarking tool, for beta testing and research.${reset}\n`);
    process.stdout.write('\n');
    return;
  }

  // Hide cursor during the animation
  process.stdout.write('\x1b[?25l');

  // ---- Phase 1: shimmer wipe (build up) ----
  const W = Math.max(...BANNER.map((l) => l.length));
  process.stdout.write(shimmerFrame(-12));
  const shimmerFrames = 28;
  const shimmerDuration = 520;
  for (let f = 1; f <= shimmerFrames; f++) {
    const t = f / shimmerFrames;
    const eased = 1 - Math.pow(1 - t, 3);
    const x = -12 + eased * (W + 24);
    process.stdout.write(`\x1b[${BANNER.length}A`);
    process.stdout.write(shimmerFrame(x));
    // eslint-disable-next-line no-await-in-loop
    await sleep(shimmerDuration / shimmerFrames);
  }
  // ---- Phase 2: settle for a moment ----
  process.stdout.write(`\x1b[${BANNER.length}A`);
  process.stdout.write(staticFrame());
  await sleep(140);

  // ---- Phase 3: flash (1 frame of full white) ----
  process.stdout.write(`\x1b[${BANNER.length}A`);
  process.stdout.write(flashFrame());
  await sleep(70);

  // ---- Phase 4: explosion (sparkles dissolve outward) ----
  const explodeSteps = 6;
  for (let s = 1; s <= explodeSteps; s++) {
    process.stdout.write(`\x1b[${BANNER.length}A`);
    process.stdout.write(explosionFrame(s / explodeSteps));
    // eslint-disable-next-line no-await-in-loop
    await sleep(55);
  }

  // ---- Phase 5: reform (particles converge back into the letters) ----
  for (let s = explodeSteps; s >= 1; s--) {
    process.stdout.write(`\x1b[${BANNER.length}A`);
    process.stdout.write(explosionFrame(s / explodeSteps));
    // eslint-disable-next-line no-await-in-loop
    await sleep(50);
  }

  // ---- Phase 6: settle back to the original banner + subtitle ----
  process.stdout.write(`\x1b[${BANNER.length}A`);
  process.stdout.write(staticFrame());
  process.stdout.write(bannerSubtitle() + '\n');

  // Restore cursor
  process.stdout.write('\x1b[?25h');

  // Disclaimer below the banner. Red headline + muted detail.
  process.stdout.write(`\n  ${RED}⚠ Not affiliated with xAI or grok.${reset}\n`);
  process.stdout.write(`  ${MUTED}Community benchmarking tool, for beta testing and research.${reset}\n`);
  process.stdout.write('\n');
}

function rule() {
  const ch = COLOR ? '─' : '-';
  process.stdout.write(`${DIM}${ch.repeat(60)}${reset}\n`);
}

// Make sure BENCH_ROOT exists (esp. on a fresh clone using the default .bench-data/)
try { mkdirSync(ROOT, { recursive: true }); } catch {}

await printBanner();
process.stdout.write(`${DIM}  BENCH_ROOT  ${reset}${ROOT}\n`);
process.stdout.write(`${DIM}  mode        ${reset}${DEV ? `${WARN}dev (HMR)${reset}` : `${GOOD}production${reset}`}\n`);
process.stdout.write('\n');

const proxy = startProxy({ port: PROXY_PORT, root: ROOT, quiet: true });
const bench = startBench({
  port: BENCH_PORT,
  root: ROOT,
  proxyPort: PROXY_PORT,
  uiDistDir: path.join(__dirname, 'bench-ui', 'dist'),
  quiet: true,
});

let viteChild = null;
if (DEV) {
  console.log();
  console.log('[dev] spawning vite for HMR…');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  viteChild = spawn(npmCmd, ['run', 'dev', '--', '--port', String(VITE_PORT)], {
    cwd: path.join(__dirname, 'bench-ui'),
    stdio: 'inherit',
  });
  viteChild.on('exit', (code) => {
    console.log(`[dev] vite exited (code ${code})`);
    viteChild = null;
  });
}

// Friendly summary after listeners settle
setTimeout(() => {
  process.stdout.write('\n');
  rule();
  const arrow = `${TEAL}▶${reset}`;
  if (DEV) {
    process.stdout.write(`  ${arrow} ${bold}dashboard (HMR)${reset}  ${BLUE}http://127.0.0.1:${VITE_PORT}/${reset}\n`);
    process.stdout.write(`    ${DIM}dashboard (prod) http://127.0.0.1:${BENCH_PORT}/${reset}\n`);
  } else {
    const distExists = existsSync(path.join(__dirname, 'bench-ui', 'dist', 'index.html'));
    if (distExists) {
      process.stdout.write(`  ${arrow} ${bold}dashboard${reset}        ${BLUE}http://127.0.0.1:${BENCH_PORT}/${reset}\n`);
    } else {
      process.stdout.write(`  ${WARN}!${reset} ${bold}dashboard${reset}        ${MUTED}no built UI found${reset}\n`);
      process.stdout.write(`    ${DIM}${reset}                  ${MUTED}run '${TEAL}npm run build${MUTED}' or '${TEAL}npm run dev${MUTED}'${reset}\n`);
    }
  }
  process.stdout.write(`  ${arrow} ${bold}bench API${reset}        ${BLUE}http://127.0.0.1:${BENCH_PORT}/api/${reset}\n`);
  process.stdout.write(`  ${arrow} ${bold}proxy (grok)${reset}     ${BLUE}http://127.0.0.1:${PROXY_PORT}/v1${reset}\n`);
  rule();
  process.stdout.write(`  ${GOOD}●${reset} ready  ${DIM}— Ctrl-C to stop${reset}\n\n`);
}, 250);

// Clean shutdown
function shutdown(signal) {
  // Re-show cursor in case the boot animation was interrupted
  if (COLOR) process.stdout.write('\x1b[?25h');
  console.log(`\n${signal} received, shutting down...`);
  try { proxy.close(); } catch {}
  try { bench.close(); } catch {}
  if (viteChild) { try { viteChild.kill(); } catch {} }
  // Give listeners a moment to close, then exit
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
