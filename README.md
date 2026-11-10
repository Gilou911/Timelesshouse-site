# Ombres — soleil et ombres sur la carte

Application web statique, dans l'esprit de ShadeMap / Shadowmap : une carte sur laquelle on fait défiler
l'heure et la date pour voir où tombent les ombres du **relief**, des **bâtiments** et des **arbres**, n'importe où dans le monde.
Pensée pour vivre sur `perso.timelesshouse.org`.

- Curseur d'heure, choix de la date, lecture animée de la journée, bouton « Maintenant ».
- Ombres calculées pixel par pixel à partir du relief (Terrain Tiles, 30 m ou mieux), des hauteurs de bâtiments OpenStreetMap
  et des bois et forêts (canopée de 15 m), avec un interrupteur « Arbres ».
- Panneau soleil : azimut, élévation, lever, coucher, midi solaire, durée du jour, heures dorée, rose et bleue, longueur d'ombre.
- Mode « Heures de soleil » : carte colorée du nombre d'heures de soleil direct reçues en chaque point sur la journée.
- Clic sur la carte : heures de soleil direct reçues par ce point ce jour-là, avec les créneaux.
- **Sur l'année** : les heures de soleil du point jour par jour sur douze mois, en graphique jours × heures (une ligne par
  jour, l'heure en abscisse comme la frise ; soleil, ombre, nuit), avec le total, le mois le plus et le moins ensoleillé.
  Les mesures d'un point comptent le relief jusqu'à 20 km, même hors de la vue.
