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
const MUTED = rgb(134, 147, 164);
const DIM   = rgb(74, 83, 96);

// Read version from package.json so the banner stays accurate
let pkgVersion = '0.0.0';
try {
  pkgVersion = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || pkgVersion;
} catch {}

function printBanner() {
  // 6-line "GROK" ANSI-Shadow figlet — each line gets a gradient from teal → blue
  const banner = [
    '   ██████╗ ██████╗  ██████╗ ██╗  ██╗',
    '  ██╔════╝ ██╔══██╗██╔═══██╗██║ ██╔╝',
    '  ██║  ███╗██████╔╝██║   ██║█████╔╝ ',
    '  ██║   ██║██╔══██╗██║   ██║██╔═██╗ ',
    '  ╚██████╔╝██║  ██║╚██████╔╝██║  ██╗',
    '   ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝',
  ];
  // Per-line interpolation between teal (94,234,212) and sky blue (121,192,255)
  const lerp = (a, b, t) => Math.round(a + (b - a) * t);
  for (let i = 0; i < banner.length; i++) {
    const t = i / (banner.length - 1);
    const c = rgb(lerp(94, 121, t), lerp(234, 192, t), lerp(212, 255, t));
    process.stdout.write(`${c}${banner[i]}${reset}\n`);
  }
  // Subtitle line: " · b e n c h · " with a sparkle dot
  process.stdout.write(`${MUTED}              ·  ${TEAL}${bold}bench${reset}${MUTED}  ·  ${DIM}v${pkgVersion}${reset}\n`);
  process.stdout.write('\n');
}

function rule() {
  const ch = COLOR ? '─' : '-';
  process.stdout.write(`${DIM}${ch.repeat(60)}${reset}\n`);
}

// Make sure BENCH_ROOT exists (esp. on a fresh clone using the default .bench-data/)
try { mkdirSync(ROOT, { recursive: true }); } catch {}

printBanner();
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
  console.log(`\n${signal} received, shutting down...`);
  try { proxy.close(); } catch {}
  try { bench.close(); } catch {}
  if (viteChild) { try { viteChild.kill(); } catch {} }
  // Give listeners a moment to close, then exit
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
