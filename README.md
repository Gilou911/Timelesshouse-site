# Ombres — soleil et ombres sur la carte

Application web statique, dans l'esprit de ShadeMap / Shadowmap : une carte sur laquelle on fait défiler
l'heure et la date pour voir où tombent les ombres du **relief** et des **bâtiments**, n'importe où dans le monde.
Pensée pour vivre sur `perso.timelesshouse.org`.

- Curseur d'heure, choix de la date, lecture animée de la journée, bouton « Maintenant ».
- Ombres calculées pixel par pixel à partir du relief (Terrain Tiles, 30 m ou mieux) et des hauteurs de bâtiments OpenStreetMap.
- Panneau soleil : azimut, élévation, lever, coucher, midi solaire, durée du jour, heures dorées, longueur d'ombre.
- Mode « Heures de soleil » : carte colorée du nombre d'heures de soleil direct reçues en chaque point sur la journée.
- Clic sur la carte : heures de soleil direct reçues par ce point ce jour-là, avec les créneaux.
- Course du soleil tracée autour du point (graduations horaires, direction du soleil et de l'ombre).
- Bâtiments 3D, relief 3D, fond plan ou satellite, intensité des ombres réglable.
- Recherche de lieu (ou coordonnées), géolocalisation, lien partageable (tout l'état est dans l'URL).
- Fuseau horaire détecté automatiquement d'après l'endroit affiché.
- Sans clé d'API, sans compte, sans serveur : des fichiers statiques et des sources de données ouvertes.

## Mettre en ligne sur perso.timelesshouse.org

Le site est 100 % statique et **fonctionne depuis n'importe quel sous-dossier** (tous les chemins sont relatifs).
Les fichiers à publier : `index.html`, `manifest.webmanifest`, `assets/`, `css/`, `js/`, `vendor/`.

Si `vendor/` ne contient pas `maplibre-gl.js` (dépôt récupéré sans les fichiers minifiés), lancez `npm install && npm run vendor`
avant de copier. Le workflow « Vendor » le fait aussi automatiquement sur GitHub si les permissions d'écriture des workflows
sont activées ; et à défaut seulement, la page charge MapLibre et tz-lookup depuis unpkg (avec empreinte SRI). Avec
`vendor/` en place, aucune ressource tierce n'est chargée hors données cartographiques.

### Option A — un dossier sur le serveur qui sert déjà perso.timelesshouse.org

Copiez ces fichiers dans un sous-dossier du site, par exemple `ombres/`, et l'application répond sur
`https://perso.timelesshouse.org/ombres/`. Rien d'autre à configurer : pas de build, pas de variable d'environnement.

Exemples de configuration si vous servez vous-même :

```nginx
# nginx
location /ombres/ {
    alias /var/www/ombres/;
    try_files $uri $uri/ /ombres/index.html;
}
# Les fichiers de vendor/ sont référencés avec ?v=<version> : ils peuvent être mis en cache longtemps.
location ^~ /ombres/vendor/ { alias /var/www/ombres/vendor/; add_header Cache-Control "public, max-age=31536000, immutable"; }
```

```caddyfile
# Caddy
handle_path /ombres/* {
    root * /var/www/ombres
    file_server
}
```

Si perso.timelesshouse.org est une application (Node, Cloudflare Workers, Vercel…), il suffit d'y ajouter une route
`/ombres/*` qui sert ce dossier en statique.

### Option B — GitHub Pages sur un sous-domaine dédié

Le dépôt contient un workflow `.github/workflows/deploy-pages.yml` :

1. Dans GitHub → Settings → Pages, choisissez **Source : GitHub Actions**.
2. Fusionnez sur `main` : le workflow lance les tests puis publie le site.
3. Pour un domaine personnalisé (par exemple `ombres.timelesshouse.org`) : ajoutez chez votre registrar un enregistrement
   `CNAME ombres → gilou911.github.io`, saisissez ce domaine dans Settings → Pages → *Custom domain*, puis cochez
   « Enforce HTTPS » une fois le certificat émis (jusqu'à une heure). Avec un déploiement par GitHub Actions, un fichier
   `CNAME` dans le site n'est pas nécessaire : c'est le réglage dans Settings qui compte.

Un domaine personnalisé GitHub Pages occupe tout le nom d'hôte : si `perso.timelesshouse.org` est déjà servi par une
autre application, il faut soit l'option A, soit un autre sous-domaine.

## Développer et tester

```bash
npm install          # dépendances de développement uniquement (MapLibre, tz-lookup pour vendor/)
npm test             # tests unitaires : position du soleil (référence NREL SPA), moteur d'ombres, fuseaux, URL
npm run serve        # http://localhost:8787 — fond de carte factice (style OpenFreeMap réel, tuiles de test) et vrai relief
npm run test:e2e     # Chromium + Playwright : rendu réel, captures dans tests/e2e/out/
                     # (Playwright n'est pas dans package.json : npm install -D playwright && npx playwright install chromium)
npm run vendor       # re-copie maplibre-gl et tz-lookup depuis node_modules vers vendor/
```

En local, `npm run serve` injecte une configuration de test dans la page : tuiles factices (grille claire + quelques
bâtiments de test à Paris et Chamonix) mais vrai relief, sans dépendre des serveurs de fonds de carte. Pour la version
complète avec OpenFreeMap, servez simplement le dossier avec n'importe quel serveur statique (`npx serve .`,
`python3 -m http.server`).

## Comment ça marche

1. **Soleil** (`js/sun.js`) : algorithme NOAA (Meeus) — azimut, élévation avec réfraction, lever/coucher, crépuscules.
   Vérifié contre pvlib (NREL SPA) à mieux que 0,05°.
2. **Champ de hauteurs** (`js/shadow-worker.js`) : pour la vue courante (plus une marge de 30 %), le worker télécharge
   les tuiles de relief Terrarium, les échantillonne en bilinéaire, puis rasterise les emprises de bâtiments
   (hauteur `render_height` des tuiles OpenMapTiles) avec un toit plat posé sur le relief.
3. **Ombres** (`js/shadow-engine.js`) : balayage de la grille dans la direction opposée au soleil ; chaque cellule
   est à l'ombre si la ligne d'horizon portée depuis le soleil passe au-dessus d'elle. Coût linéaire en nombre de
   cellules, donc un rendu en quelques dizaines de millisecondes même en 1 000 × 1 000.
4. **Heures de soleil** : même balayage répété toutes les 20 minutes de la journée, en cumulant les minutes éclairées
   par cellule (environ une seconde sur un ordinateur portable).
5. **Affichage** : l'image RGBA est envoyée à une source `canvas` de MapLibre, géoréférencée sur la grille.
   Le relief et les bâtiments 3D sont des couches MapLibre classiques.

## Sources de données et crédits

| Donnée | Source | Licence / conditions |
| --- | --- | --- |
| Fond de carte « Plan » et bâtiments | [OpenFreeMap](https://openfreemap.org) (OpenMapTiles, données © OpenStreetMap) | Gratuit, sans clé, attribution affichée |
| Fond « Satellite » | Esri World Imagery | Attribution Esri affichée. Esri ne documente pas clairement l'usage sans clé dans une app publique : pour un usage intensif ou commercial, prévoir une clé ArcGIS ou une autre source (ex. Sentinel-2 cloudless d'EOX, CC BY-NC-SA, zoom ≤ 14) |
| Relief | [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) sur AWS Open Data (Mapzen : SRTM, EU-DEM, etc.) | Ouvert, attribution affichée |
| Recherche de lieu | [Nominatim](https://nominatim.org) | Usage léger : une requête par recherche validée, jamais d'autocomplétion |
| Fuseaux horaires | [@photostructure/tz-lookup](https://github.com/photostructure/tz-lookup) (CC0, données tz 2025), embarqué dans `vendor/` | — |
| Carte | [MapLibre GL JS](https://maplibre.org) 5, embarqué dans `vendor/` | BSD-3 |

Si le trafic devient important, pensez à héberger vos propres tuiles (OpenFreeMap documente l'auto-hébergement) ou
à passer par un fournisseur de tuiles avec clé.

## Limites connues

- Les bâtiments n'existent dans les tuiles qu'à partir du zoom 13 ; en dessous, seules les ombres du relief sont calculées.
- La hauteur des bâtiments vient d'OpenStreetMap : souvent estimée (niveaux × 3 m), parfois absente (6 m par défaut).
- Le relief a une résolution de 30 m environ (mieux en Europe) : les ombres fines des petits reliefs sont lissées.
- Les ombres des bâtiments situés juste hors de la zone chargée peuvent manquer en bord de carte.
- Les arbres ne sont pas pris en compte.
- À l'échelle d'un pays ou d'un continent, la direction du soleil est celle du centre de la carte ; seule la limite
  jour/nuit (terminateur) est calculée point par point.
- Les zones sous le niveau de la mer (mer Morte, polders) sont ramenées à 0 m pour ne pas faire de la côte une falaise.
