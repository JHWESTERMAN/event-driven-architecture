# Event-driven architecture: werkorder-notificaties

Een lokale proof-of-concept van een event-driven architectuur met twee kanten:

1. **Asynchroon:** een werkorder-event gaat via Kafka (Redpanda) naar een Node.js-microservice, die het in real time
   als melding doorstuurt naar de juiste monteur via WebSocket.
2. **Synchroon:** de monteur opent een melding en haalt via een REST-API de volledige werkorder op.

Dit is het patroon *event notification + ophalen* (dun event, synchroon detail). Het project laat verder zien hoe je in
een event-driven omgeving omgaat met contracten, validatie, gerichte levering en foutafhandeling (poison messages,
dead letter topic).

## Architectuur

```
 Asynchroon (notificatie)

 Producer      Redpanda (Kafka)               ws-microservice                   api-gateway (nginx)     Monteur-app
 (rpk)                                        (consumer, validatie, routering)

 event ──►  werkorder-notificaties  ──►  consumer group  ──►  routeert op monteurId  ──►  /ws  ──►  melding voor die monteur
                                           │
                                           └─ fout ──►  werkorder-notificaties.dlq
                                                        (bericht + reden + herkomst in headers)

 Synchroon (detail)

 Monteur-app  ──  GET /api/werkorders/{id}  ──►  api-gateway (nginx)  ──►  werkorder-api  ──►  volledige werkorder (JSON)
```

| Onderdeel | Rol |
|---|---|
| **Redpanda** | Kafka-compatibele broker (single node, dev-modus) |
| **redpanda-init** | Eenmalige container die de topics aanmaakt (idempotent) |
| **ws-microservice** | Consumer + validatie + WebSocket-server met gerichte levering per monteur + producer voor de dead letter topic |
| **werkorder-api** | Synchrone REST-API die de volledige werkorder levert, beschreven in OpenAPI |
| **api-gateway** | nginx: serveert de monteur-app, proxyt `/ws` naar de microservice en `/api/` naar de werkorder-API |
| **monteur-app** | Webpagina (`gateway/html/monteur-app.html`): meldingen ontvangen en werkorder bekijken |

## Projectstructuur

```
event-driven-architecture/
├── docker-compose.yml          # Redpanda, init-container, microservice, werkorder-api, gateway
├── gateway/
│   ├── nginx.conf              # twee upstreams, WebSocket-proxy, API-proxy, rate limiting
│   └── html/
│       └── monteur-app.html    # de monteur-webapp (één bestand, geen framework)
├── microservice/               # notificatieservice
│   ├── Dockerfile
│   ├── package.json
│   └── server.js               # consumer, validatie, gerichte levering, heartbeat, dead letter topic
├── werkorder-api/              # synchrone API
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js               # REST-endpoints (alleen Node.js-standaardbibliotheek)
│   └── openapi.yaml            # het contract van de API
└── README.md
```

## Snel starten

Vereist: Docker Desktop (met `docker compose`). Node.js is lokaal alleen nodig voor `wscat`.

```bash
# bouwen en starten
docker compose up -d --build

# controleren dat alles draait (redpanda-init hoort te eindigen met "Exited (0)")
docker compose ps -a

# logs
docker compose logs ws-microservice --tail 20
docker compose logs werkorder-api --tail 20
```

Open daarna **http://localhost/**. Zonder monteur in de adresbalk toont de app een keuzescherm.
Open de app als monteur via **http://localhost/?monteur=M-017**. De status rechtsboven moet groen worden ("Verbonden").

In de logs van de microservice zie je onder andere:

```
Succesvol verbonden met Redpanda/Kafka broker: redpanda:9092
Luisteren naar Kafka topic: 'werkorder-notificaties' (dead letter topic: 'werkorder-notificaties.dlq')...
```

## Testen

### De hele keten, in de browser (twee monteurs)

1. Open twee browservensters naast elkaar:
   - http://localhost/?monteur=M-017
   - http://localhost/?monteur=M-022

   Wacht tot beide "Verbonden" tonen.
