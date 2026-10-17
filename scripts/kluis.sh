#!/usr/bin/env bash
# Lokale kluis (HashiCorp Vault) voor de wachtwoorden van deze omgeving, en het uitrollen ervan naar bestanden voor Docker Compose.
#
#   ./scripts/kluis.sh klaarzetten   alles in één keer: kluis starten, vullen, geheimen uitrollen, certificaten maken
#   ./scripts/kluis.sh start         kluis starten, initialiseren (eenmalig), ontgrendelen, ontbrekende geheimen aanmaken
#   ./scripts/kluis.sh ontgrendel    na een herstart van de kluis (die start altijd verzegeld)
#   ./scripts/kluis.sh uitrollen     geheimen uit de kluis naar secrets/<naam> schrijven (Compose mount ze onder /run/secrets)
#   ./scripts/kluis.sh status        toon de toestand van de kluis en van de bestanden
#
# Zo loopt een geheim: kluis -> bestand -> /run/secrets in de container -> NAAM_FILE in de applicatie. Geen wachtwoord staat in git,
# in .env, in docker-compose.yml of in `docker inspect`. De omgeving draait ook zonder dat de kluis aan staat: de bestanden blijven staan.
# Op AKS doet Azure Key Vault met de Secrets Store CSI-driver hetzelfde (k8s/70-secrets-keyvault.yaml); de applicaties merken niets.
#
# LET OP, alleen voor lokaal gebruik:
#  - secrets/.vault-init.json bevat de unseal-sleutel en het root-token van deze lokale kluis (één sleutel, geen aandeelhouders).
#    In productie init je met meerdere sleutelhouders of gebruik je auto-unseal / een beheerde dienst (Key Vault).
#  - Vault luistert zonder TLS op 127.0.0.1:8200 (alleen vanaf deze computer).
#  - De bestanden onder secrets/ zijn leesbaar (644) omdat Docker ze met de rechten van de host monteert en de containers als
#    niet-root draaien; de map zelf is 700, dus andere gebruikers op deze computer komen er niet bij.
set -euo pipefail
cd "$(dirname "$0")/.."

DIR=secrets
INIT="$DIR/.vault-init.json"
DC="docker compose --profile kluis"
GEHEIMEN=(                      # <pad in de kluis> <sleutel> <bestand onder secrets/>
  "artemis admin_password artemis_admin_password"
  "artemis source_password artemis_source_password"
  "artemis target_password artemis_target_password"
  "artemis keystore_password artemis_keystore_password"
  "keycloak admin_password keycloak_admin_password"
  "target-adapter client_secret target_adapter_client_secret"
)

jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);const r=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],v);console.log(r===undefined||r===null?"":typeof r==="object"?JSON.stringify(r):r)}catch(e){console.log("")}})' "$1"; }
vault_cmd() { # vault_cmd <token of ""> <vault-argumenten...>
  local token="$1"; shift
  if [ -n "$token" ]; then $DC exec -T -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN="$token" vault vault "$@"
  else $DC exec -T -e VAULT_ADDR=http://127.0.0.1:8200 vault vault "$@"; fi
}
fout() { echo "FOUT: $*" >&2; exit 1; }
stap() { printf '==> %s\n' "$*"; }
vault_status() { vault_cmd "" status -format=json 2>/dev/null || true; }   # exitcode 2 (verzegeld) is geen fout; we lezen de JSON
root_token() { [ -s "$INIT" ] || fout "$INIT ontbreekt: start de kluis eerst (./scripts/kluis.sh start)"; jget root_token < "$INIT"; }

