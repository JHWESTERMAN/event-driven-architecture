# Event-driven architecture: werkorder-notificaties

Een lokale proof-of-concept van een event-driven architectuur. Een werkorder-event gaat via Kafka (Redpanda)
naar een Node.js-microservice, die het in real time doorstuurt naar monteurs via WebSocket. Een nginx-gateway
staat als enige toegangspunt aan de voorkant.

Het project laat zien hoe je in een event-driven omgeving omgaat met contracten, validatie en foutafhandeling
(poison messages, dead letter topic).

## Architectuur

```
 Producer                Redpanda (Kafka)                 Microservice                 Gateway            Monteur
 (rpk / app)                                              (Node.js, kafkajs)           (nginx)            (browser / wscat)

 werkorder-event ──►  topic: werkorder-notificaties ──►  consumer group         ──►  /ws  (WebSocket) ──►  ontvangt melding
                                                          │  1. leeg?
                                                          │  2. geldige JSON?
                                                          │  3. voldoet aan contract?
                                                          │
                                                          └─ fout ──►  topic: werkorder-notificaties.dlq
                                                                       (bericht + reden + herkomst in headers)
```

| Onderdeel | Rol |
|---|---|
| **Redpanda** | Kafka-compatibele broker (single node, dev-modus) |
| **redpanda-init** | Eenmalige container die de topics aanmaakt (idempotent) |
| **ws-microservice** | Consumer + WebSocket-server + producer voor de dead letter topic |
| **api-gateway** | nginx: serveert de HTML-pagina en proxyt `/ws` naar de microservice |

## Projectstructuur

```
event-driven-architecture/
├── docker-compose.yml        # Redpanda, init-container, microservice, gateway
├── gateway/
│   ├── nginx.conf            # upstream, WebSocket-proxy, rate limiting
│   └── html/                 # statische pagina voor de monteur
├── microservice/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js             # consumer, validatie, broadcast, dead letter topic
└── README.md
```

## Snel starten

Vereist: Docker Desktop (met `docker compose`). Node.js is lokaal alleen nodig voor `wscat`.

```bash
# bouwen en starten
docker compose up -d --build

# controleren dat alles draait (redpanda-init hoort te eindigen met "Exited (0)")
docker compose ps -a

# logs van de microservice
docker compose logs ws-microservice --tail 20
```

Je ziet in de logs onder andere:

```
Succesvol verbonden met Redpanda/Kafka broker: redpanda:9092
Luisteren naar Kafka topic: 'werkorder-notificaties' (dead letter topic: 'werkorder-notificaties.dlq')...
```

## Testen

**1. Open een WebSocket-client als monteur** (eigen terminalvenster):

```bash
npx wscat -c ws://localhost/ws
```

Je krijgt eerst een SYSTEM-bericht: `Verbonden met het Werkorder Notificatiesysteem via API Gateway`.

**2. Stuur een geldig bericht** (tweede terminalvenster):

```bash
docker exec -it redpanda rpk topic produce werkorder-notificaties -z none
```

Typ per regel één bericht en sluit af met Enter. Stop met Ctrl+C.

```json
{"werkorderId":"WO-1002","status":"IN_BEHANDELING","bericht":"Monteur onderweg"}
```

Het bericht verschijnt in `wscat`.

**3. Stuur ongeldige berichten:**

```
{"werkorderId":"WO-2001","status":"KAPOT","bericht":"verkeerde status"}
{"status":"OPEN","bericht":"werkorderId ontbreekt"}
dit is geen json
```

Er verschijnt niets in `wscat`. De berichten staan in de dead letter topic:

```bash
docker exec -it redpanda rpk topic consume werkorder-notificaties.dlq -o start -n 3 \
  -f '%v\n  %h{  - %k = %v\n}\n'
```

Voorbeeld van de uitvoer:

```
{"werkorderId":"WO-2001","status":"KAPOT","bericht":"verkeerde status"}
  - dlq-reden = Validatie mislukt: status 'KAPOT' is ongeldig (toegestaan: OPEN, IN_BEHANDELING, AFGEROND)
  - dlq-bron-topic = werkorder-notificaties
  - dlq-bron-partitie = 0
  - dlq-bron-offset = 2
  - dlq-tijdstip = 2026-10-16T12:19:00.890Z
```

> `-z none` zet compressie uit. `rpk` gebruikt standaard Snappy, en de gebruikte kafkajs-bibliotheek kan dat
> zonder extra codec niet lezen (zie *Geleerde lessen*).

## Berichtcontract

Berichten op `werkorder-notificaties` zijn JSON-objecten met deze velden:

| Veld | Type | Verplicht | Regels |
|---|---|---|---|
| `werkorderId` | string | ja | niet leeg |
| `status` | string (enum) | ja | `OPEN`, `IN_BEHANDELING` of `AFGEROND` |
| `bericht` | string | ja | niet leeg |