- Course du soleil tracée autour du point (graduations horaires, direction du soleil et de l'ombre).
- Repérage de tournage :
  - **Cérémonie** : date et heure d'un événement ; la barre du temps passe d'un geste du jour de la cérémonie à celui du
    repérage, chacun gardant son heure, et un trait marque l'heure de la cérémonie sur la frise.
  - **Heures dorée, rose et bleue** en bandes sur la frise du temps, avec leurs créneaux : dorée du lever (ou du coucher) à +6°, rose du coucher (ou jusqu'au lever) à −4°, quand le ciel rosit, bleue de −4° à −6°.
  - **Façade ou axe de prise de vue** : orientation lue sur le mur le plus proche (ou réglée à la main), créneaux où le
    soleil l'éclaire, flèche de la façade vers la caméra.
  - **Hauteur du point** mesuré : un étage, un balcon, un drone (1,5 m par défaut).
  - **Lune** : phase, part éclairée, lever, coucher, direction et hauteur à l'heure choisie.
  - **Carnet de lieux** : lieux nommés gardés dans le navigateur (vue, point, façade, cérémonie, date), rouverts d'un
    geste, aussi depuis le champ de recherche vide.
- Bâtiments 3D éclairés par le soleil : la lumière suit son azimut et sa hauteur, les façades tournées vers lui sont
  claires, les autres sombres ; après le coucher, plus aucun mur n'est éclairé (un faible ciel bleuté garde les volumes
  lisibles).
- Relief 3D, fond plan ou satellite, intensité des ombres réglable.
- Recherche de lieu (ou coordonnées), géolocalisation, lien partageable (vue, date, heure, couches, arbres, mode, intensité,
  point, cérémonie, façade, hauteur du point).
- Fuseau horaire détecté automatiquement d'après l'endroit affiché.
- Sans clé d'API, sans compte, sans serveur : des fichiers statiques et des sources de données ouvertes.

## Mettre en ligne sur perso.timelesshouse.org

**En ligne depuis le 09/11/2026 : https://perso.timelesshouse.org/ombres/**, quatrième carte de l'accueil du site perso. C'est
le Worker « moodboard » du dépôt `Gilou911/timelesshouse-website` qui la sert, à partir d'une copie dans
`moodboard/public/ombres/`, avec sa propre politique de sécurité dans `moodboard/public/_headers`. Pour publier une
nouvelle version, depuis une branche tirée de `main` de ce dépôt (un worktree, jamais le checkout principal) :

```bash
scripts/copier-vers-perso.sh <checkout>/moodboard/public/ombres   # recopie, supprime les fichiers disparus, garde apercu.jpg
```

Ensuite : PR sur `main`, fusion, puis déploiement depuis `main`, comme le décrit le README de `moodboard/`. Si le design
change, refaire aussi `apercu.jpg`, la capture qui illustre la carte d'accueil.

Les options ci-dessous restent valables pour un autre hébergement. Le site est 100 % statique et **fonctionne depuis
n'importe quel sous-dossier** (tous les chemins sont relatifs).
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
# Sans barre finale, les chemins relatifs partiraient de la racine du site : on redirige.
location = /ombres { return 301 /ombres/; }
location /ombres/ {
    alias /var/www/ombres/;
    try_files $uri $uri/ /ombres/index.html;
    # index.html, css/ et js/ doivent être revalidés à chaque visite (le worker et ses modules évoluent ensemble).
    add_header Cache-Control "no-cache";
}
# Les fichiers de vendor/ sont référencés avec ?v=<version> : ils peuvent être mis en cache longtemps.
location ^~ /ombres/vendor/ { alias /var/www/ombres/vendor/; add_header Cache-Control "public, max-age=31536000, immutable"; }
```

```caddyfile
# Caddy
redir /ombres /ombres/ 301
handle_path /ombres/* {
    root * /var/www/ombres
    @vendor path /vendor/*
    header @vendor Cache-Control "public, max-age=31536000, immutable"
    header Cache-Control no-cache
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

### En-têtes de sécurité (facultatif)

L'application tient dans une politique de sécurité de contenu stricte. Celle-ci a été vérifiée dans Chromium avec les
vrais serveurs de tuiles : plan, bâtiments, relief, satellite et recherche de lieu.

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self' https://tiles.openfreemap.org https://s3.amazonaws.com https://server.arcgisonline.com https://nominatim.openstreetmap.org
```

- `worker-src blob:` est obligatoire : MapLibre lance ses workers depuis une URL `blob:`. Sans lui, ils sont bloqués.
- Envoyez l'en-tête sur la page et sur les fichiers de `js/` : le worker des ombres applique la politique reçue avec
  son propre fichier.
- La page n'a plus aucun script en ligne : le repli vers unpkg vit dans `js/vendor-fallback.js` et ne sert qu'en
  l'absence de `vendor/`. Ses requêtes vers unpkg seraient bloquées par cette politique : gardez `vendor/` en place.
- `Cross-Origin-Embedder-Policy` n'est pas nécessaire : l'application n'utilise pas `SharedArrayBuffer`.
- Non vérifié dans Firefox ni Safari.

## Développer et tester

```bash
npm install          # dépendances de développement uniquement (MapLibre, tz-lookup pour vendor/)
npm test             # tests unitaires : soleil (référence NREL SPA), lune (référence astronomy-engine), bandes de lumière,
                     # façades, moteur d'ombres, arbres, horizon lointain, année, fuseaux, URL, carnet de lieux
npm run serve        # http://localhost:8787 — fond de carte factice (style OpenFreeMap réel, tuiles de test) et vrai relief
npm run test:e2e     # Chromium + Playwright : rendu réel, captures dans tests/e2e/out/
                     # (Playwright n'est pas dans package.json : npm install -D playwright && npx playwright install chromium ;
                     #  ou, avec Google Chrome installé : npm install --no-save playwright && E2E_CHROME_CHANNEL=chrome npm run test:e2e)
npm run vendor       # re-copie maplibre-gl et tz-lookup depuis node_modules vers vendor/
```

En local, `npm run serve` injecte une configuration de test dans la page : tuiles factices (grille claire + quelques
bâtiments de test à Paris et Chamonix) mais vrai relief, sans dépendre des serveurs de fonds de carte. Pour la version
complète avec OpenFreeMap, servez simplement le dossier avec n'importe quel serveur statique (`npx serve .`,
`python3 -m http.server`).

Les sources de données se remplacent sans toucher au code : définissez `window.OMBRES_CONFIG` dans un script chargé
avant `js/app.js`. Toutes les clés sont facultatives.

| Clé | Rôle | Valeur par défaut |
| --- | --- | --- |
| `openFreeMap` | Racine du serveur OpenFreeMap : styles, polices, tuiles vectorielles des bâtiments | `https://tiles.openfreemap.org` |
| `planStyle` | URL du style du fond « Plan » | style `bright` d'OpenFreeMap |
| `satelliteStyle` | URL d'un style complet pour le fond « Satellite » | style construit autour de `esriUrl` |
| `esriUrl` | Gabarit d'URL des tuiles d'imagerie | Esri World Imagery |
| `demUrl` | Gabarit d'URL des tuiles de relief, au format Terrarium | Terrain Tiles sur AWS |
| `idleFallbackMs` | Délai, en millisecondes, avant de calculer les ombres quand une tuile du fond ne répond pas | `6000` |

## Comment ça marche

1. **Soleil** (`js/sun.js`) : algorithme NOAA (Meeus) — azimut, élévation avec réfraction, lever/coucher ; bandes de
   lumière de la frise (nuit, heure bleue, heure rose, heure dorée, jour) par échantillonnage de l'élévation toutes les 4 minutes.
   **Lune** (`js/moon.js`) : « MiniMoon » de Montenbruck et Pfleger, à 0,02° près d'astronomy-engine ; lever et coucher
   à moins de 30 s.
   Vérifié contre pvlib (NREL SPA) à mieux que 0,05°.
2. **Champ de hauteurs** (`js/shadow-worker.js`) : pour la vue courante (plus une marge de 30 %), le worker télécharge
   les tuiles de relief Terrarium, les échantillonne en bilinéaire, puis rasterise les emprises de bâtiments
   (hauteur `render_height` des tuiles OpenMapTiles) avec un toit plat posé sur le relief. Les bois et forêts (couche
   `landcover`, classe `wood`) suivent, en canopée de 15 m posée sur le sol nu, jamais sur un bâtiment. Ils vont dans le
   champ des hauteurs `H`, jamais dans le relief seul `T` que le balayage lit au point exact du rayon.
   Le calcul part quand la carte a fini de charger. Si une tuile du fond reste muette, il part quand même au bout
   de 6 secondes, puis il est refait quand les tuiles en retard arrivent.
3. **Ombres** (`js/shadow-engine.js`) : balayage de la grille dans la direction opposée au soleil ; chaque cellule
   est à l'ombre si la ligne d'horizon portée depuis le soleil passe au-dessus d'elle. Coût linéaire en nombre de
   cellules, donc un rendu en quelques dizaines de millisecondes même en 1 000 × 1 000.
4. **Heures de soleil** : même balayage répété toutes les 20 minutes de la journée, en cumulant les minutes éclairées
   par cellule (environ une seconde sur un ordinateur portable).
5. **Un point mesuré** : un rayon par instant, du point vers le soleil, à travers la grille (relief, bâtiments, bois). Au-delà
   du bord de la grille, un **horizon lointain** prend le relais : sur des tuiles de relief de zoom 11 (environ 55 m),
   l'élévation apparente du relief jusqu'à 20 km est relevée dans 360 directions, courbure de la Terre comprise ; le soleil
   doit passer au-dessus. Le jour : un instant toutes les 5 minutes. L'année : toutes les 10 minutes, 365 jours, à l'heure
   civile (changements d'heure compris), soit 52 560 instants calculés en quelques dizaines de millisecondes.
6. **Affichage** : l'image RGBA est envoyée à une source `canvas` de MapLibre, géoréférencée sur la grille.
   Le relief et les bâtiments 3D sont des couches MapLibre classiques. La lumière des bâtiments 3D (`map.setLight`, ancre
   « carte ») est placée à l'azimut et à la hauteur du soleil, sans transition ; du coucher à −6°, elle s'assombrit et
   monte au zénith (`sunLight`, `js/map.js`).

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
- Sur la carte, seuls le relief, les bâtiments et les bois de la zone calculée (la vue et 30 % autour) portent ombre : en
  montagne, l'ombre d'un sommet hors de la vue manque. Les mesures d'un point (jour, année, façade) comptent en plus le
  relief jusqu'à 20 km, à 55 m près ; les bâtiments et les arbres plus lointains n'y entrent pas.
- Les ombres des bâtiments situés juste hors de la zone chargée peuvent manquer en bord de carte.
- Arbres : seuls les bois et forêts d'OpenStreetMap comptent, tous à 15 m de haut et feuillus toute l'année. Les arbres
  isolés et les alignements de rues n'y sont pas : il faudrait une autre source (Overpass), donc une nouvelle origine
  externe à ajouter à la politique de sécurité. Les parcs, surtout des pelouses, ne comptent pas.
- Un bois est vu d'en haut : sa cime est au soleil, son ombre tombe sur le terrain découvert voisin. Un point posé dans un
  bois est mesuré au sol, sous les arbres (à hauteur de drone, au-dessus).
- Lever et coucher du soleil et de la lune sont astronomiques : le relief qui masque l'horizon n'y entre pas (il entre en
  revanche dans les heures de soleil d'un point et d'une façade).
- La façade est lue sur les emprises de bâtiments de la carte : un mur absent d'OpenStreetMap ne sera pas trouvé, et
  l'orientation se règle alors à la main.
- En 3D, l'éclairage d'une façade ne dépend que de son orientation : un mur tourné vers le soleil reste clair même à
  l'ombre d'un autre bâtiment ou du relief (l'ombre se voit au sol, pas sur le mur). Les tuiles regroupent les bâtiments
  en gros blocs (jusqu'à des centaines par objet) : on ne peut pas en assombrir un seul. De vraies ombres portées sur
  les murs demanderaient une couche WebGL sur mesure.
- Le carnet de lieux reste dans le navigateur où il a été rempli : il ne passe pas d'un appareil à l'autre.
- À l'échelle d'un pays ou d'un continent, la direction du soleil est celle du centre de la carte ; seule la limite
  jour/nuit (terminateur) est calculée point par point.
- Quand la vue est plus large que le monde, la grille couvre exactement un tour de la Terre et la carte la répète
  de chaque côté. Le relief n'est alors qu'esquissé : une cellule fait plusieurs dizaines de kilomètres.
- Les zones sous le niveau de la mer (mer Morte, polders) sont ramenées à 0 m pour ne pas faire de la côte une falaise.
