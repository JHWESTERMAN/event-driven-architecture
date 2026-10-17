#!/bin/sh
# Maakt de beveiligingsbestanden voor Artemis en zet ze, samen met broker.xml en de TLS-keystore, in <volume>/etc-override.
# Artemis kopieert die map bij het AANMAKEN van de instance over zijn etc/ heen (daarom: na een wijziging het volume wissen).
# Wordt gebruikt door Docker Compose (service artemis-init) en, in dezelfde vorm, door de initContainer in k8s/15-artemis.yaml.
#
# Gebruikers en rollen (zie de security-settings in broker.xml):
#   ADMIN_USER   rol amq         alles (console, beheer, rooktest)
#   SOURCE_USER  rol eam-source  alleen versturen naar eam.workorder.v1
#   TARGET_USER  rol eam-target  ontvangen van eam.workorder.v1, versturen naar eam.workorder.v1.dlq
#
# Geheimen komen uit bestanden (de kluis legt ze neer; nooit uit git of .env). Per geheim geldt NAAM_FILE=<pad> boven NAAM=<waarde>:
#   ADMIN_PASSWORD, SOURCE_PASSWORD, TARGET_PASSWORD   wachtwoorden van de drie gebruikers
#   KEYSTORE_PASSWORD                                  wachtwoord van de PKCS12-keystore met het servercertificaat
# De keystore zelf staat op TLS_KEYSTORE (standaard /tls/broker.p12), gemaakt door scripts/maak-certs.sh.
set -eu

INST="${INST:-/inst}"
SRC="${SRC:-/src/broker.xml}"
TLS_KEYSTORE="${TLS_KEYSTORE:-/tls/broker.p12}"
D="$INST/etc-override"

fout() { echo "FOUT: $*" >&2; exit 1; }

# lees NAAM: de waarde uit het bestand NAAM_FILE, anders uit de variabele NAAM
lees() {
  eval "f=\${$1_FILE:-}"
  if [ -n "$f" ]; then
    [ -r "$f" ] || fout "$1_FILE ($f) is niet te lezen"
    cat "$f"                       # $(...) haalt de afsluitende regeleinde weg
  else
    eval "printf '%s' \"\${$1:-}\""
  fi
}

for v in ADMIN_USER SOURCE_USER TARGET_USER; do
  eval "w=\${$v:-}"; [ -n "$w" ] || fout "$v is leeg"
done
ADMIN_PASSWORD="$(lees ADMIN_PASSWORD)"; SOURCE_PASSWORD="$(lees SOURCE_PASSWORD)"; TARGET_PASSWORD="$(lees TARGET_PASSWORD)"
KEYSTORE_PASSWORD="$(lees KEYSTORE_PASSWORD)"

for v in ADMIN_PASSWORD SOURCE_PASSWORD TARGET_PASSWORD; do
  eval "w=\${$v:-}"
  [ -n "$w" ] || fout "$v is leeg (zet $v of ${v}_FILE; zie scripts/kluis.sh)"
  # In een .properties-bestand zijn deze tekens lastig; liever een duidelijke fout dan een gebruiker die niet kan inloggen
  case "$w" in *[\\\ \	\#\!]*) fout "$v bevat een spatie, tab, backslash, # of !" ;; esac
done
[ "$ADMIN_USER" != "$SOURCE_USER" ] && [ "$ADMIN_USER" != "$TARGET_USER" ] && [ "$SOURCE_USER" != "$TARGET_USER" ] \
  || fout "de drie gebruikersnamen moeten verschillen"

# De keystore-wachtwoorden belanden in de acceptor-URL van broker.xml (gescheiden door ; en =), dus alleen veilige tekens
case "$KEYSTORE_PASSWORD" in ''|*[!A-Za-z0-9._~-]*) fout "KEYSTORE_PASSWORD ontbreekt of bevat andere tekens dan letters, cijfers en . _ ~ -" ;; esac
[ -r "$TLS_KEYSTORE" ] || fout "keystore $TLS_KEYSTORE niet gevonden. Maak hem met scripts/maak-certs.sh"
grep -q '@KEYSTORE_PASSWORD@' "$SRC" || fout "$SRC mist de plaatshouder @KEYSTORE_PASSWORD@ (zonder die gaat TLS niet aan)"

mkdir -p "$D"
sed "s|@KEYSTORE_PASSWORD@|$KEYSTORE_PASSWORD|g" "$SRC" > "$D/broker.xml"
cp "$TLS_KEYSTORE" "$D/broker.p12"

cat > "$D/artemis-users.properties" <<PROP
$ADMIN_USER=$ADMIN_PASSWORD
$SOURCE_USER=$SOURCE_PASSWORD
$TARGET_USER=$TARGET_PASSWORD
PROP

cat > "$D/artemis-roles.properties" <<PROP
amq=$ADMIN_USER
eam-source=$SOURCE_USER
eam-target=$TARGET_USER
PROP

# Artemis draait als uid/gid 1001. broker.xml bevat nu het keystore-wachtwoord en hoort dus bij de andere geheime bestanden.
chown 1001:1001 "$INST" "$D" "$D"/*
chmod 755 "$D"
chmod 640 "$D/broker.xml" "$D/broker.p12" "$D/artemis-users.properties" "$D/artemis-roles.properties"
echo "Artemis-configuratie klaargezet in $D (gebruikers: $ADMIN_USER, $SOURCE_USER, $TARGET_USER; TLS aan)"
