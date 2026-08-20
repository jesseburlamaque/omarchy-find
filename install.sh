#!/bin/bash

# Installs/uninstalls the plugin.
# Usage:
#   ./install.sh            Install & enable
#   ./install.sh --disable  Disable & remove

set -euo pipefail

PLUGIN_ID="jesseburlamaque.omarchy-find"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$HOME/.config/omarchy/plugins/$PLUGIN_ID"

if [[ "${1:-}" == "--disable" ]]; then
  echo "==> Desabilitando $PLUGIN_ID"
  omarchy plugin disable "$PLUGIN_ID" || true
  echo "==> Removendo $PLUGIN_DIR"
  rm -rf "$PLUGIN_DIR"
  rm -f "$HOME/.local/bin/omarchy-find"
  rm -f "$HOME/.local/share/applications/omarchy-find.desktop"
  omarchy-shell shell rescanPlugins || true
  echo "Pronto — plugin removido."
  exit 0
fi

echo "==> Validando o plugin"
omarchy plugin validate "$PROJECT_DIR"

echo "==> Copiando para $PLUGIN_DIR"
mkdir -p "$PLUGIN_DIR"
install -m 644 "$PROJECT_DIR/manifest.json" "$PLUGIN_DIR/manifest.json"
install -m 644 "$PROJECT_DIR/Find.qml" "$PLUGIN_DIR/Find.qml"
install -m 644 "$PROJECT_DIR/FindBackend.js" "$PLUGIN_DIR/FindBackend.js"
install -m 644 "$PROJECT_DIR/Widget.qml" "$PLUGIN_DIR/Widget.qml"

echo "==> Instalando o CLI omarchy-find em ~/.local/bin"
mkdir -p "$HOME/.local/bin"
install -m 755 "$PROJECT_DIR/bin/omarchy-find" "$HOME/.local/bin/omarchy-find"

echo "==> Registrando o app Find no launcher"
mkdir -p "$HOME/.local/share/applications"
install -m 644 "$PROJECT_DIR/share/omarchy-find.desktop" "$HOME/.local/share/applications/omarchy-find.desktop"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" || true

echo "==> Reescaneando os plugins do shell"
omarchy-shell shell rescanPlugins

echo "==> Aguardando o shell descobrir o plugin"
found=0
for _ in $(seq 1 25); do
  if omarchy-shell shell listPlugins 2>/dev/null | jq -e --arg id "$PLUGIN_ID" 'any(.[]; .id == $id)' >/dev/null 2>&1; then
    found=1
    break
  fi
  sleep 0.2
done
if [[ "$found" != "1" ]]; then
  echo "erro: o shell não descobriu $PLUGIN_ID; veja os logs do omarchy-shell" >&2
  exit 1
fi

echo "==> Habilitando (adiciona a lupa na seção direita da barra)"
omarchy plugin enable "$PLUGIN_ID"

echo
echo "Pronto! Abra com:"
echo "  omarchy-find            # closes if already open"
echo "  omarchy-find open '{\"query\":\"notas\"}'"
echo "ou clique na lupa 󰍉 na barra."
