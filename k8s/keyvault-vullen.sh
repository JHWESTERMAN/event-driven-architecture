#!/usr/bin/env bash
# Maakt de ontbrekende geheimen in een Azure Key Vault aan met willekeurige waarden (bestaande blijven ongemoeid).
# Gebruik: ./k8s/keyvault-vullen.sh <naam-van-de-kluis>      Vereist: az, ingelogd, met schrijfrechten op de kluis.
# Niet op een kluis getest; de namen komen overeen met k8s/70-secrets-keyvault.yaml.
set -euo pipefail
KLUIS="${1:?Gebruik: ./k8s/keyvault-vullen.sh <naam-van-de-kluis>}"

# <naam> <waarde of "willekeurig">: gebruikersnamen zijn geen geheim maar horen bij dezelfde Secrets
GEHEIMEN=(
  "artemis-admin-user artemis"
  "artemis-admin-password willekeurig"
  "artemis-source-user source-adapter"
  "artemis-source-password willekeurig"
  "artemis-target-user target-adapter"
  "artemis-target-password willekeurig"
  "target-adapter-client-secret willekeurig"
  "keycloak-admin-password willekeurig"
)
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
chmod 600 "$TMP"
for regel in "${GEHEIMEN[@]}"; do
  read -r naam waarde <<< "$regel"
  if az keyvault secret show --vault-name "$KLUIS" --name "$naam" >/dev/null 2>&1; then
    echo "aanwezig:  $naam"
  else
    if [ "$waarde" = "willekeurig" ]; then openssl rand -hex 24 | tr -d '\n' > "$TMP"; else printf '%s' "$waarde" > "$TMP"; fi
    az keyvault secret set --vault-name "$KLUIS" --name "$naam" --file "$TMP" --encoding utf-8 >/dev/null
    echo "aangemaakt: $naam"
  fi
done
