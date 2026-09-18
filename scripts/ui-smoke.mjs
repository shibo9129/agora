/**
 * UI smoke + visual sweep — headless Chrome against a REAL server serving the
 * BUILT SPA. Exists because 0.1.2–0.1.5 shipped visual bugs no test caught
 * (mispositioned popover, stale version label, updater perms, invisible card).
 *
 * Sweeps EVERY page in BOTH light and dark themes:
 *   - no horizontal overflow anywhere
 *   - every control stays inside the window
 *   - every control sits on a discernible container (shadow / border / bg
 *     contrast) — catches "floating toggle" class bugs
 *   - functional assertions (version label, donut metric, settings popover)
 * Screenshots land in /tmp/agora-ui-sweep/ for human review.
 *
 *   node scripts/ui-smoke.mjs
 *
 * Requires desktop Chrome (override via CHROME_PATH). Uses puppeteer-core.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const PORT = 7800 + Math.floor(Math.random() * 200);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = '/tmp/agora-ui-sweep';

execFileSync('pnpm', ['--filter', '@agora/web', 'build'], { cwd: repoRoot, stdio: 'inherit' });
mkdirSync(SHOTS, { recursive: true });

const server = spawn(join(repoRoot, 'node_modules/.bin/tsx'), ['src/index.ts'], {
  cwd: join(repoRoot, 'apps/server'),
  env: {
    ...process.env,
    AGORA_PORT: String(PORT),
    AGORA_NO_AUTOCOLLECT: '1',
    AGORA_NO_ORPHAN_WATCHDOG: '1',
    AGORA_WEB_DIST: join(repoRoot, 'apps/web/dist'),
  },
  stdio: 'ignore',
});
process.on('exit', () => server.kill());

const health = await (async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${ORIGIN}/api/health`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error('✗ server did not come up on ' + ORIGIN);
  process.exit(1);
})();

/** Pages now render a skeleton until their first fetch lands — sweeping before
 *  that would inspect placeholders instead of the real controls. */
const settled = async (page) => {
  await page
    .waitForFunction(() => document.querySelectorAll('.app-main .skeleton').length === 0, { timeout: 15000 })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 250));
};

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

/** In-browser sweep: geometry + container discernibility for all controls. */
const SWEEP_FN = `(() => {
  const vw = innerWidth;
  const appMain = document.querySelector('.app-main');
  const out = { overflowX: document.documentElement.scrollWidth > vw + 1, offWindow: [], noSurface: [], outsideCard: [] };
  const alpha = (c) => { const m = c?.match(/rgba?\\(([^)]+)\\)/); if (!m) return 0; const p = m[1].split(','); return p.length === 4 ? parseFloat(p[3]) : 1; };
  const discernible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.boxShadow !== 'none' && alpha(cs.boxShadow.split(',').slice(-1)[0] ?? '') >= 0) return true; // any real shadow
    if (alpha(cs.borderColor) >= 0.12) return true;
    if (alpha(cs.backgroundColor) >= 0.85) return true;
    return false;
  };
  const controls = [...document.querySelectorAll('.app-main button, .app-main [role="switch"], .app-main input, .app-main select, .app-main a')]
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.closest('[hidden]'); });
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    const label = (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 24);
    if (r.left < -1 || r.right > vw + 1) out.offWindow.push(label + '@' + Math.round(r.left) + '..' + Math.round(r.right));
    // nearest ancestor with a discernible surface (its visual "card")
    let host = el.parentElement;
    while (host && host !== appMain && !discernible(host)) host = host.parentElement;
    if (!host || host === appMain) { if (!discernible(el)) out.noSurface.push(label); continue; }
    const hr = host.getBoundingClientRect();
    if (r.left < hr.left - 2 || r.right > hr.right + 2) out.outsideCard.push(label + ' right=' + Math.round(r.right) + ' host=' + Math.round(hr.right));
  }
  return out;
})()`;