2. Stuur meldingen. Elk bericht bevat het `monteurId` van de monteur voor wie het bedoeld is:

   ```bash
   docker exec -it redpanda rpk topic produce werkorder-notificaties -z none
   ```

   Typ per regel één bericht en sluit af met Enter. Stop met Ctrl+C.

   ```json
   {"werkorderId":"WO-1001","monteurId":"M-017","status":"OPEN","bericht":"Nieuwe storing toegewezen"}
   {"werkorderId":"WO-1002","monteurId":"M-017","status":"IN_BEHANDELING","bericht":"Monteur onderweg"}
   {"werkorderId":"WO-1003","monteurId":"M-022","status":"AFGEROND","bericht":"Inspectie afgerond"}
   ```

   Meerdere berichten in één keer sturen kan ook, zonder interactief commando:

   ```bash
   printf '%s\n' \
   '{"werkorderId":"WO-1001","monteurId":"M-017","status":"OPEN","bericht":"Nieuwe storing toegewezen"}' \
   '{"werkorderId":"WO-1003","monteurId":"M-022","status":"AFGEROND","bericht":"Inspectie afgerond"}' \
   | docker exec -i redpanda rpk topic produce werkorder-notificaties -z none
   ```

3. **M-017 ziet WO-1001 en WO-1002, M-022 ziet alleen WO-1003.** Een melding verschijnt met een blauwe stip
   (ongelezen). Klik erop: de app haalt de volledige werkorder op.

Aanvullende scenario's:

| Scenario | Bericht of actie | Verwacht resultaat |
|---|---|---|
| Werkorder bestaat niet | `{"werkorderId":"WO-9999","monteurId":"M-017","status":"OPEN","bericht":"Test"}` | melding komt aan, detail toont "Werkorder niet gevonden" |
| Status in melding wijkt af van de API | `WO-1002` met `"status":"AFGEROND"` | waarschuwing: de app toont de actuele status uit de API |
| Monteur is offline | bericht voor `M-099`, terwijl niemand als M-099 verbonden is | niemand ontvangt het nu, de service logt `Monteur M-099 is niet verbonden: melding bewaard voor inhalen` |
| Inhalen na offline | sluit het venster van M-017, stuur 2 berichten voor M-017, open `http://localhost/?monteur=M-017` opnieuw | de 2 berichten verschijnen alsnog, gemarkeerd met "ingehaald", zonder dubbelen |
| Nieuw apparaat | open M-017 in een privévenster (lege opslag) | de bewaarde meldingen van M-017 komen binnen als "ingehaald" |
| Zelfde monteur, twee vensters | open M-017 in twee vensters | beide vensters ontvangen de melding |
| WebSocket valt weg | `docker compose stop ws-microservice` | status wordt rood met aftelling, herstelt na `docker compose start ws-microservice` |

### Alleen de WebSocket

```bash
npx wscat -c "ws://localhost/ws?monteurId=M-017"
```

Je krijgt eerst een SYSTEM-bericht: `Verbonden met het Werkorder Notificatiesysteem als M-017`.

Gemiste meldingen opvragen kan met `since` (een ISO 8601-tijdstip in UTC). Alles wat de service bewaard heeft:

```bash
npx wscat -c "ws://localhost/ws?monteurId=M-017&since=1970-01-01T00:00:00.000Z"
```

Zonder geldig `monteurId` weigert de server de verbinding:

```bash
npx wscat -c ws://localhost/ws
# Disconnected (code: 1008, reason: "monteurId ontbreekt of is ongeldig")
```

### Alleen de API

De API is niet rechtstreeks bereikbaar vanaf de host, alleen via de gateway:

```bash
curl -i http://localhost/api/werkorders/WO-1002        # 200, volledige werkorder
curl -i http://localhost/api/werkorders/WO-9999        # 404, bestaat niet
curl -i http://localhost/api/werkorders/abc            # 400, ongeldig id
curl -i "http://localhost/api/werkorders?status=OPEN"  # 200, gefilterde lijst
```

### Ongeldige berichten en de dead letter topic

```
{"werkorderId":"WO-2001","monteurId":"M-017","status":"KAPOT","bericht":"verkeerde status"}
{"werkorderId":"WO-2002","status":"OPEN","bericht":"monteurId ontbreekt"}
dit is geen json
```

Er verschijnt niets in de app. De berichten staan in de dead letter topic:

