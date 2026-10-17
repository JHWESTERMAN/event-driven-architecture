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
| Protocollen | CORE en AMQP 1.0 op poort 61616 |
| Webconsole | http://localhost:8161 (alleen localhost) |

## Starten en controleren

```bash
docker compose up -d artemis
docker compose logs artemis --tail 30        # zoek naar "Server is now live" en geen fouten over broker.xml
docker compose exec artemis /var/lib/artemis-instance/bin/artemis queue stat --user artemis --password artemis
```

`queue stat` hoort `eam.workorder.v1` en `eam.workorder.v1.dlq` te tonen.

## Een wijziging in broker.xml laten werken

De image kopieert `etc-override` alleen bij het aanmaken van de instantie. Na een wijziging in `broker.xml` moet de instantie
dus opnieuw worden aangemaakt. Dat wist de berichten in de broker (voor de PoC prima):

```bash
docker compose rm -sf artemis && docker volume rm $(docker volume ls -q | grep artemis-data) && docker compose up -d artemis
```

## Gebruikers en rechten

| Gebruiker | Rol | Mag |
|---|---|---|
| `ARTEMIS_USER` (console, rooktest) | `amq` | alles |
| `SOURCE_ADAPTER_BROKER_USER` | `eam-source` | alleen versturen naar `eam.workorder.v1` |
| `TARGET_ADAPTER_BROKER_USER` | `eam-target` | ontvangen van `eam.workorder.v1`, versturen naar `eam.workorder.v1.dlq` |

`init-users.sh` schrijft de gebruikers en rollen (en kopieert `broker.xml`) naar `etc-override` in het volume. In Compose doet de
service `artemis-init` dat vóór Artemis start, in k8s een initContainer. Zoals altijd leest Artemis die map alleen bij het aanmaken van de instance:
bij wijzigingen `docker compose down -v` (of het StatefulSet en de PVC verwijderen). De rooktest (stap 4c) controleert de rechten.

## Status van deze configuratie

Het bestand is afgeleid van het standaard `broker.xml` van Artemis en is getest met `scripts/smoketest.sh --volledig` tegen Artemis 2.57.0
(queue, dead letter address, herlevering, uitputting van de pogingen, ontdubbeling op `_AMQ_DUPL_ID`).
Nog open: aparte gebruikers en rollen per adapter (nu een rol `amq` met alle rechten).
