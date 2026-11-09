# Images de référence pour `js/png.js`

Petits PNG écrits par Pillow, donc par un encodeur indépendant du décodeur testé. Les empreintes SHA-256
attendues dans `png.test.mjs` sont celles des pixels RVBA tels que Pillow les relit.

- `terrarium-64.png` : relief synthétique encodé en Terrarium, RVB 8 bits, filtres Sub et Paeth.
- `palette-{1,2,4}bit.png` : images à palette avec transparence, 13 pixels de large pour tomber entre deux octets.
- `gray.png`, `gray-alpha.png` : niveaux de gris, sans et avec alpha.