```bash
docker exec -it redpanda rpk topic consume werkorder-notificaties.dlq -o start -n 3 \
  -f '%v\n  %h{  - %k = %v\n}\n'
```

Voorbeeld van de uitvoer:

```
{"werkorderId":"WO-2001","monteurId":"M-017","status":"KAPOT","bericht":"verkeerde status"}
  - dlq-reden = Validatie mislukt: status 'KAPOT' is ongeldig (toegestaan: OPEN, IN_BEHANDELING, AFGEROND)
  - dlq-bron-topic = werkorder-notificaties
  - dlq-bron-partitie = 0
  - dlq-bron-offset = 2
  - dlq-tijdstip = 2026-10-16T12:19:00.890Z
```

> `-z none` zet compressie uit. `rpk` gebruikt standaard Snappy, en de gebruikte kafkajs-bibliotheek kan dat
> zonder extra codec niet lezen (zie *Geleerde lessen*).

## Contracten

### Het event (Kafka)

Berichten op `werkorder-notificaties` zijn JSON-objecten. Het event is bewust **dun**: het zegt dat er iets is gebeurd
en voor wie, niet wat de hele werkorder bevat.

| Veld | Type | Verplicht | Regels |
|---|---|---|---|
| `werkorderId` | string | ja | niet leeg |
| `monteurId` | string | ja | `M-` gevolgd door cijfers; bepaalt naar wie de melding gaat |
| `status` | string (enum) | ja | `OPEN`, `IN_BEHANDELING` of `AFGEROND` |
| `bericht` | string | ja | niet leeg |

```json
{"werkorderId":"WO-1001","monteurId":"M-017","status":"OPEN","bericht":"Nieuwe storing toegewezen"}
```

> **Contractwijziging.** `monteurId` is later toegevoegd als verplicht veld, omdat de routering ervan afhangt. Een nieuw
> verplicht veld is een brekende wijziging: producers die het veld nog niet sturen, zien hun berichten in de dead letter
> topic belanden. In productie voeg je zo'n veld eerst optioneel toe, of versioneer je het contract.

### De WebSocket

| Onderdeel | Beschrijving |
|---|---|
| Adres | `ws://<gateway>/ws?monteurId=M-017&since=2026-10-16T14:03:22.123Z` |
| `monteurId` | verplicht, `M-` gevolgd door cijfers |
| `since` | optioneel, ISO 8601 in UTC (zoals `Date.toISOString()`). Zonder `since` komt er geen inhaal. Met `since` stuurt de server de bewaarde meldingen vanaf (en inclusief) dat tijdstip na. |
| Welkomstbericht | `{"type":"SYSTEM","message":"Verbonden ... als M-017"}` |
| Meldingen | de vier velden van het event, plus `eventId` (partitie en offset, bijvoorbeeld `0-42`) en `tijdstip` (ISO 8601, het moment waarop Kafka het bericht ontving). Ingehaalde meldingen hebben bovendien `"inhaal": true`. Extra velden van de producer worden niet doorgestuurd. |
| Weigering | ontbrekend of ongeldig `monteurId`, of een ongeldig `since`: de server sluit de verbinding met code `1008` en een reden |

De nieuwe velden `eventId`, `tijdstip` en `inhaal` zijn een toevoeging aan het contract en breken bestaande clients niet.

### De API (REST)

Het contract staat in [`werkorder-api/openapi.yaml`](werkorder-api/openapi.yaml).

| Verzoek | Resultaat |
|---|---|
| `GET /api/werkorders/{werkorderId}` | 200 met de volledige werkorder, 400 bij ongeldig id, 404 als hij niet bestaat |
| `GET /api/werkorders?status=OPEN&limit=10` | 200 met een compacte lijst, 400 bij een ongeldige status of limiet |
| `GET /health` | 200 `{"status":"UP"}` |

Alle fouten hebben dezelfde structuur (in de stijl van RFC 7807): `{"status":404,"title":"Not Found","detail":"..."}`.
De volledige werkorder bevat onder andere locatie, monteur, `taken[]` en `materiaal[]` (kardinaliteit 0..*; een lege lijst
betekent "geen", niet "onbekend"). Het detail wordt geleverd met `Cache-Control: no-store`.

De specificatie bekijken in Swagger UI:

