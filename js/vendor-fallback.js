// Repli, uniquement si vendor/ n'a pas été généré (npm run vendor) : MapLibre depuis unpkg, avec empreinte SRI.
// Fichier à part plutôt qu'en ligne : la page tient sous une CSP qui interdit les scripts en ligne.
if (!window.maplibregl) {
  document.write('<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css" integrity="sha384-uTttxo/aOKbdE5RlD/SPzSDoDmNvGlUYPjONi2MN/b7c9HPSvW07OIuyP7uL6jxK" crossorigin="anonymous">');
  document.write('<script src="https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js" integrity="sha384-5+cfbwT0iiub6VsQAdn6yz16nr6sDiQoHx6tm4O8OVYXHYOxcffFmCJBL0dgdvGp" crossorigin="anonymous"><\/script>');
}
