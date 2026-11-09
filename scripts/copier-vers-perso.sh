#!/bin/sh
# Recopie Ombres dans le site perso : le dossier moodboard/public/ombres/ d'un checkout du dépôt timelesshouse-website,
# de préférence un worktree sur une branche tirée de main (jamais le checkout principal, qui porte d'autres travaux).
#
#   scripts/copier-vers-perso.sh <checkout>/moodboard/public/ombres
#
# Les fichiers supprimés ici le sont aussi là-bas ; l'aperçu de la carte d'accueil (apercu.jpg) est conservé.
# Ensuite : PR sur main, fusion, déploiement depuis main (README de moodboard).
set -eu
DEST=${1:?"Usage : scripts/copier-vers-perso.sh <checkout>/moodboard/public/ombres"}
if [ ! -f "$(dirname "$DEST")/_headers" ]; then
  echo "« $DEST » n'est pas le dossier ombres/ du site perso (pas de _headers à côté)." >&2
  exit 1
fi
cd "$(dirname "$0")/.."
mkdir -p "$DEST"
# Un fichier exclu n'est jamais supprimé par --delete : l'aperçu reste, quelle que soit la façon de synchroniser.
rsync -a --delete --exclude=/apercu.jpg index.html manifest.webmanifest assets css js vendor "$DEST/"
echo "Ombres recopiée dans $DEST"