```bash
docker run -p 8082:8080 -e SWAGGER_JSON=/spec/openapi.yaml -v "$PWD/werkorder-api:/spec" swaggerapi/swagger-ui
```

Open daarna http://localhost:8082.

> Voor de asynchrone kant (Kafka en WebSocket) is OpenAPI niet het juiste instrument. Daarvoor bestaat AsyncAPI.

## De monteur-app

`gateway/html/monteur-app.html` is één bestand met gewone JavaScript, zonder framework of buildstap. Het wordt door
nginx geserveerd en praat via dezelfde gateway met de WebSocket en de API (dezelfde herkomst, dus geen CORS nodig).

- **Identificatie:** de monteur staat in de adresbalk (`?monteur=M-017`). Zonder monteur toont de app een keuzescherm
  (demo-inlog). De link "wissel" in de kop brengt je daar terug. Dit is identificatie, geen authenticatie.
- **Meldingen:** alleen die voor deze monteur, nieuwste bovenaan (op het tijdstip van de melding), maximaal 50, met een
  stip voor ongelezen meldingen. Ingehaalde meldingen staan op de juiste plek en dragen de tekst "ingehaald".
- **Detail:** locatie met kaartlink, monteur, taken als checklist met teller, materiaal als tabel, en het tijdstip waarop
  de gegevens zijn opgehaald met een knop om te vernieuwen.
- **Actuele toestand:** wijkt de status in de melding af van die in de API, dan toont de app een waarschuwing. De API is de
  bron van waarheid, de melding is een signaal.
- **Verbinding:** automatisch herverbinden met oplopende wachttijd (1 tot 30 seconden) en een willekeurige vertraging,
  zodat niet alle monteurs na een herstart tegelijk terugkomen. Bij een weigering door de server (code 1008) probeert de
  app het niet opnieuw.
- **Lokaal bewaren:** de meldingenlijst (maximaal 50, inclusief gelezen/ongelezen) wordt per monteur in `localStorage`
  bewaard, zodat de lijst blijft staan na wisselen van monteur of herladen. Dit is een kopie in deze browser. Wat er
  gebeurde terwijl de app dicht was, haalt de app in bij het verbinden (zie "Inhalen van gemiste meldingen").
- **Inhalen:** bij elke verbinding stuurt de app `since` mee: het tijdstip van de nieuwste melding die hij heeft, of het
  begin der tijden als de lijst leeg is. Meldingen die hij al heeft, worden genegeerd (ontdubbeld op `eventId`).
- **Foutafhandeling:** time-out na 8 seconden, aparte meldingen voor 404 en een onbereikbare server, en een verouderd
  antwoord wordt genegeerd als je intussen een andere melding kiest.
- **Veilig:** alle data uit netwerk en API wordt als tekst getoond (`textContent`), nooit als HTML.
- **Mobiel en donker:** op een smal scherm tonen lijst en detail om beurten, en het kleurenschema volgt het apparaat.

## Gerichte levering en verbindingsbeheer

De notificatieservice houdt een register bij van wie waar verbonden is (`monteurId` naar een verzameling verbindingen).
Eén monteur kan meerdere verbindingen hebben, bijvoorbeeld telefoon en tablet.

1. De client verbindt met `/ws?monteurId=M-017`. Een ontbrekend of ongeldig id wordt geweigerd (code 1008).
2. De consumer leest een event, valideert het en zoekt de verbindingen van `event.monteurId` op.
3. De melding wordt eerst bewaard in de inhaalbuffer en gaat daarna alleen naar de verbindingen van die monteur. Is de
   monteur niet verbonden, dan wordt dat gelogd. De melding is dan niet kwijt: hij wordt nagestuurd zodra de monteur
   verbindt (zie hieronder).
4. Bij het sluiten van een verbinding verdwijnt die uit het register.

### Inhalen van gemiste meldingen

Een WebSocket levert alleen af aan wie op dat moment verbonden is. Voor een monteur zonder bereik, of met de app dicht,
bewaart de service daarom per monteur de laatste meldingen.

1. Elke geldige melding krijgt een `eventId` (partitie en offset) en een `tijdstip` (van Kafka) en gaat in de buffer van
   die monteur, ook als hij offline is.
