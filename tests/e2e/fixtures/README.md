# Fixtures de test

`ofm-*.json` : styles OpenFreeMap tels que publiés dans
[hyperknot/openfreemap-styles](https://github.com/hyperknot/openfreemap-styles) (Bright et Positron sont des
forks des styles OpenMapTiles, BSD-3 / CC-BY 4.0 ; Liberty dérive d'osm-liberty, BSD-3). Ils servent uniquement
à vérifier que l'application s'accroche correctement à la structure réelle de ces styles (nom de la source
vectorielle, couches de bâtiments, polices) ; le serveur de test remplace `__TILEJSON_DOMAIN__` par ses tuiles factices.