Voorbeeld:

```json
{"werkorderId":"WO-1001","status":"OPEN","bericht":"Nieuwe storing toegewezen"}
```

## Foutafhandeling en dead letter topic

De consumer mag nooit crashen op één slecht bericht (een *poison message*). Elk bericht doorloopt daarom drie
controles. Bij een fout wordt het bericht ongewijzigd naar `werkorder-notificaties.dlq` gestuurd en gaat de consumer
door met het volgende bericht.

| Controle | Voorbeeld | Reden in de DLQ |
|---|---|---|
| Leeg bericht | lege regel in `rpk` | `Leeg bericht` |
| Geldige JSON | `dit is geen json` | `Ongeldige JSON: ...` |
| Voldoet aan het contract | `status` is `KAPOT` | `Validatie mislukt: ...` |

Elk DLQ-bericht krijgt headers mee zodat je het bronbericht altijd kunt terugvinden:

| Header | Inhoud |
|---|---|
| `dlq-reden` | waarom het bericht is afgewezen |
| `dlq-bron-topic` | oorspronkelijk topic |
| `dlq-bron-partitie` | oorspronkelijke partitie |
| `dlq-bron-offset` | oorspronkelijke offset |
| `dlq-tijdstip` | tijdstip van afwijzing (UTC) |

Daarnaast:
- Een crash van de consumer die kafkajs niet zelf kan herstellen, stopt het proces (`process.exit(1)`). Met
  `restart: unless-stopped` in Compose start de container daarna opnieuw.
- Als het versturen naar de DLQ zelf mislukt, wordt dat gelogd. Het bericht gaat dan verloren. Voor productie zou je
  hier juist willen stoppen of opnieuw proberen.

## Belangrijke ontwerpkeuzes

**Redpanda: listen- en advertise-adressen.** Een Kafka-broker vertelt clients waar ze zich opnieuw moeten
verbinden (het *advertise*-adres). Daarom zijn er twee listeners:
`internal://redpanda:9092` voor containers op het Docker-netwerk en `external://localhost:19092` voor clients op de host.
Een client in een container die `localhost` terugkrijgt, verbindt anders met zichzelf.

**Idempotente topic-aanmaak.** De init-container controleert eerst met `rpk topic describe` of het topic bestaat en
maakt het anders aan. Daardoor geeft herhaald `docker compose up -d` geen foutmelding.

**nginx als gateway.** Het upstream-blok verwijst naar de servicenaam `ws-microservice`. Voor WebSocket zijn
`proxy_http_version 1.1` en de headers `Upgrade` en `Connection` nodig. `proxy_read_timeout` is hoog gezet zodat
langlopende verbindingen niet worden afgebroken. `limit_req` beperkt het aantal nieuwe verbindingen per client.

**Consumer group.** `monteur-notificatie-group` verdeelt de partities over instanties. Meerdere instanties van de
microservice kunnen dus parallel meedraaien.

## Geleerde lessen (troubleshooting)

| Symptoom | Oorzaak | Oplossing |
|---|---|---|
| `host not found in upstream` in nginx | de microservice was niet gestart (bijvoorbeeld door een syntaxfout) | eerst de microservice repareren, dan de gateway herstarten |
| Gateway toont 502 na herbouwen | nginx onthoudt het IP-adres van de upstream bij het opstarten | `docker compose restart api-gateway` |
| `Snappy compression not implemented`, consumer stopt | `rpk` comprimeert standaard met Snappy, kafkajs kent alleen gzip | produceer met `-z none`, of voeg een Snappy-codec toe (`kafkajs-snappy`) |
| Consumer blijft hetzelfde bericht opnieuw crashen | het bericht is niet als gelezen gemarkeerd | service stoppen, `rpk group seek monteur-notificatie-group --to end --topics werkorder-notificaties`, daarna starten |
| Consumer crasht op `message.value.toString()` | bericht zonder inhoud (`null`) | controle op lege waarde vóór verwerken |
| Geen bericht in `wscat` na herstart | open WebSocket-verbindingen sluiten bij een herstart van de container | `wscat` opnieuw verbinden |

## Mogelijke vervolgstappen

- Berichten uit de DLQ na herstel opnieuw aanbieden aan het hoofdtopic (replay).
- Contract vastleggen in een JSON Schema en afdwingen via de schema registry (Redpanda levert er een mee).
- Authenticatie op de WebSocket-verbinding (bijvoorbeeld een JWT, gevalideerd in de gateway).
- Monitoring en alarmering op het aantal DLQ-berichten en de consumer lag.
- Een Snappy- of LZ4-codec toevoegen zodat de consumer ook gecomprimeerde berichten van andere producers leest.

## Opruimen

```bash
docker compose down        # containers stoppen en verwijderen
docker compose down -v     # ook het datavolume met de topics verwijderen
```
