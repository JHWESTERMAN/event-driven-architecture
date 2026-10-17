#!/usr/bin/env bash
# Maakt de TLS-bestanden voor de Artemis-acceptor, voor lokaal gebruik (Docker Compose):
#
#   secrets/tls/ca.pem      de lokale CA (openbaar). De adapters vertrouwen alleen deze CA (BROKER_TLS_CA).
#   secrets/tls/ca.key      privésleutel van de CA. Blijft op deze computer; niet delen, niet in git.
#   secrets/tls/broker.p12  servercertificaat + sleutel voor Artemis (PKCS12), beschermd met het wachtwoord uit
#                           secrets/artemis_keystore_password (dat komt uit de kluis: ./scripts/kluis.sh uitrollen).
#
# Het certificaat geldt voor de namen artemis (Compose), artemis.werkorder.svc[.cluster.local] (k8s) en localhost/127.0.0.1.
# Gebruik:   ./scripts/maak-certs.sh            maakt alleen wat ontbreekt (andere map: SECRETS_DIR=/pad ./scripts/maak-certs.sh)
#            ./scripts/maak-certs.sh --opnieuw  geeft een nieuw servercertificaat uit (zelfde CA, tenzij je die ook weggooit)
# In productie vervang je dit door certificaten van de CA van de organisatie (of cert-manager in k8s); de rest blijft gelijk.
set -euo pipefail
cd "$(dirname "$0")/.."

SECRETS_DIR="${SECRETS_DIR:-secrets}"      # deploy.sh gebruikt een tijdelijke map
DIR="$SECRETS_DIR/tls"
WACHTWOORD="$SECRETS_DIR/artemis_keystore_password"
DAGEN_CA=1095
DAGEN_SERVER=365

OPNIEUW=0; [ "${1:-}" = "--opnieuw" ] && OPNIEUW=1
command -v openssl >/dev/null || { echo "FOUT: openssl is niet geïnstalleerd" >&2; exit 1; }
[ -s "$WACHTWOORD" ] || { echo "FOUT: $WACHTWOORD ontbreekt. Haal eerst de geheimen uit de kluis: ./scripts/kluis.sh klaarzetten" >&2; exit 1; }

umask 077
mkdir -p "$DIR"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

if [ ! -s "$DIR/ca.key" ] || [ ! -s "$DIR/ca.pem" ]; then
  cat > "$TMP/ca.cnf" <<CNF
[req]
distinguished_name=dn
prompt=no
x509_extensions=ext
[dn]
CN=werkorder-eda lokale CA
[ext]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
CNF
  openssl req -x509 -newkey rsa:4096 -nodes -days "$DAGEN_CA" -config "$TMP/ca.cnf" -keyout "$DIR/ca.key" -out "$DIR/ca.pem" 2>/dev/null
  echo "CA gemaakt ($DIR/ca.pem, geldig $DAGEN_CA dagen)"
  OPNIEUW=1                                  # een nieuwe CA betekent een nieuw servercertificaat
fi

if [ "$OPNIEUW" -eq 1 ] || [ ! -s "$DIR/broker.p12" ]; then
  cat > "$TMP/server.cnf" <<CNF
[req]
distinguished_name=dn
prompt=no
req_extensions=ext
[dn]
CN=artemis
[ext]
subjectAltName=DNS:artemis,DNS:localhost,DNS:artemis.werkorder,DNS:artemis.werkorder.svc,DNS:artemis.werkorder.svc.cluster.local,IP:127.0.0.1
extendedKeyUsage=serverAuth
keyUsage=critical,digitalSignature,keyEncipherment
basicConstraints=CA:FALSE
CNF
  openssl req -new -newkey rsa:2048 -nodes -config "$TMP/server.cnf" -keyout "$TMP/broker.key" -out "$TMP/broker.csr" 2>/dev/null
  openssl x509 -req -in "$TMP/broker.csr" -CA "$DIR/ca.pem" -CAkey "$DIR/ca.key" -CAcreateserial -CAserial "$TMP/ca.srl" \
    -days "$DAGEN_SERVER" -extfile "$TMP/server.cnf" -extensions ext -out "$TMP/broker.crt" 2>/dev/null
  openssl verify -CAfile "$DIR/ca.pem" "$TMP/broker.crt" >/dev/null
  openssl pkcs12 -export -name artemis -inkey "$TMP/broker.key" -in "$TMP/broker.crt" -certfile "$DIR/ca.pem" \
    -passout "file:$WACHTWOORD" -out "$DIR/broker.p12"
  echo "Servercertificaat gemaakt ($DIR/broker.p12, geldig $DAGEN_SERVER dagen)"
  if command -v keytool >/dev/null; then
    keytool -list -keystore "$DIR/broker.p12" -storetype PKCS12 -storepass:file "$WACHTWOORD" >/dev/null 2>&1 \
      && echo "keytool kan de keystore openen (Java leest hem dus ook)" \
      || echo "WAARSCHUWING: keytool kon de keystore niet openen" >&2
  fi
fi

# De compose-bestanden worden met de rechten van de host in de containers gemonteerd; de adapters (uid 1000) moeten ze kunnen lezen.
# Daarom zijn ca.pem (openbaar) en broker.p12 (met wachtwoord beschermd) leesbaar; ca.key blijft alleen voor jou.
chmod 700 "$DIR"; chmod 600 "$DIR/ca.key"; chmod 644 "$DIR/ca.pem" "$DIR/broker.p12"
echo "Klaar. Volgende stap: docker compose down -v && docker compose up -d --build   (Artemis leest zijn configuratie alleen bij het aanmaken van het volume)"
