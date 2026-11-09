// Tests de bout en bout : Chromium (Playwright) + serveur local de tuiles factices + vraies tuiles de relief (via relais).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

// Playwright et Chromium sont pré-installés globalement dans l'environnement de test (NODE_PATH).
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright est requis : npm install -D playwright && npx playwright install chromium');
  process.exit(2);
}

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
mkdirSync(OUT, { recursive: true });

const { port, close } = await startServer(0);
const base = `http://localhost:${port}`;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const failures = [];
const consoleErrors = [];

async function openPage({ viewport, hash, mobile = false, planStyle, satelliteStyle }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  const page = await context.newPage();
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/glyph|font|favicon/i.test(msg.text())) consoleErrors.push(`console: ${msg.text()}`);
  });
  await page.addInitScript(
    ({ b, planStyle, satelliteStyle }) => {
      window.OMBRES_CONFIG = {
        demUrl: `${b}/dem/{z}/{x}/{y}.png`,
        planStyle: planStyle || `${b}/mock/style.json`,
        satelliteStyle: satelliteStyle || `${b}/mock/style.json`,
        openFreeMap: b,
      };
    },
    { b: base, planStyle, satelliteStyle },
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

  // Bascule bâtiments 3D : propriété de peinture, aucun nouveau calcul de relief ne doit être déclenché.
  const hfBefore = await page.evaluate(() => window.__ombres.shadowMap.hfId);
  await page.click('label:has(#toggle-buildings)');
  await page.waitForTimeout(1500);
  const hfAfter = await page.evaluate(() => window.__ombres.shadowMap.hfId);
  assert.equal(hfAfter, hfBefore, `relief recalculé après la bascule 3D (${hfBefore} → ${hfAfter})`);
  const op = await page.evaluate(() => window.__ombres.shadowMap.map.getPaintProperty('ombres-buildings-3d', 'fill-extrusion-opacity'));
  assert.equal(op, 0);
  await page.click('label:has(#toggle-buildings)');
  // Bascule ombres : masquées, l'heure change, ré-affichées → l'image doit correspondre à la nouvelle heure.
  await page.click('label:has(#toggle-shadows)');
  const vis = await page.evaluate(() => window.__ombres.shadowMap.map.getLayoutProperty('ombres-overlay', 'visibility'));
  assert.equal(vis, 'none');
  await page.evaluate((m) => {
    const el = document.getElementById('time');
    el.value = String(m);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, 23 * 60);
  await page.waitForTimeout(300);
  const framesHidden = await page.evaluate(() => window.__ombres.frames);
  await page.click('label:has(#toggle-shadows)');
  await page.waitForFunction((n) => window.__ombres.frames > n, framesHidden, { timeout: 20000 });
  await page.waitForTimeout(300);
  const nightAgain = await overlayCoverage(page);
  assert.ok(nightAgain.ratio > 0.99, `image fraîche après ré-affichage (nuit) : ${nightAgain.ratio}`);
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
  // Ouverture directe d'un lien en mode heures de soleil : la carte doit se calculer sans intervention.
  const { page: page2, context: ctx2 } = await openPage({ viewport: { width: 900, height: 650 }, hash: '#48.8566/2.3522/15.5?d=2026-11-09&t=15:30&m=exposure&o=0.7' });
  await page2.waitForFunction(() => /Heures de soleil calculées/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  assert.ok(await page2.isVisible('#legend'), 'légende visible au démarrage en mode exposition');
  assert.equal(await page2.evaluate(() => document.getElementById('opacity').value), '0.7', 'intensité lue dans l\'URL');
  await ctx2.close();
  // Retour au mode ombres : une nouvelle image est rendue.
  const before = await page.evaluate(() => window.__ombres.frames);
  await page.click('label:has(input[name="mode"][value="shadows"])');
  await page.waitForFunction((n) => window.__ombres.frames > n, before, { timeout: 20000 });
  assert.ok(!(await page.isVisible('#legend')), 'légende masquée');
  await context.close();
});

await scenario('Extrêmes : monde entier (z1), antiméridien (Fidji), zoom 19 en ville', async () => {
  const { page, context } = await openPage({ viewport: { width: 1000, height: 700 }, hash: '#20/0/1.2?d=2026-06-21&t=12:00' });
  let { stats } = await waitForFrame(page, 1);
  assert.ok(stats.tilesLoaded > 0, `monde : tuiles ${JSON.stringify(stats)}`);
  const world = await overlayCoverage(page);
  assert.ok(world.ratio > 0.25 && world.ratio < 0.75, `monde à midi UTC : environ la moitié du globe est dans la nuit (${world.ratio.toFixed(2)})`);
  await page.screenshot({ path: join(OUT, 'monde.png') });
  // Antiméridien : Suva (Fidji), 178,4° E, zoom 11.
  await page.evaluate(() => window.__ombres.shadowMap.map.jumpTo({ center: [178.44, -18.14], zoom: 11 }));
  let before = await page.evaluate(() => window.__ombres.frames);
  await page.waitForFunction((n) => window.__ombres.frames > n, before, { timeout: 60000 });
  stats = await page.evaluate(() => window.__ombres.stats);
  assert.ok(stats.tilesLoaded > 0 && stats.tilesMissing === 0, `Fidji : ${JSON.stringify(stats)}`);
  assert.ok(stats.maxH > 200, `relief fidjien présent (max ${stats.maxH} m)`);
  const tz = await page.textContent('#tz-label');
  assert.ok(/Pacific\/Fiji/.test(tz), tz);
  // Zoom 19 à Paris : bâtiments issus des tuiles z14 sur-zoomées.
  await page.evaluate(() => window.__ombres.shadowMap.map.jumpTo({ center: [2.3522, 48.8566], zoom: 19 }));
  before = await page.evaluate(() => window.__ombres.frames);
  await page.waitForFunction((n) => window.__ombres.frames > n, before, { timeout: 60000 });
  stats = await page.evaluate(() => window.__ombres.stats);
  assert.ok(stats.buildings > 0, `bâtiments à z19 : ${stats.buildings}`);
  await context.close();
});

await scenario('Styles OpenFreeMap réels (bright puis liberty) : source, couches, polices, extrusions du style masquées', async () => {
  const { page, context } = await openPage({
    viewport: { width: 1100, height: 750 },
    hash: '#48.8566/2.3522/15.5?d=2026-11-09&t=15:30',
    planStyle: `${base}/mock/ofm/bright.json`,
    satelliteStyle: `${base}/mock/ofm/liberty.json`,
  });
  const { stats } = await waitForFrame(page, 1);
  assert.ok(stats.buildings > 100, `bâtiments via le style bright : ${stats.buildings}`);
  let info = await page.evaluate(() => {
    const sm = window.__ombres.shadowMap;
    const layers = sm.map.getStyle().layers.map((l) => l.id);
    const firstSymbol = sm.map.getStyle().layers.findIndex((l) => l.type === 'symbol' && l.layout && l.layout['text-field'] !== undefined);
    const lastFill = sm.map.getStyle().layers.map((l, i) => (['fill', 'line', 'raster', 'background', 'hillshade'].includes(l.type) && !/^ombres-/.test(l.id) ? i : -1)).filter((i) => i >= 0).pop();
    const labels = sm.map.getLayer('ombres-sunpath-labels');
    return {
      vectorSource: sm.vectorSource,
      nbLayers: layers.length,
      overlayIdx: layers.indexOf('ombres-overlay'),
      b3dIdx: layers.indexOf('ombres-buildings-3d'),
      hillIdx: layers.indexOf('ombres-hillshade'),
      firstSymbol,
      lastFill,
      sunpathFeatures: sm.map.querySourceFeatures('ombres-sunpath').length,
      labelFont: labels ? sm.map.getLayoutProperty('ombres-sunpath-labels', 'text-font') : null,
      b3dSourceLayer: sm.map.getLayer('ombres-buildings-3d') && sm.map.getLayer('ombres-buildings-3d').sourceLayer,
    };
  });
  assert.equal(info.vectorSource, 'openmaptiles', JSON.stringify(info));
  assert.ok(info.nbLayers > 100, `couches du style bright : ${info.nbLayers}`);
  assert.ok(info.overlayIdx > info.lastFill && info.overlayIdx < info.firstSymbol, `overlay au-dessus des remplissages et sous les étiquettes : ${JSON.stringify(info)}`);
  assert.ok(info.hillIdx < info.overlayIdx && info.overlayIdx < info.b3dIdx, `ordre ombrage < ombres < bâtiments 3D : ${JSON.stringify(info)}`);
  assert.ok(Array.isArray(info.labelFont) && info.labelFont.every((f) => typeof f === 'string') && /Noto Sans/.test(info.labelFont[0]), `police ${JSON.stringify(info.labelFont)}`);
  assert.equal(info.b3dSourceLayer, 'building');
  await page.waitForTimeout(400);
  const cov = await overlayCoverage(page);
  assert.ok(cov.ratio > 0.03, `ombres avec le style bright : ${JSON.stringify(cov)}`);
  await page.screenshot({ path: join(OUT, 'ofm-bright.png') });

  // Liberty : la couche building-3d du style doit être masquée au profit de la nôtre.
  const frames0 = await page.evaluate(() => window.__ombres.frames);
  await page.click('label:has(input[name="style"][value="satellite"])');
  await page.waitForFunction((n) => window.__ombres.frames > n && window.__ombres.shadowMap.currentGridId !== null, frames0, { timeout: 30000 });
  await page.waitForTimeout(400);
  info = await page.evaluate(() => {
    const m = window.__ombres.shadowMap.map;
    return {
      styleB3d: m.getLayer('building-3d') ? m.getLayoutProperty('building-3d', 'visibility') : 'absent',
      ours: m.getLayer('ombres-buildings-3d') ? m.getPaintProperty('ombres-buildings-3d', 'fill-extrusion-opacity') : 'absent',
      buildings: window.__ombres.stats.buildings,
      sunpathFeatures: m.querySourceFeatures('ombres-sunpath').length,
      coords: m.getSource('ombres').coordinates,
    };
  });
  assert.equal(info.styleB3d, 'none', `building-3d du style masqué : ${JSON.stringify(info)}`);
  assert.equal(info.ours, 0.9);
  assert.ok(info.sunpathFeatures > 5, `course du soleil retracée après changement de fond : ${info.sunpathFeatures}`);
  assert.ok(Math.abs(info.coords[1][0] - info.coords[0][0]) > 0.01, `grille conservée après changement de fond : ${JSON.stringify(info.coords)}`);
  assert.ok(info.buildings > 100, `bâtiments via liberty : ${info.buildings}`);
  const cov2 = await overlayCoverage(page);
  assert.ok(cov2.ratio > 0.03, `ombres avec liberty : ${JSON.stringify(cov2)}`);
  await page.screenshot({ path: join(OUT, 'ofm-liberty.png') });
  await context.close();
});

await scenario('Lecture (animation) et clavier', async () => {
  const { page, context } = await openPage({ viewport: { width: 1000, height: 700 }, hash: '#48.8566/2.3522/15?d=2026-03-20&t=10:00' });
  await waitForFrame(page, 1);
  await page.click('#play');
  await page.waitForTimeout(1200);
  const t1 = await page.evaluate(() => window.__ombres.state.minutes);
  assert.ok(t1 > 600, `l'heure avance en lecture : ${t1}`);
  const icons = await page.evaluate(() => [
    getComputedStyle(document.querySelector('#play .ic-play')).display,
    getComputedStyle(document.querySelector('#play .ic-pause')).display,
  ]);
  assert.deepEqual(icons, ['none', 'block'], `icônes lecture/pause : ${icons}`);
  await page.click('#play');
  // Espace sur un bouton focalisé active le bouton, pas la lecture.
  await page.focus('#now');
  await page.keyboard.press('Space');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.__ombres.state.playing), false, 'espace sur « Maintenant » ne lance pas la lecture');
  await page.evaluate(() => document.activeElement.blur());
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
