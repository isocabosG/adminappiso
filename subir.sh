#!/usr/bin/env bash
# subir.sh — compila y empuja a main. Para teclear poco desde el telefono.
#
# POR QUE NO HACE COMMIT
# Compilar y empujar son reversibles; un commit con mensaje inventado por un
# script se queda en la historia para siempre. Si hay cambios sin commitear,
# esto se detiene y te los ensenna en vez de adivinar que querias decir.
#
# POR QUE COMPILA ANTES DE EMPUJAR
# Vercel construye lo que llega a main. Si el build truena aqui, truena alla, y
# para cuando te enteras la produccion ya no corresponde a ningun commit.
set -euo pipefail
cd "$(dirname "$0")"

sucio="$(git status --porcelain | grep -v '^??' || true)"
if [ -n "$sucio" ]; then
  echo "Hay cambios sin commitear. Primero decide que hacer con ellos:"
  echo "$sucio"
  exit 1
fi

echo "Revisando el remoto..."
git fetch -q origin

atras="$(git log --oneline HEAD..origin/main | wc -l | tr -d ' ')"
if [ "$atras" != "0" ]; then
  echo "Ojo: el remoto trae $atras commit(s) que tu no tienes. Haz 'git pull' antes."
  exit 1
fi

pend="$(git log --oneline origin/main..HEAD)"
if [ -z "$pend" ]; then
  echo "No hay nada pendiente. El remoto ya esta al dia."
  exit 0
fi

echo
echo "Se va a subir:"
echo "$pend"
echo
echo "Compilando..."
npm run build

echo
echo "Empujando a main..."
git push origin main
echo
echo "Listo. Vercel toma el commit nuevo en 1-2 minutos."
