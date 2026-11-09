// Tests de bout en bout : Chromium (Playwright) + serveur local de tuiles factices + vraies tuiles de relief (via relais).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

// Playwright et Chromium sont pré-installés globalement dans l'environnement de test (NODE_PATH).
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

const { port, close } = await startServer(0);
const base = `http://localhost:${port}`;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const failures = [];
const consoleErrors = [];

async function openPage({ viewport, hash, mobile = false }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  const page = await context.newPage();
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/glyph|font|favicon/i.test(msg.text())) consoleErrors.push(`console: ${msg.text()}`);
  });
  await page.addInitScript(
    (b) => {
      window.OMBRES_CONFIG = {
        demUrl: `${b}/dem/{z}/{x}/{y}.png`,
        planStyle: `${b}/mock/style.json`,
        satelliteStyle: `${b}/mock/style.json`,
        openFreeMap: b,
      };
    },
    base,
  );
  await page.goto(`${base}/${hash}`, { waitUntil: 'load' });
  return { page, context };
}

async function waitForFrame(page, minFrames = 1, timeout = 60000) {
  await page.waitForFunction(
    (n) => window.__ombres && window.__ombres.frames >= n && window.__ombres.stats,
    minFrames,
    { timeout },
  );
  return page.evaluate(() => ({ frames: window.__ombres.frames, stats: window.__ombres.stats }));
}

/** Compte les pixels de l'overlay : ombragés (alpha>0) et total, par échantillonnage. */
function overlayCoverage(page) {
  return page.evaluate(() => {
    const sm = window.__ombres.shadowMap;
    const { width, height } = sm.canvas;
    const d = sm.ctx.getImageData(0, 0, width, height).data;
    let shaded = 0;
    let total = 0;
    for (let i = 3; i < d.length; i += 4 * 7) {
      total++;
      if (d[i] > 0) shaded++;
    }
    return { shaded, total, ratio: shaded / total, width, height };
  });
}

async function setTime(page, minutes) {
  await page.evaluate((m) => {
    const el = document.getElementById('time');
    el.value = String(m);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, minutes);
  const before = await page.evaluate(() => window.__ombres.frames);
  await page.waitForFunction((n) => window.__ombres.frames > n, before, { timeout: 20000 });
  // Laisser le rendu se stabiliser (frames coalescées).
  await page.waitForTimeout(300);
}

async function scenario(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    console.log(`✗ ${name}\n   ${e.message}`);
  }
}