const PAGES = [
  { id: 'usage', nav: '用量看板', shot: 'usage' },
  { id: 'kb', nav: '知识库', shot: 'kb' },
  { id: 'tools', nav: '工具中心', shot: 'tools' },
  { id: 'memory', nav: '记忆中枢', shot: 'memory' },
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run'] });
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 840 });
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar', { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1200));

    for (const p of PAGES) {
      await page.evaluate((nav) => {
        [...document.querySelectorAll('.sidebar-item')].find((b) => b.textContent.includes(nav))?.click();
      }, p.nav);
      await settled(page);
      const sweep = await page.evaluate(SWEEP_FN);
      check(`[${theme}] ${p.nav}: no horizontal overflow`, !sweep.overflowX);
      check(`[${theme}] ${p.nav}: controls inside window`, sweep.offWindow.length === 0, sweep.offWindow.join(','));
      check(`[${theme}] ${p.nav}: controls on discernible surface`, sweep.noSurface.length === 0, sweep.noSurface.join(','));
      check(`[${theme}] ${p.nav}: controls inside their card`, sweep.outsideCard.length === 0, sweep.outsideCard.join(','));
      await page.screenshot({ path: `${SHOTS}/${theme}-${p.shot}.png` });
    }

    // 记忆中枢 → Agent 接入 tab: switch must be inside a visible card
    await page.evaluate(() => {
      [...document.querySelectorAll('.sidebar-item')].find((b) => b.textContent.includes('记忆中枢'))?.click();
    });
    await settled(page);
    await page.evaluate(() => {
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Agent 接入')?.click();
    });
    await new Promise((r) => setTimeout(r, 700));
    const enroll = await page.evaluate(() => {
      const sw = document.querySelector('[role="switch"]');
      if (!sw) return null;
      const r = sw.getBoundingClientRect();
      // The card is the nearest surface, not merely the parent element —
      // measuring against the parent made this check vacuous.
      const host = sw.closest('.card') ?? sw.parentElement;
      const card = host.getBoundingClientRect();
      const knob = sw.firstElementChild?.getBoundingClientRect() ?? null;
      return {
        swR: r.right,
        cardR: card.right,
        shadow: getComputedStyle(host).boxShadow !== 'none',
        // The knob lives inside the track; when it escapes (a mispositioned
        // absolute child) it visibly spills over the card's edge.
        knobInside: knob !== null && knob.left >= r.left - 0.5 && knob.right <= r.right + 0.5,
        knobDetail: knob ? `knob=${Math.round(knob.left)}..${Math.round(knob.right)} track=${Math.round(r.left)}..${Math.round(r.right)}` : 'no knob',
      };
    });
    check(`[${theme}] Agent 接入: toggle present`, !!enroll);
    if (enroll) {
      check(`[${theme}] Agent 接入: toggle inside card`, enroll.swR <= enroll.cardR + 2, `sw=${enroll.swR} card=${enroll.cardR}`);
      check(`[${theme}] Agent 接入: knob inside its track`, enroll.knobInside, enroll.knobDetail);
      check(`[${theme}] Agent 接入: card visually lifted (shadow)`, enroll.shadow);
    }
    await page.screenshot({ path: `${SHOTS}/${theme}-memory-enroll.png` });

    if (theme === 'light') {
      // functional assertions on the light pass
      await page.evaluate(() => {
        [...document.querySelectorAll('.sidebar-item')].find((b) => b.textContent.includes('用量看板'))?.click();
      });
      await page.waitForSelector('.sidebar-version', { timeout: 10000 });
      const label = await page.$eval('.sidebar-version', (el) => el.textContent);
      check('sidebar version matches /api/health', label === `v${health.version}`, `${label} vs v${health.version}`);
      // The dashboard renders a skeleton until its first fetch resolves, and on
      // a large usage db that can outlast any fixed sleep — wait for the real
      // content instead of racing it.
      const donutUp = await page
        .waitForFunction(
          () => [...document.querySelectorAll('.section-title')].some((e) => (e.textContent ?? '').includes('Token 占比')),
          { timeout: 15000 },
        )
        .then(() => true, () => false);
      check('agent donut shows Token share', donutUp);

      await page.click('button[aria-label="设置"]');
      await new Promise((r) => setTimeout(r, 400));
      const box = await page.evaluate(() => {
        const p = document.querySelector('.dialog-panel');
        if (!p) return null;
        const r = p.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight,
                 onTop: p.contains(document.elementFromPoint(r.right - 12, r.top + 60)) };
      });
      check('settings popover opens', !!box);
      if (box) {
        check('popover inside window', box.left >= 0 && box.top >= 0 && box.right <= box.vw && box.bottom <= box.vh, JSON.stringify(box));
        check('popover paints above main content', box.onTop);
      }
      await page.screenshot({ path: `${SHOTS}/light-usage-settings.png` });
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(`\nscreenshots: ${SHOTS}/`);
if (failed) {
  console.error(`${failed} UI check(s) FAILED`);
  process.exit(1);
}
console.log('all UI smoke checks passed');
