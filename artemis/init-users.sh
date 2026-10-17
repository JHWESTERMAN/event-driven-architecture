#!/bin/sh
# Maakt de beveiligingsbestanden voor Artemis en zet ze, samen met broker.xml, in <volume>/etc-override.
# Artemis kopieert die map bij het AANMAKEN van de instance over zijn etc/ heen (daarom: na een wijziging het volume wissen).
# Wordt gebruikt door Docker Compose (service artemis-init) en, in dezelfde vorm, door de initContainer in k8s/15-artemis.yaml.
#
# Gebruikers en rollen (zie de security-settings in broker.xml):
#   ADMIN_USER   rol amq         alles (console, beheer, rooktest)
#   SOURCE_USER  rol eam-source  alleen versturen naar eam.workorder.v1
#   TARGET_USER  rol eam-target  ontvangen van eam.workorder.v1, versturen naar eam.workorder.v1.dlq
set -eu

INST="${INST:-/inst}"
SRC="${SRC:-/src/broker.xml}"
D="$INST/etc-override"

for v in ADMIN_USER ADMIN_PASSWORD SOURCE_USER SOURCE_PASSWORD TARGET_USER TARGET_PASSWORD; do
  eval "w=\${$v:-}"
  [ -n "$w" ] || { echo "FOUT: $v is leeg" >&2; exit 1; }
  # In een .properties-bestand zijn deze tekens lastig; liever een duidelijke fout dan een gebruiker die niet kan inloggen
  case "$w" in *[\\\ \	\#\!]*) echo "FOUT: $v bevat een spatie, tab, backslash, # of !" >&2; exit 1 ;; esac
done
[ "$ADMIN_USER" != "$SOURCE_USER" ] && [ "$ADMIN_USER" != "$TARGET_USER" ] && [ "$SOURCE_USER" != "$TARGET_USER" ] \
  || { echo "FOUT: de drie gebruikersnamen moeten verschillen" >&2; exit 1; }

mkdir -p "$D"
cp "$SRC" "$D/broker.xml"

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

# Artemis draait als uid/gid 1001
chown 1001:1001 "$INST" "$D" "$D"/*
chmod 755 "$D"
chmod 644 "$D/broker.xml"
chmod 640 "$D/artemis-users.properties" "$D/artemis-roles.properties"
echo "Artemis-configuratie klaargezet in $D (gebruikers: $ADMIN_USER, $SOURCE_USER, $TARGET_USER)"