await scenario('Paris : ombres de bâtiments, nuit, midi, ensoleillement d\'un point', async () => {
  const { page, context } = await openPage({ viewport: { width: 1280, height: 800 }, hash: '#48.8566/2.3522/15.5?d=2026-11-09&t=15:30' });
  const { stats } = await waitForFrame(page, 1);
  assert.ok(stats.tilesLoaded > 0, `tuiles de relief chargées : ${JSON.stringify(stats)}`);
  assert.ok(stats.buildings > 100, `bâtiments rasterisés : ${stats.buildings}`);
  await page.waitForTimeout(500);
  const afternoon = await overlayCoverage(page);
  assert.ok(afternoon.ratio > 0.03 && afternoon.ratio < 0.9, `couverture ombres 15h30 : ${JSON.stringify(afternoon)}`);
  await page.screenshot({ path: join(OUT, 'paris-1530.png') });

  const label = await page.textContent('#time-label');
  assert.equal(label.trim(), '15:30');
  const tz = await page.textContent('#tz-label');
  assert.ok(/Europe\/Paris/.test(tz), tz);
  const sunrise = await page.textContent('#sunrise');
  assert.ok(/^0[78]:\d\d$/.test(sunrise.trim()), `lever ${sunrise}`);

  await setTime(page, 12 * 60 + 30);
  const noon = await overlayCoverage(page);
  assert.ok(noon.ratio < afternoon.ratio, `midi (${noon.ratio.toFixed(3)}) doit avoir moins d'ombre que 15h30 (${afternoon.ratio.toFixed(3)})`);
  assert.ok(noon.ratio > 0.005, `il reste des ombres à midi : ${noon.ratio}`);
  await page.screenshot({ path: join(OUT, 'paris-1230.png') });

  await setTime(page, 23 * 60);
  const night = await overlayCoverage(page);
  assert.ok(night.ratio > 0.99, `nuit : tout ombragé (${night.ratio})`);
  const phase = await page.textContent('#phase');
  assert.ok(/Nuit|Crépuscule/.test(phase), phase);

  await setTime(page, 15 * 60 + 30);
  // Clic au centre → point d'ensoleillement
  await page.mouse.click(640, 400);
  await page.waitForFunction(() => window.__ombres.lastExposure && window.__ombres.lastExposure.lit, null, { timeout: 15000 });
  const hours = await page.textContent('#exposure-hours');
  assert.ok(/\d+ h \d\d/.test(hours), `heures d'ensoleillement : ${hours}`);
  const meta = await page.textContent('#exposure-meta');
  assert.ok(/altitude \d+ m/.test(meta), meta);
  assert.ok(await page.isVisible('.point-marker'), 'marqueur affiché');
  await page.screenshot({ path: join(OUT, 'paris-point.png') });

  // L'URL reflète l'état.
  await page.waitForTimeout(500);
  const url = page.url();
  assert.ok(/#48\.8\d+\/2\.3\d+\/15\.5\?d=2026-11-09&t=15:30/.test(url), url);
  assert.ok(/p=48\./.test(url), `point dans l'URL : ${url}`);

  // Bascule bâtiments 3D / ombres.
  await page.click('label:has(#toggle-shadows)');
  const vis = await page.evaluate(() => window.__ombres.shadowMap.map.getLayoutProperty('ombres-overlay', 'visibility'));
  assert.equal(vis, 'none');
  await page.click('label:has(#toggle-shadows)');
  await context.close();
});

await scenario('Chamonix : ombres de relief au solstice d\'hiver, relief 3D', async () => {
  const { page, context } = await openPage({ viewport: { width: 1200, height: 800 }, hash: '#45.9237/6.8694/12.3?d=2026-12-21&t=09:30' });
  const { stats } = await waitForFrame(page, 1);
  assert.ok(stats.tilesLoaded >= 4, `tuiles : ${JSON.stringify(stats)}`);
  assert.ok(stats.maxH > 3000, `Mont-Blanc dans le champ : max ${stats.maxH} m`);
  await page.waitForTimeout(500);
  const morning = await overlayCoverage(page);
  assert.ok(morning.ratio > 0.1, `ombres de relief le matin d'hiver : ${JSON.stringify(morning)}`);
  await page.screenshot({ path: join(OUT, 'chamonix-0930.png') });
  await setTime(page, 13 * 60);
  const noon = await overlayCoverage(page);
  assert.ok(noon.ratio < morning.ratio, `moins d'ombre à 13h (${noon.ratio.toFixed(3)}) qu'à 9h30 (${morning.ratio.toFixed(3)})`);
  // Relief 3D
  await page.click('label:has(#toggle-terrain)');
  await page.waitForTimeout(1500);
  const terrain = await page.evaluate(() => !!window.__ombres.shadowMap.map.getTerrain());
  assert.ok(terrain, 'terrain activé');
  await page.screenshot({ path: join(OUT, 'chamonix-3d.png') });
  // Avec le relief 3D, l'overlay drapé doit continuer à se mettre à jour quand l'heure change (cache render-to-texture).
  // Luminosité moyenne de la carte, lue pendant l'événement « render » (le tampon WebGL n'est pas conservé après).
  const pixelsAt = () => page.evaluate(() => new Promise((resolve) => {
    const m = window.__ombres.shadowMap.map;
    m.once('render', () => {
      const gl = m.getCanvas().getContext('webgl2') || m.getCanvas().getContext('webgl');
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < buf.length; i += 4 * 61) {
        sum += buf[i] + buf[i + 1] + buf[i + 2];
        n++;
      }
      resolve(sum / n);
    });
    m.triggerRepaint();
  }));
  await setTime(page, 9 * 60 + 30);
  await page.waitForTimeout(800);
  const bright0930 = await pixelsAt();
  await setTime(page, 13 * 60);
  await page.waitForTimeout(800);
  const bright1300 = await pixelsAt();
  assert.ok(bright1300 > bright0930 + 2, `l'écran doit s'éclaircir à 13h avec le relief 3D (9h30 : ${bright0930.toFixed(1)}, 13h : ${bright1300.toFixed(1)})`);
  await context.close();
});

await scenario('Mobile : panneau replié, barre de temps visible, recherche par coordonnées', async () => {
  const { page, context } = await openPage({ viewport: { width: 390, height: 844 }, hash: '#48.8566/2.3522/15?d=2026-06-21&t=08:00', mobile: true });
  await waitForFrame(page, 1);
  const collapsed = await page.evaluate(() => document.getElementById('panel').classList.contains('collapsed'));
  assert.ok(collapsed, 'panneau replié sur mobile');
  assert.ok(await page.isVisible('#time'), 'curseur visible');
  await page.screenshot({ path: join(OUT, 'mobile.png') });
  await page.click('#panel-toggle');
  await page.waitForTimeout(400);
  const open = await page.evaluate(() => !document.getElementById('panel').classList.contains('collapsed'));
  assert.ok(open, 'panneau déplié');
  await page.screenshot({ path: join(OUT, 'mobile-panel.png') });
  await page.fill('#search-input', '45.9237, 6.8694');
  await page.press('#search-input', 'Enter');
  await page.waitForFunction(() => Math.abs(window.__ombres.shadowMap.map.getCenter().lat - 45.9237) < 0.01, null, { timeout: 10000 });
  const tz = await page.textContent('#tz-label');
  assert.ok(/Europe\/Paris/.test(tz), tz);
  await context.close();
});

