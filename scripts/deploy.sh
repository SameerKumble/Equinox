#!/usr/bin/env bash
# Déploie la banque (conteneur Docker) et l'application (fichiers statiques) sur le serveur.
#
#   scripts/deploy.sh bank    tests, puis code du backend: l'image est reconstruite et le conteneur redémarré
#   scripts/deploy.sh web     tests, build, puis publication des fichiers de l'application
#   scripts/deploy.sh         les deux
#
# Variables (valeurs par défaut entre parenthèses):
#   DEPLOY_HOST      alias SSH du serveur (jarvis)
#   DEPLOY_BANK_DIR  dossier de la banque sur le serveur (apps/equinox-bank)
#   DEPLOY_WEB_DIR   dossier des fichiers de l'application, monté en lecture seule dans le proxy (apps/equinox-web/site)
#   DEPLOY_URL       adresse publique, pour le contrôle final (aucun contrôle si absente)
#
# Ne touche jamais au .env du serveur (réglages, liste des inscriptions) ni à ses données (clé de signature, base).
# La mise en place du proxy HTTPS (bloc de domaine, montage du dossier) est décrite dans le README.
set -euo pipefail

cd "$(dirname "$0")/.."
HOST=${DEPLOY_HOST:-jarvis}
BANK_DIR=${DEPLOY_BANK_DIR:-apps/equinox-bank}
WEB_DIR=${DEPLOY_WEB_DIR:-apps/equinox-web/site}
URL=${DEPLOY_URL:-}

say() { printf '\n== %s\n' "$*"; }

deploy_bank() {
  say "Backend: tests"
  (cd server && npm test --silent)

  say "Backend: envoi du code vers $HOST:$BANK_DIR"
  ssh "$HOST" "mkdir -p '$BANK_DIR'"
  # Seul src/ est synchronisé avec suppression: le reste du dossier (.env, données, sauvegardes faites à la main) n'est jamais touché.
  rsync -a --delete server/src/ "$HOST:$BANK_DIR/src/"
  rsync -a server/package.json server/Dockerfile server/.dockerignore server/docker-compose.yml server/.env.example "$HOST:$BANK_DIR/"

  say "Backend: construction et redémarrage"
  ssh "$HOST" bash -s -- "$BANK_DIR" <<'REMOTE'
set -euo pipefail
cd "$1"
[ -f .env ] || { echo "Il manque $1/.env (copier .env.example et l'adapter)"; exit 1; }
mkdir -p data run
docker compose up -d --build
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' equinox-bank)" = healthy ] && { echo "equinox-bank: en bonne santé"; exit 0; }
  sleep 2
done
docker logs --tail 30 equinox-bank
echo "equinox-bank n'est pas devenu sain"
exit 1
REMOTE
}

deploy_web() {
  if ! grep -qs '^VITE_DYNAMIC_ENVIRONMENT_ID=.\+' app/.env && [ -z "${VITE_DYNAMIC_ENVIRONMENT_ID:-}" ]; then
    echo "VITE_DYNAMIC_ENVIRONMENT_ID est absent (app/.env): l'application construite ne pourrait pas créer de wallet."
    exit 1
  fi

  say "Application: tests et build"
  (cd app && npm test --silent && npm run build --silent)

  say "Application: envoi vers $HOST:$WEB_DIR"
  ssh "$HOST" "mkdir -p '$WEB_DIR'"
  # Fichiers à nom unique d'abord, puis index.html, puis suppression des anciens: un visiteur ne tombe jamais sur une
  # page dont les fichiers ont disparu.
  rsync -a --chmod=D755,F644 app/dist/assets/ "$HOST:$WEB_DIR/assets/"
  rsync -a --delete --chmod=D755,F644 app/dist/ "$HOST:$WEB_DIR/"
}

check() {
  [ -n "$URL" ] || return 0
  say "Contrôle de $URL"
  curl -fsS -m 15 "$URL/" | grep -q '<div id="root">' && echo "page d'accueil: ok"
  curl -fsS -m 15 "$URL/api/health" | grep -q '"ok":true' && echo "API: ok"
}

case "${1:-all}" in
  bank) deploy_bank ;;
  web) deploy_web ;;
  all) deploy_bank; deploy_web ;;
  *) echo "Usage: $0 [bank|web]"; exit 2 ;;
esac
check
