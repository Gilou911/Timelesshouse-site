// Replis si vendor/ n'a pas été généré (npm run vendor) ou si l'un de ses fichiers ne se charge pas :
// MapLibre depuis unpkg, avec empreinte SRI. Fichier à part plutôt qu'en ligne : la page tient sous une CSP
// qui interdit les scripts en ligne. Le CSS et le JS sont vérifiés chacun de leur côté.
(function () {
  // Un script classique attend les feuilles de style qui le précèdent : le CSS local est donc chargé, ou en
  // échec, quand celui-ci s'exécute. On le vérifie à son effet (règle .maplibregl-map de MapLibre).
  var probe = document.createElement('div');
  probe.className = 'maplibregl-map';
  document.body.appendChild(probe);
  var cssLoaded = getComputedStyle(probe).overflow === 'hidden';
  document.body.removeChild(probe);
  if (!cssLoaded) {
    document.write('<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css" integrity="sha384-uTttxo/aOKbdE5RlD/SPzSDoDmNvGlUYPjONi2MN/b7c9HPSvW07OIuyP7uL6jxK" crossorigin="anonymous">');
  }
  if (!window.maplibregl) {
    document.write('<script src="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js" integrity="sha384-5+cfbwT0iiub6VsQAdn6yz16nr6sDiQoHx6tm4O8OVYXHYOxcffFmCJBL0dgdvGp" crossorigin="anonymous"><\/script>');
  }
})();