await scenario('Changement de fond de carte : couches ré-installées, ombres conservées', async () => {
  const { page, context } = await openPage({ viewport: { width: 1100, height: 750 }, hash: '#48.8566/2.3522/15.5?d=2026-11-09&t=15:30' });
  await waitForFrame(page, 1);
  const frames0 = await page.evaluate(() => window.__ombres.frames);
  await page.click('label:has(input[name="style"][value="satellite"])');
  await page.waitForFunction((n) => window.__ombres.frames > n && window.__ombres.shadowMap.currentGridId !== null, frames0, { timeout: 30000 });
  await page.waitForTimeout(500);
  const layers = await page.evaluate(() => {
    const m = window.__ombres.shadowMap.map;
    return ['ombres-overlay', 'ombres-buildings-3d', 'ombres-sunpath-ray', 'ombres-hillshade'].map((id) => !!m.getLayer(id));
  });
  assert.deepEqual(layers, [true, true, true, true], `couches après setStyle : ${layers}`);
  const cov = await overlayCoverage(page);
  assert.ok(cov.ratio > 0.03, `ombres après changement de style : ${JSON.stringify(cov)}`);
  const stats = await page.evaluate(() => window.__ombres.stats);
  assert.ok(stats.buildings > 100, `bâtiments après changement de style : ${stats.buildings}`);
  assert.ok(/style=satellite/.test(page.url()), page.url());
  await context.close();
});

await scenario('Heures de soleil : carte cumulée du jour, légende, URL', async () => {
  const { page, context } = await openPage({ viewport: { width: 1100, height: 750 }, hash: '#48.8566/2.3522/15.5?d=2026-11-09&t=15:30' });
  await waitForFrame(page, 1);
  await page.click('label:has(input[name="mode"][value="exposure"])');
  await page.waitForFunction(() => /Heures de soleil calculées/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const legendVisible = await page.isVisible('#legend');
  assert.ok(legendVisible, 'légende visible');
  const maxLabel = await page.textContent('#legend-max');
  assert.ok(/9 h \d\d/.test(maxLabel), `légende max = durée du jour : ${maxLabel}`);
  // L'image doit contenir plusieurs couleurs distinctes (zones plus ou moins ensoleillées).
  const colors = await page.evaluate(() => {
    const sm = window.__ombres.shadowMap;
    const d = sm.ctx.getImageData(0, 0, sm.canvas.width, sm.canvas.height).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4 * 97) set.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    return set.size;
  });
  assert.ok(colors > 8, `nuances de couleurs : ${colors}`);
  assert.ok(/m=exposure/.test(page.url()), page.url());
  await page.screenshot({ path: join(OUT, 'paris-exposure.png') });
  // Retour au mode ombres : une nouvelle image est rendue.
  const before = await page.evaluate(() => window.__ombres.frames);
  await page.click('label:has(input[name="mode"][value="shadows"])');
  await page.waitForFunction((n) => window.__ombres.frames > n, before, { timeout: 20000 });
  assert.ok(!(await page.isVisible('#legend')), 'légende masquée');
  await context.close();
});

await scenario('Lecture (animation) et clavier', async () => {
  const { page, context } = await openPage({ viewport: { width: 1000, height: 700 }, hash: '#48.8566/2.3522/15?d=2026-03-20&t=10:00' });
  await waitForFrame(page, 1);
  await page.click('#play');
  await page.waitForTimeout(1200);
  const t1 = await page.evaluate(() => window.__ombres.state.minutes);
  assert.ok(t1 > 600, `l'heure avance en lecture : ${t1}`);
  await page.click('#play');
  const frames = await page.evaluate(() => window.__ombres.frames);
  assert.ok(frames > 3, `rendus pendant la lecture : ${frames}`);
  const t2 = await page.evaluate(() => window.__ombres.state.minutes);
  await page.keyboard.press('ArrowRight');
  const t3 = await page.evaluate(() => window.__ombres.state.minutes);
  assert.equal(t3, t2 + 10);
  await context.close();
});

await browser.close();
close();
if (consoleErrors.length) {
  console.log('Erreurs console/page :');
  for (const e of consoleErrors.slice(0, 20)) console.log('  ' + e);
}
if (failures.length || consoleErrors.length) {
  console.log(`\n${failures.length} scénario(s) en échec, ${consoleErrors.length} erreur(s) console.`);
  process.exit(1);
}
console.log('\nTous les scénarios passent.');