2. De client verbindt met `?since=<tijdstip van zijn nieuwste melding>`.
3. De server registreert de verbinding en stuurt in dezelfde stap alle bewaarde meldingen vanaf dat tijdstip na
   (met `"inhaal": true`). Omdat Node dit zonder onderbreking uitvoert, kan er geen melding tussen het inhalen en het
   live ontvangen verloren gaan of dubbel komen.
4. De grens is inclusief: de laatste melding die de client al had, komt nog een keer mee en wordt in de app ontdubbeld.
   Dat is bewust: liever een dubbele melding die je herkent dan een gemiste.

| Instelling | Standaard | Betekenis |
|---|---|---|
| `INHAAL_MAX_PER_MONTEUR` | 100 | maximaal aantal bewaarde meldingen per monteur; de oudste vallen af |
| `INHAAL_MAX_LEEFTIJD_MS` | 86400000 (24 uur) | oudere meldingen worden niet nagestuurd en opgeruimd |
| `OPRUIM_MS` | 600000 (10 minuten) | hoe vaak verlopen meldingen worden opgeruimd |

**Beperkingen van deze eerste versie.** De buffer leeft in het geheugen van het proces: na een herstart van
`ws-microservice` is hij leeg. Bij meerdere instanties heeft elke instantie zijn eigen buffer. In productie hoort dit in
een gedeelde opslag (Redis, een database) of kan de service het gemiste stuk opnieuw uit Kafka lezen. Verder is het
tijdstip dat van de Kafka-broker; een klok die afwijkt of berichten die met een eigen (oud) tijdstip worden
geproduceerd, vragen om een volgnummer per monteur in plaats van een tijdstip.

**Heartbeat.** Elke 30 seconden (instelbaar met `HEARTBEAT_MS`) stuurt de server een ping. Een verbinding die niet
antwoordt voor de volgende ronde wordt afgesloten. Zonder dit blijven verbindingen van monteurs zonder bereik in het
register staan, omdat TCP een weggevallen verbinding vaak pas na minuten merkt.

## Foutafhandeling in de notificatieservice

De consumer mag nooit crashen op één slecht bericht (een *poison message*). Elk bericht doorloopt daarom drie
controles. Bij een fout wordt het bericht ongewijzigd naar `werkorder-notificaties.dlq` gestuurd en gaat de consumer
door met het volgende bericht.

| Controle | Voorbeeld | Reden in de DLQ |
|---|---|---|
| Leeg bericht | lege regel in `rpk` | `Leeg bericht` |
| Geldige JSON | `dit is geen json` | `Ongeldige JSON: ...` |
| Voldoet aan het contract | `status` is `KAPOT`, of `monteurId` ontbreekt | `Validatie mislukt: ...` |

Elk DLQ-bericht krijgt headers mee zodat je het bronbericht altijd kunt terugvinden:

| Header | Inhoud |
|---|---|
| `dlq-reden` | waarom het bericht is afgewezen |
| `dlq-bron-topic` | oorspronkelijk topic |
| `dlq-bron-partitie` | oorspronkelijke partitie |
| `dlq-bron-offset` | oorspronkelijke offset |
| `dlq-tijdstip` | tijdstip van afwijzing (UTC) |

Een geldig bericht voor een monteur die niet verbonden is, gaat **niet** naar de DLQ. Het bericht is correct, de
ontvanger is alleen niet bereikbaar. Dat is een ander probleem dan een kapot bericht.

Daarnaast:
- Een crash van de consumer die kafkajs niet zelf kan herstellen, stopt het proces (`process.exit(1)`). Met
  `restart: unless-stopped` in Compose start de container daarna opnieuw.
- Als het versturen naar de DLQ zelf mislukt, wordt dat gelogd. Het bericht gaat dan verloren. Voor productie zou je
  hier juist willen stoppen of opnieuw proberen.

## Belangrijke ontwerpkeuzes

**Dun event, synchroon detail.** De notificatie is asynchroon en gericht (wie moet weten dat er iets is). Het detail
is synchroon (de monteur vraagt het op wanneer hij het nodig heeft). Dat houdt het event klein, voorkomt dat gegevens
op de bus verouderen en laat de API per verzoek bepalen wie wat mag zien. Het is het alternatief voor
*event-carried state transfer*, waarbij het event alle gegevens bevat.