cmd_start() {
  command -v docker >/dev/null || fout "docker niet gevonden"
  command -v node >/dev/null || fout "node niet gevonden (nodig om JSON te lezen)"
  umask 077; mkdir -p "$DIR"; chmod 700 "$DIR"
  stap "kluis starten"
  $DC up -d vault >/dev/null
  local s=""
  for _ in $(seq 1 30); do s="$(vault_status)"; [ -n "$(echo "$s" | jget initialized)" ] && break; sleep 1; done
  [ -n "$(echo "$s" | jget initialized)" ] || fout "de kluis geeft geen antwoord (docker compose --profile kluis logs vault)"

  if [ "$(echo "$s" | jget initialized)" != "true" ]; then
    stap "kluis initialiseren (eenmalig)"
    vault_cmd "" operator init -key-shares=1 -key-threshold=1 -format=json > "$INIT.tmp" && mv "$INIT.tmp" "$INIT"
    chmod 600 "$INIT"
  fi
  cmd_ontgrendel

  local root; root="$(root_token)"
  if ! vault_cmd "$root" secrets list -format=json | jget 'werkorder/' | grep -q .; then
    stap "geheimenopslag werkorder/ aanzetten (KV versie 2)"
    vault_cmd "$root" secrets enable -path=werkorder -version=2 kv >/dev/null
  fi
  stap "beleid werkorder-lezer: alleen lezen op werkorder/"
  printf 'path "werkorder/data/*" {\n  capabilities = ["read"]\n}\n' | vault_cmd "$root" policy write werkorder-lezer - >/dev/null

  stap "ontbrekende geheimen aanmaken (bestaande blijven ongemoeid)"
  local regel pad sleutel
  for regel in "${GEHEIMEN[@]}"; do
    read -r pad sleutel _ <<< "$regel"
    if vault_cmd "$root" kv get -field="$sleutel" "werkorder/$pad" >/dev/null 2>&1; then
      echo "    werkorder/$pad $sleutel: aanwezig"
    else
      # De waarde gaat via stdin (key=-) naar de kluis, zodat hij niet in een procesoverzicht verschijnt
      openssl rand -hex 24 | tr -d '\n' | { vault_cmd "$root" kv patch "werkorder/$pad" "$sleutel=-" >/dev/null 2>&1 \
        || { openssl rand -hex 24 | tr -d '\n' | vault_cmd "$root" kv put "werkorder/$pad" "$sleutel=-" >/dev/null; }; }
      echo "    werkorder/$pad $sleutel: nieuw aangemaakt"
    fi
  done
  echo "Kluis klaar. Beheer (alleen lokaal): http://localhost:8200, token staat in $INIT"
}

cmd_ontgrendel() {
  local s; s="$(vault_status)"
  if [ "$(echo "$s" | jget sealed)" = "true" ]; then
    stap "kluis ontgrendelen"
    [ -s "$INIT" ] || fout "$INIT ontbreekt; de kluis is verzegeld en ik heb geen unseal-sleutel"
    vault_cmd "" operator unseal "$(jget unseal_keys_b64.0 < "$INIT")" >/dev/null
  fi
  [ "$(vault_status | jget sealed)" = "false" ] || fout "de kluis blijft verzegeld"
}

cmd_uitrollen() {
  umask 077; mkdir -p "$DIR"; chmod 700 "$DIR"
  [ "$(vault_status | jget sealed)" = "false" ] || fout "de kluis draait niet of is verzegeld (./scripts/kluis.sh start of ontgrendel)"
  stap "kortlevend leestoken maken (beleid werkorder-lezer, 5 minuten)"
  local token; token="$(vault_cmd "$(root_token)" token create -policy=werkorder-lezer -ttl=5m -field=token | tr -d '\r\n')"
  [ -n "$token" ] || fout "kon geen leestoken maken"
  local regel pad sleutel bestand waarde
  for regel in "${GEHEIMEN[@]}"; do
    read -r pad sleutel bestand <<< "$regel"
    waarde="$(vault_cmd "$token" kv get -field="$sleutel" "werkorder/$pad" | tr -d '\r\n')"
    [ -n "$waarde" ] || fout "werkorder/$pad $sleutel is leeg of ontbreekt (./scripts/kluis.sh start)"
    printf '%s' "$waarde" > "$DIR/$bestand.tmp"; chmod 644 "$DIR/$bestand.tmp"; mv "$DIR/$bestand.tmp" "$DIR/$bestand"
    echo "    $DIR/$bestand"
  done
  vault_cmd "$token" token revoke -self >/dev/null 2>&1 || true
}

cmd_status() {
  local s; s="$(vault_status)"
  if [ -z "$s" ]; then echo "kluis: draait niet"; else
    echo "kluis: initialized=$(echo "$s" | jget initialized) sealed=$(echo "$s" | jget sealed)"
  fi
  local regel pad sleutel bestand
  for regel in "${GEHEIMEN[@]}"; do
    read -r pad sleutel bestand <<< "$regel"
    [ -s "$DIR/$bestand" ] && echo "bestand: $DIR/$bestand aanwezig" || echo "bestand: $DIR/$bestand ONTBREEKT"
  done
  for f in tls/ca.pem tls/broker.p12; do [ -s "$DIR/$f" ] && echo "bestand: $DIR/$f aanwezig" || echo "bestand: $DIR/$f ONTBREEKT (./scripts/maak-certs.sh)"; done
}

case "${1:-}" in
  klaarzetten) cmd_start; cmd_uitrollen; ./scripts/maak-certs.sh ;;
  start) cmd_start ;;
  ontgrendel) cmd_ontgrendel ;;
  uitrollen) cmd_uitrollen ;;
  status) cmd_status ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
