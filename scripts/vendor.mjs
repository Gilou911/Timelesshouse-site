// Copie les dépendances front depuis node_modules vers vendor/ (aucun CDN au chargement de la page).
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'vendor');
mkdirSync(out, { recursive: true });

const ml = join(nm, 'maplibre-gl');
const mlPkg = JSON.parse(readFileSync(join(ml, 'package.json'), 'utf8'));
copyFileSync(join(ml, 'dist', 'maplibre-gl.js'), join(out, 'maplibre-gl.js'));
copyFileSync(join(ml, 'dist', 'maplibre-gl.css'), join(out, 'maplibre-gl.css'));
copyFileSync(join(ml, 'LICENSE.txt'), join(out, 'LICENSE-maplibre-gl.txt'));

const tz = join(nm, '@photostructure', 'tz-lookup');
const tzPkg = JSON.parse(readFileSync(join(tz, 'package.json'), 'utf8'));
const tzSrc = readFileSync(join(tz, 'tz.js'), 'utf8');
writeFileSync(
  join(out, 'tz-lookup.js'),
  `// @photostructure/tz-lookup ${tzPkg.version} (CC0-1.0) — https://github.com/photostructure/tz-lookup — enveloppé en module ES.\n${tzSrc}\nexport default tzlookup;\n`,
);
copyFileSync(join(tz, 'LICENSE'), join(out, 'LICENSE-tz-lookup.txt'));

writeFileSync(
  join(out, 'VERSIONS.txt'),
  `maplibre-gl ${mlPkg.version}\n@photostructure/tz-lookup ${tzPkg.version}\n`,
);
console.log(`vendor/ : maplibre-gl ${mlPkg.version}, @photostructure/tz-lookup ${tzPkg.version}`);