**Contract-first.** De API is beschreven in OpenAPI. Het `status`-enum is hetzelfde als in het berichtcontract. Een
contracttest kan controleren of elk antwoord van de API voldoet aan de specificatie.

**Routeren op een veld in het bericht.** De service beslist niet *wat* er in een werkorder gebeurt, alleen *wie* de
melding krijgt. De waarheid blijft in het bronsysteem en de API. Zo blijft de notificatielaag dun.

**Redpanda: listen- en advertise-adressen.** Een Kafka-broker vertelt clients waar ze zich opnieuw moeten
verbinden (het *advertise*-adres). Daarom zijn er twee listeners:
`internal://redpanda:9092` voor containers op het Docker-netwerk en `external://localhost:19092` voor clients op de host.
Een client in een container die `localhost` terugkrijgt, verbindt anders met zichzelf.

**Idempotente topic-aanmaak.** De init-container controleert eerst met `rpk topic describe` of een topic bestaat en
maakt het anders aan. Daardoor geeft herhaald `docker compose up -d` geen foutmelding.

**nginx als gateway.** Er zijn twee upstreams: `websocket_backend` en `werkorder_backend`. Voor WebSocket zijn
`proxy_http_version 1.1` en de headers `Upgrade` en `Connection` nodig, en `proxy_read_timeout` is hoog gezet zodat
langlopende verbindingen niet worden afgebroken. De querystring (`?monteurId=...`) wordt doorgegeven aan de
microservice. Bij `location /api/` staat bewust geen `/` achter de naam van de upstream, zodat het volledige pad
(`/api/werkorders/WO-1002`) ongewijzigd bij de API aankomt.

**Consumer group.** `monteur-notificatie-group` verdeelt de partities over instanties. Met één instantie werkt de
gerichte levering volledig. Met meerdere instanties niet (zie het volgende hoofdstuk).

## Van PoC naar productie

Dit project is een proof-of-concept. Bij duizenden monteurs komen er andere vragen bij.

| Onderwerp | Waarom het uitmaakt |
|---|---|
| **Authenticatie** | Het `monteurId` in de URL is nu alleen een claim: iedereen kan zich als iedereen voordoen, en de API controleert niet of een werkorder bij de aanvrager hoort. In productie: een token (bijvoorbeeld JWT) bij het verbinden en bij API-verzoeken, en een manier om verbindingen te sluiten als rechten veranderen. |
| **Meerdere instanties** | In één consumer group krijgt één instantie elk bericht, dus een monteur die op een andere instantie verbonden is, mist het. Oplossingen: een eigen consumer group per instantie, een pub/sub-laag (Redis, NATS) of een beheerde dienst (Azure Web PubSub, SignalR). |
| **Inhalen na offline** | Hier opgelost met een buffer in het geheugen en `?since=`. In productie moet die buffer gedeeld en duurzaam zijn (Redis, database of opnieuw lezen uit Kafka), en hoort er een volgnummer per monteur in plaats van een tijdstip. |
| **Reconnect-storm** | Na een herstart of uitrol verbinden alle clients tegelijk opnieuw. Wachttijd met willekeurige vertraging (de app doet dit al) en gecontroleerd afbouwen van verbindingen bij het uitrollen helpen. |
| **Capaciteit** | Elke verbinding kost geheugen en een bestandsdescriptor. nginx (`worker_connections`) en de service moeten daarop zijn afgesteld, en `limit_req` per IP kan knellen als veel monteurs achter dezelfde mobiele provider zitten. |
| **Kanaal** | WebSocket is tweerichtingsverkeer. Voor alleen ontvangen is SSE eenvoudiger (met `Last-Event-ID` om in te halen). Voor een mobiele app in het veld zijn push-notificaties (FCM/APNs) of MQTT geschikter. |

Kafka is een backbone voor service-naar-service-verkeer. Je laat er geen duizenden eindgebruikers op aansluiten
(één consumer per monteur is een anti-patroon). Tussen Kafka en de monteur hoort een aparte laag (notification service of
push gateway) die per gebruiker routeert, verbindingen beheert en berichten opvangt voor wie offline is. De
`ws-microservice` is daar de eenvoudige eerste versie van.

