# artemis/

Configuratie voor de taakgerichte broker (Apache ActiveMQ Artemis, image `apache/artemis:2.57.0`).

`etc-override/broker.xml` vervangt het standaard `broker.xml` van de instantie. Daarin staan:

| Wat | Waarde |
|---|---|
| Queue (anycast) | `eam.workorder.v1` |
| Dead Letter Address | `eam.workorder.v1.dlq` (queue met dezelfde naam) |
| Pogingen | `max-delivery-attempts` 5 |
| Herlevering | 2 s, daarna x2, maximaal 60 s |
| Auto-aanmaken | uit voor `eam.workorder.v1` en `.dlq`; de queues bestaan dus alleen zoals hier gedefinieerd |
| Protocollen | CORE en AMQP 1.0 op poort 61616, alleen via TLS (PKCS12-keystore, TLS 1.2/1.3) |
| Webconsole | http://localhost:8161 (alleen localhost) |

## Starten en controleren

```bash
./scripts/kluis.sh klaarzetten               # eenmalig: geheimen uit de kluis naar secrets/ en TLS-certificaten
docker compose up -d artemis
docker compose logs artemis --tail 30        # zoek naar "Server is now live" en geen fouten over broker.xml of de keystore
```

De queues en berichten zie je in de console op http://localhost:8161 (gebruiker `artemis`, wachtwoord in `secrets/artemis_admin_password`).
De opdrachtregel-CLI (`artemis queue stat`) heeft een TLS-URL met truststore nodig en is daarom hier niet de aanbevolen weg.

## TLS en geheimen

- `broker.xml` heeft `sslEnabled=true` en de plaatshouder `@KEYSTORE_PASSWORD@`. `init-users.sh` vult die in met het wachtwoord uit `KEYSTORE_PASSWORD_FILE`, kopieert
  de keystore (`TLS_KEYSTORE`, standaard `/tls/broker.p12`) naar `etc-override/broker.p12` en zet alle bestanden op `0640` voor uid 1001.
- Wachtwoorden van de drie gebruikers komen uit `ADMIN_PASSWORD_FILE`, `SOURCE_PASSWORD_FILE` en `TARGET_PASSWORD_FILE` (of de variabele zonder `_FILE`).
  Het keystore-wachtwoord mag alleen letters, cijfers en `. _ ~ -` bevatten, omdat het in de acceptor-URL staat.
- De image maakt bij het aanmaken van de instance één opstartgebruiker uit `ARTEMIS_USER`/`ARTEMIS_PASSWORD`; in Compose is dat de waardeloze gebruiker `bootstrap`.
  `etc-override` vervangt daarna het gebruikersbestand, dus die gebruiker kan niet inloggen (de rooktest controleert dat).
- Certificaten maken: `scripts/maak-certs.sh` (lokale CA, servercertificaat voor `artemis`, `localhost` en de k8s-namen).

## Een wijziging in broker.xml laten werken

De image kopieert `etc-override` alleen bij het aanmaken van de instantie. Na een wijziging in `broker.xml` moet de instantie
dus opnieuw worden aangemaakt. Dat wist de berichten in de broker (voor de PoC prima):

```bash
docker compose rm -sf artemis && docker volume rm $(docker volume ls -q | grep artemis-data) && docker compose up -d artemis
```

## Gebruikers en rechten

| Gebruiker | Rol | Mag |
|---|---|---|
| `artemis` (console, rooktest) | `amq` | alles |
| `SOURCE_ADAPTER_BROKER_USER` | `eam-source` | alleen versturen naar `eam.workorder.v1` |
| `TARGET_ADAPTER_BROKER_USER` | `eam-target` | ontvangen van `eam.workorder.v1`, versturen naar `eam.workorder.v1.dlq` |

`init-users.sh` schrijft de gebruikers en rollen (en kopieert `broker.xml`) naar `etc-override` in het volume. In Compose doet de
service `artemis-init` dat vóór Artemis start, in k8s een initContainer. Zoals altijd leest Artemis die map alleen bij het aanmaken van de instance:
bij wijzigingen `docker compose down -v` (of het StatefulSet en de PVC verwijderen). De rooktest (stap 4c) controleert de rechten.

## Status van deze configuratie

Het bestand is afgeleid van het standaard `broker.xml` van Artemis en is getest met `scripts/smoketest.sh --volledig` tegen Artemis 2.57.0
(queue, dead letter address, herlevering, uitputting van de pogingen, ontdubbeling op `_AMQ_DUPL_ID`).
Gebruikers en rollen per adapter, TLS en geheimen uit een kluis zijn gedaan (zie hierboven). Nog open: certificaten van de CA van de organisatie, rotatie zonder het volume te wissen, en TLS op de webconsole.