## Geleerde lessen (troubleshooting)

| Symptoom | Oorzaak | Oplossing |
|---|---|---|
| `host not found in upstream` in nginx | een upstream-service (microservice of API) draait niet of crasht bij het opstarten | de service repareren, dan de gateway herstarten. Laat `api-gateway` via `depends_on` wachten op beide backends. |
| 502 Bad Gateway na herbouwen | nginx onthoudt het IP-adres van een upstream bij het opstarten | `docker compose restart api-gateway` |
| Wijziging in `nginx.conf` werkt niet of de gateway start niet | syntaxfout in de configuratie | `docker compose exec api-gateway nginx -t` voor herstarten |
| `Snappy compression not implemented`, consumer stopt | `rpk` comprimeert standaard met Snappy, kafkajs kent alleen gzip | produceer met `-z none`, of voeg een Snappy-codec toe (`kafkajs-snappy`) |
| Consumer blijft hetzelfde bericht opnieuw crashen | het bericht is niet als gelezen gemarkeerd | service stoppen, `rpk group seek monteur-notificatie-group --to end --topics werkorder-notificaties`, daarna starten |
| Consumer crasht op `message.value.toString()` | bericht zonder inhoud (`null`) | controle op lege waarde vóór verwerken |
| Melding komt niet aan in de app | het `monteurId` in het bericht komt niet overeen met de monteur in de app, of die is niet verbonden | controleer `monteurId` in het bericht en in `?monteur=` en lees de log: `Monteur M-017 is niet verbonden` |
| Berichten verdwijnen naar de DLQ na de overstap op gerichte levering | de producer stuurt het verplichte veld `monteurId` nog niet mee | `monteurId` toevoegen aan het bericht, of het veld eerst optioneel maken |
| `Verbinding geweigerd` in de app | ontbrekend of ongeldig `monteurId` in de WebSocket-URL | gebruik `?monteur=M-017` (`M-` gevolgd door cijfers) |
| Melding komt aan, detail zegt "Werkorder niet gevonden" | het id staat niet in de voorbeelddata (alleen WO-1001 t/m WO-1003) | gebruik een bestaand id, of voeg de werkorder toe in `werkorder-api/server.js` |
| Meldingen zijn weg na wisselen van monteur of herladen | de lijst stond alleen in het geheugen van de pagina (oudere versie van de app) | gebruik de huidige `monteur-app.html`: die bewaart de lijst in `localStorage` en haalt gemiste meldingen in |
| Na herstart van `ws-microservice` komen oude meldingen niet terug | de inhaalbuffer leeft in het geheugen | bekende beperking, zie "Inhalen van gemiste meldingen" |
| `Verbinding geweigerd: since is ongeldig` | `since` is geen ISO 8601-tijdstip in UTC | gebruik bijvoorbeeld `2026-10-16T14:03:22.123Z` |
| Twee regels aan elkaar in `rpk` | meerdere regels tegelijk geplakt in het interactieve commando | één regel tegelijk plakken, of `printf ... \| docker exec -i ...` gebruiken |

## Mogelijke vervolgstappen

- De inhaalbuffer duurzaam en gedeeld maken (Redis of database), met een volgnummer per monteur in plaats van een tijdstip.
- Authenticatie met een token, gevalideerd in de gateway, en controle in de API of de werkorder bij de monteur hoort.
- Meerdere instanties van de notificatieservice (de consumer-group-kwestie).
- Berichten uit de DLQ na herstel opnieuw aanbieden aan het hoofdtopic (replay).
- Het berichtcontract vastleggen in een AsyncAPI-specificatie en een JSON Schema, afgedwongen via de schema registry
  (Redpanda levert er een mee).
- De contracttest voor de API opnemen in de repo, zodat een afwijking van `openapi.yaml` meteen opvalt.
- Echte databron achter de API in plaats van voorbeelddata in het geheugen.
- Monitoring en alarmering op het aantal DLQ-berichten, het aantal verbonden monteurs en de consumer lag.
- Een Snappy- of LZ4-codec toevoegen zodat de consumer ook gecomprimeerde berichten van andere producers leest.

## Opruimen

```bash
docker compose down        # containers stoppen en verwijderen
docker compose down -v     # ook het datavolume met de topics verwijderen
```
