# Event-driven architecture: werkorder-notificaties

Een lokale proof-of-concept van een event-driven architectuur met twee kanten:

1. **Asynchroon:** een werkorder-event gaat via Kafka (Redpanda) naar een Node.js-microservice, die het in real time
   als melding doorstuurt naar de juiste monteur via WebSocket.
2. **Synchroon:** de monteur opent een melding en haalt via een REST-API de volledige werkorder op.

Beide kanten zijn beveiligd met **OpenID Connect (Keycloak)**: de monteur logt in, en zowel de WebSocket als de API
controleren het token en laten een monteur alleen zijn eigen meldingen en werkorders zien.

Dit is het patroon *event notification + ophalen* (dun event, synchroon detail). Het project laat verder zien hoe je in
een event-driven omgeving omgaat met contracten, validatie, gerichte levering en foutafhandeling (poison messages,
dead letter topic).

> **In uitbreiding:** de keten krijgt een taakgerichte broker (Apache ActiveMQ Artemis), een bronapp met een eigen interface,
> twee adapters en een canoniek EAM-datamodel. Zie [`docs/architectuur-review.md`](docs/architectuur-review.md) voor de review en het
> doelontwerp, [`contracts/`](contracts/README.md) voor de schema's, [`bron-app/`](bron-app/server.js) voor de bronapp en
> [`artemis/`](artemis/README.md) voor de broker. `producer.js` (kapot) is verwijderd; de bron-app vervangt hem.
> Test de keten met `./scripts/smoketest.sh` (of `--volledig` voor uitval- en herstelscenario's).

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
| **keycloak** | Identity provider (OpenID Connect): inloggen, uitgifte van tokens, publieke sleutels om ze te controleren |
| **api-gateway** | nginx: serveert de monteur-app, proxyt `/ws` naar de microservice en `/api/` naar de werkorder-API |
| **monteur-app** | Webpagina (`gateway/html/monteur-app.html`): inloggen, meldingen ontvangen en werkorder bekijken |

## Projectstructuur

```
event-driven-architecture/
├── docker-compose.yml          # Redpanda, init-container, Keycloak, microservice, werkorder-api, gateway
├── keycloak/
│   ├── werkorders-realm.json   # realm, clients en demo-gebruikers (wordt bij de start ingelezen)
│   └── compose-snippet.yml     # het keycloak-service-blok voor docker-compose.yml
├── gateway/
│   ├── nginx.conf              # twee upstreams, WebSocket-proxy, API-proxy, rate limiting
│   └── html/
│       └── monteur-app.html    # de monteur-webapp (één bestand, geen framework)
├── microservice/               # notificatieservice
│   ├── Dockerfile
│   ├── package.json
│   └── server.js               # tokencontrole, consumer, validatie, gerichte levering, heartbeat, dead letter topic
├── werkorder-api/              # synchrone API
│   ├── Dockerfile
│   ├── package.json
│   ├── server.js, db.js, ...   # REST-endpoints, SQLite-opslag, interne PUT, outbox-relay (zie werkorder-api/README.md)
│   └── openapi.yaml            # het contract van de API
├── k8s/                        # Kubernetes-manifests voor AKS
│   ├── 00-namespace.yaml ... 60-keycloak.yaml   # incl. 15-artemis, 42/43 adapters, 44 bron-app
│   ├── gateway/nginx.conf      # nginx-configuratie voor in het cluster
│   ├── optioneel-publiek.yaml  # optioneel: openbaar IP-adres, beperkt tot jouw IP
│   └── deploy.sh               # bouwt de images in ACR en zet alles in het cluster
└── README.md
```

## Snel starten

Vereist: Docker Desktop (met `docker compose`). Node.js is lokaal alleen nodig voor `wscat`.

**Eenmalig:** voeg het Keycloak-blok toe aan `docker-compose.yml`. Plak de inhoud van
[`keycloak/compose-snippet.yml`](keycloak/compose-snippet.yml) onder `services:` (let op de inspringing: `keycloak:` staat op
dezelfde hoogte als `redpanda:`). Een Mac met 8 GB heeft hier ruimte voor: Keycloak is begrensd op 1 GB.

**Eerst de geheimen en certificaten klaarzetten** (wachtwoorden staan niet in `.env` of in git; zie [Geheimen en TLS](#geheimen-en-tls)):

```bash
cp .env.example .env              # alleen instellingen, geen wachtwoorden
./scripts/kluis.sh klaarzetten    # kluis starten en vullen, geheimen naar secrets/, TLS-certificaten maken
```

```bash
# bouwen en starten
docker compose up -d --build

# controleren dat alles draait (redpanda-init hoort te eindigen met "Exited (0)")
docker compose ps -a

# logs
docker compose logs ws-microservice --tail 20
docker compose logs werkorder-api --tail 20
```

Keycloak heeft 30 tot 60 seconden nodig om te starten (de eerste keer langer). Volg het met
`docker compose logs keycloak --tail 5`; klaar is het bij een regel met `Listening on: http://0.0.0.0:8080`.

Open daarna **http://localhost/**. De app stuurt je naar Keycloak. Log in met een van de demo-monteurs:

| Gebruiker | Wachtwoord | Wordt in de app |
|---|---|---|
| `m-017` | `welkom017` | monteur **M-017** (J. de Vries) |
| `m-022` | `welkom022` | monteur **M-022** (S. Jansen) |

De status rechtsboven moet groen worden ("Verbonden"). De beheerconsole van Keycloak staat op http://localhost:8180
(gebruiker `admin`; het wachtwoord staat in `secrets/keycloak_admin_password`; alleen bereikbaar vanaf je eigen computer).

In de logs van de microservice zie je onder andere:

```
Succesvol verbonden met Redpanda/Kafka broker: redpanda:9092
Luisteren naar Kafka topic: 'werkorder-notificaties' (dead letter topic: 'werkorder-notificaties.dlq')...
```

## Geheimen en TLS

Twee productie-aanvullingen op de taakgerichte keten: de verbinding met de broker is versleuteld en geverifieerd, en wachtwoorden komen uit een kluis in plaats van uit `.env`.

### TLS op de Artemis-acceptor

| Onderdeel | Keuze |
|---|---|
| Acceptor | `sslEnabled=true`, alleen TLS 1.2 en 1.3, op poort 61616 voor CORE en AMQP. Een verbinding zonder TLS komt niet door de handdruk, dus er gaat ook geen wachtwoord onversleuteld over de lijn. |
| Servercertificaat | Een PKCS12-keystore (`secrets/tls/broker.p12`) die `scripts/maak-certs.sh` uitgeeft met een lokale CA. Geldig voor `artemis`, `localhost`, `127.0.0.1` en de k8s-namen `artemis.werkorder.svc[.cluster.local]`. |
| Keystore-wachtwoord | Uit de kluis. `artemis/init-users.sh` vult het in op de plaatshouder `@KEYSTORE_PASSWORD@` in `broker.xml`, zodat het niet in git staat. |
| Clients | De adapters vertrouwen alleen de eigen CA (`BROKER_TLS_CA`) en controleren certificaatketen én hostnaam. Er is bewust geen schakelaar om de controle uit te zetten. |
| Authenticatie | Geen clientcertificaten (mTLS): de adapters loggen in met eigen gebruikersnaam en wachtwoord, per adapter beperkte rechten. Dat blijft veilig omdat de verbinding versleuteld is; mTLS is een mogelijke vervolgstap. |
| Console | `http://localhost:8161` blijft gewoon HTTP, maar is alleen vanaf deze computer bereikbaar. |

### Geheimen uit een kluis

Het pad van een geheim: **kluis → bestand → `/run/secrets/<naam>` in de container → `NAAM_FILE` in de applicatie**.

| Geheim | Gebruikt door | In de applicatie |
|---|---|---|
| `artemis_admin_password`, `artemis_source_password`, `artemis_target_password` | `artemis-init` (schrijft de gebruikers), de adapters | `ADMIN_PASSWORD_FILE`, `BROKER_PASSWORD_FILE` |
| `artemis_keystore_password` | `artemis-init`, `maak-certs.sh` | `KEYSTORE_PASSWORD_FILE` |
| `target_adapter_client_secret` | Keycloak (realm-import), target-adapter | `OIDC_CLIENT_SECRET_FILE` |
| `keycloak_admin_password` | Keycloak | opstartscript in `docker-compose.yml` |

- **Conventie.** `NAAM_FILE=<pad>` gaat voor `NAAM=<waarde>` (zoals in de officiële Postgres- en MySQL-images). Een ontbrekend of leeg bestand is een duidelijke fout bij het opstarten, geen stille terugval op een standaardwachtwoord.
- **Waarom bestanden en geen omgevingsvariabelen.** Een omgevingsvariabele staat in `docker inspect`, in `/proc/<pid>/environ` en komt makkelijk in een crashdump of log terecht. Een bestand onder `/run/secrets` niet. De rooktest controleert dat geen enkel geheim in `docker inspect` van de containers staat.
- **Lokale kluis.** `./scripts/kluis.sh` start HashiCorp Vault (Compose-profiel `kluis`), initialiseert en ontgrendelt hem, maakt ontbrekende geheimen willekeurig aan (48 hex-tekens) en rolt ze uit met een kortlevend leestoken dat alleen mag lezen (beleid `werkorder-lezer`). De rest van de omgeving draait ook zonder dat Vault aan staat. Na een herstart van de kluis: `./scripts/kluis.sh ontgrendel`.
- **Op AKS.** `k8s/70-secrets-keyvault.yaml` haalt dezelfde geheimen uit Azure Key Vault met de Secrets Store CSI-driver en een workload identity (zie het bestand voor de stappen). De applicaties merken niets: ze lezen dezelfde bestanden of dezelfde Kubernetes-Secrets. **Niet op een cluster getest.**
- **Bestaande omgeving.** Verwijder de wachtwoorden uit je oude `.env`; ze worden niet meer gelezen. Omdat Artemis zijn configuratie alleen bij het aanmaken van het volume leest, werkt een eerste keer overstappen met `docker compose down -v`.

Beperkingen van de lokale opzet (bewust, zie ook "Van PoC naar productie"): de unseal-sleutel en het root-token staan in `secrets/.vault-init.json` (één sleutel, geen sleutelhouders), Vault luistert zonder TLS op `127.0.0.1`, de geheime bestanden zijn leesbaar (644) omdat Docker ze met de rechten van de host monteert en de containers als niet-root draaien (de map `secrets/` is 700), en een wachtwoord roteren vraagt om het Artemis-volume opnieuw aan te maken omdat de gebruikers daar bij het aanmaken worden vastgelegd.

## Testen

### De hele keten, in de browser (twee monteurs)

1. Open twee **verschillende** browsers, of één gewoon venster en één privévenster (inloggen is per browser: dezelfde
   browser blijft ingelogd als dezelfde gebruiker). Open `http://localhost/` en log in als `m-017` in de ene en als
   `m-022` in de andere. Wacht tot beide "Verbonden" tonen.
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
| Inhalen na offline | sluit het venster van M-017, stuur 2 berichten voor M-017, open `http://localhost/` opnieuw | de 2 berichten verschijnen alsnog, gemarkeerd met "ingehaald", zonder dubbelen |
| Nieuw apparaat | log in als M-017 in een privévenster (lege opslag) | de bewaarde meldingen van M-017 komen binnen als "ingehaald" |
| Zelfde monteur, twee vensters | log in als M-017 in twee vensters | beide vensters ontvangen de melding |
| Uitloggen | klik op "Uitloggen" | je komt terug op het inlogscherm van Keycloak, en de lokaal bewaarde meldingen van die monteur zijn gewist |
| Token verloopt | wacht ruim 5 minuten (levensduur van het token) | de app ververst het token zelf en verbindt opnieuw; je merkt er niets van, en er gaat geen melding verloren |
| WebSocket valt weg | `docker compose stop ws-microservice` | status wordt rood met aftelling, herstelt na `docker compose start ws-microservice` |

### Een token ophalen voor de testen op de command line

Voor `curl` en `wscat` heb je zelf een token nodig. Daarvoor is in het realm een aparte testclient (`werkorders-test`)
met de *password grant* ingesteld. Dat is alleen voor deze demo: die flow is verouderd en hoort in productie uit.

```bash
token() {   # gebruik: token m-017 welkom017
  curl -s -d client_id=werkorders-test -d grant_type=password -d "username=$1" -d "password=$2" \
    http://localhost:8180/realms/werkorders/protocol/openid-connect/token \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])'
}
T17=$(token m-017 welkom017)
T22=$(token m-022 welkom022)
```

Een token is 5 minuten geldig. Haal er daarna een nieuw op. Hij is te inspecteren met
`echo $T17 | cut -d. -f2 | base64 -d 2>/dev/null` (let op: dit is gewoon leesbare JSON, geen geheim voor de drager).

### Alleen de WebSocket

De monteur komt uit het token, niet uit de URL. Het eerste bericht na het verbinden moet het token bevatten:

```bash
npx wscat -c "ws://localhost/ws"
# typ daarna (met je eigen token erin):
{"type":"AUTH","token":"<plak T17 hier>"}
```

Je krijgt eerst een SYSTEM-bericht: `Verbonden met het Werkorder Notificatiesysteem als M-017`.

Gemiste meldingen opvragen kan met `since` (een ISO 8601-tijdstip in UTC). Alles wat de service bewaard heeft:

```bash
npx wscat -c "ws://localhost/ws?since=1970-01-01T00:00:00.000Z"
```

Wat de server weigert, sluit hij met een code. De reden staat bewust niet in het antwoord, maar in de log van de service:

| Je doet | Resultaat |
|---|---|
| geen AUTH-bericht binnen 5 seconden | sluiting met code `1008` |
| een ander eerste bericht dan AUTH, of een ongeldig/verlopen/vervalst token | sluiting met code `1008` |
| Keycloak is op dat moment niet bereikbaar en de sleutels zijn nog niet bekend | sluiting met code `1013` (probeer later opnieuw) |
| het token verloopt terwijl je verbonden bent | sluiting met code `4401`; de app ververst en verbindt opnieuw |

### Alleen de API

De API is niet rechtstreeks bereikbaar vanaf de host, alleen via de gateway. Elk verzoek onder `/api/` heeft een token nodig:

```bash
curl -i http://localhost/api/werkorders/WO-1002                                    # 401, geen token
curl -i -H "Authorization: Bearer $T17" http://localhost/api/werkorders/WO-1002    # 200, eigen werkorder
curl -i -H "Authorization: Bearer $T17" http://localhost/api/werkorders/WO-1003    # 403, werkorder van M-022
curl -i -H "Authorization: Bearer $T17" http://localhost/api/werkorders/WO-9999    # 404, bestaat niet
curl -i -H "Authorization: Bearer $T17" http://localhost/api/werkorders/abc        # 400, ongeldig id
curl -i -H "Authorization: Bearer $T17" "http://localhost/api/werkorders?status=OPEN"  # alleen jouw werkorders
curl -i http://localhost/health                                                    # 200, zonder token
```

De tweede en derde regel zijn de kern van de eigenaarscheck: dezelfde aanvrager, twee werkorders, en alleen die van
hemzelf komt terug. Met `$T22` is het precies andersom.

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
| Adres | `ws://<gateway>/ws?since=2026-10-16T14:03:22.123Z` |
| Eerste bericht | binnen 5 seconden `{"type":"AUTH","token":"<access token>"}`. Het token staat bewust niet in de URL, want URL's komen terecht in logs van proxies en gateways. |
| Identiteit | de monteur komt uitsluitend uit het token (`M-017`), nooit uit de URL of een bericht van de client |
| `since` | optioneel, ISO 8601 in UTC (zoals `Date.toISOString()`). Zonder `since` komt er geen inhaal. Met `since` stuurt de server de bewaarde meldingen vanaf (en inclusief) dat tijdstip na. |
| Welkomstbericht | `{"type":"SYSTEM","message":"Verbonden ... als M-017"}`, pas nadat het token is geaccepteerd |
| Meldingen | de vier velden van het event, plus `eventId` (partitie en offset, bijvoorbeeld `0-42`) en `tijdstip` (ISO 8601, het moment waarop Kafka het bericht ontving). Ingehaalde meldingen hebben bovendien `"inhaal": true`. Extra velden van de producer worden niet doorgestuurd. |
| Sluitcodes | `1008` geen of ongeldig token, of een ongeldig `since` (reden alleen in de serverlog); `1013` Keycloak onbereikbaar, probeer later; `4401` token verlopen, ververs en verbind opnieuw; `1009` bericht te groot (maximaal 16 KiB) |

De nieuwe velden `eventId`, `tijdstip` en `inhaal` zijn een toevoeging aan het contract en breken bestaande clients niet.

### De API (REST)

Het contract staat in [`werkorder-api/openapi.yaml`](werkorder-api/openapi.yaml).

| Verzoek | Resultaat |
|---|---|
| `GET /api/werkorders/{werkorderId}` | 200 met de volledige werkorder, 400 bij ongeldig id, 404 als hij niet bestaat, **403 als hij bij een andere monteur hoort** |
| `GET /api/werkorders?status=OPEN&limit=10` | 200 met een compacte lijst van **jouw** werkorders, 400 bij een ongeldige status of limiet |
| `GET /health` | 200 `{"status":"UP"}`, zonder token |

Alles onder `/api/` vereist `Authorization: Bearer <access token>`. Zonder of met een ongeldig token volgt `401` (met een
`WWW-Authenticate`-header); is Keycloak niet bereikbaar en kan het token niet worden gecontroleerd, dan volgt `503` met
`Retry-After`. Het onderscheid is bewust: "je bent niet ingelogd" en "ik kan het nu niet nagaan" vragen een
andere reactie van de client.

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

- **Inloggen:** de app stuurt je naar Keycloak (zie "Authenticatie en autorisatie") en weet na terugkeer wie je bent uit
  het token. Er is geen keuzescherm meer en `?monteur=` heeft geen effect. De knop "Uitloggen" beëindigt ook de sessie bij Keycloak.
- **Meldingen:** alleen die voor deze monteur, nieuwste bovenaan (op het tijdstip van de melding), maximaal 50, met een
  stip voor ongelezen meldingen. Ingehaalde meldingen staan op de juiste plek en dragen de tekst "ingehaald".
- **Detail:** locatie met kaartlink, monteur, taken als checklist met teller, materiaal als tabel, en het tijdstip waarop
  de gegevens zijn opgehaald met een knop om te vernieuwen.
- **Actuele toestand:** wijkt de status in de melding af van die in de API, dan toont de app een waarschuwing. De API is de
  bron van waarheid, de melding is een signaal.
- **Verbinding:** automatisch herverbinden met oplopende wachttijd (1 tot 30 seconden) en een willekeurige vertraging,
  zodat niet alle monteurs na een herstart tegelijk terugkomen. Bij een weigering door de server (code 1008) probeert de
  app het niet opnieuw maar toont "Verbinding geweigerd" met een knop om opnieuw in te loggen. Een verlopen token (code
  4401) ververst de app zelf en verbindt daarna opnieuw.
- **Lokaal bewaren:** de meldingenlijst (maximaal 50, inclusief gelezen/ongelezen) wordt per monteur in `localStorage`
  bewaard, zodat de lijst blijft staan na herladen. Uitloggen wist de lijst van die monteur, zodat de volgende gebruiker van
  hetzelfde apparaat niets te zien krijgt. Dit is een kopie in deze browser. Wat er
  gebeurde terwijl de app dicht was, haalt de app in bij het verbinden (zie "Inhalen van gemiste meldingen").
- **Inhalen:** bij elke verbinding stuurt de app `since` mee: het tijdstip van de nieuwste melding die hij heeft, of het
  begin der tijden als de lijst leeg is. Meldingen die hij al heeft, worden genegeerd (ontdubbeld op `eventId`).
- **Foutafhandeling:** time-out na 8 seconden, aparte meldingen voor 404 ("niet gevonden"), 403 ("geen toegang", zonder
  knop om opnieuw te proberen), 401 (met "Opnieuw inloggen") en een onbereikbare server, en een verouderd
  antwoord wordt genegeerd als je intussen een andere melding kiest.
- **Veilig:** alle data uit netwerk en API wordt als tekst getoond (`textContent`), nooit als HTML.
- **Mobiel en donker:** op een smal scherm tonen lijst en detail om beurten, en het kleurenschema volgt het apparaat.

## Authenticatie en autorisatie

Voorheen was het `monteurId` in de URL een claim zonder bewijs: iedereen kon zich als iedereen voordoen, en de API
controleerde niet of een werkorder bij de aanvrager hoort. Dat is een klassieke kwetsbaarheid, *Broken Object Level
Authorization* (BOLA/IDOR, nummer 1 in de OWASP API Security Top 10). Het gat zat niet bij het inloggen maar bij de
controle op het object. Daarom zijn er nu twee losse stappen:

- **Authenticatie, wie ben je?** Dit regelt Keycloak. De services vertrouwen een token alleen na controle van de handtekening.
- **Autorisatie, mag je dit?** Dit regelt elke service zelf, per object: een geldig token voor M-017 geeft geen toegang tot
  de werkorder van M-022.

### De login (authorization code met PKCE)

```
 Browser (monteur-app)                         Keycloak                     Services
        │  1. stuurt je naar Keycloak (code_challenge, state)  │
        │ ───────────────────────────────────────────────────► │
        │  2. jij logt in; Keycloak stuurt terug met een code  │
        │ ◄─────────────────────────────────────────────────── │
        │  3. code + code_verifier inwisselen voor tokens      │
        │ ───────────────────────────────────────────────────► │
        │ ◄──────────────── access token (5 min) ───────────── │
        │  4. API: Authorization: Bearer <token> ──────────────────────────────►│ controleert zelf
        │     WebSocket: eerste bericht {"type":"AUTH",...} ───────────────────►│ de handtekening
```

De app is een *public client*: een webpagina kan geen geheim bewaren. PKCE (S256) beschermt daarom de code die
onderweg is. Het token staat alleen in het geheugen van de pagina, niet in `localStorage` en niet in de URL.

### Wat de services controleren

Beide services valideren het token zelf, zonder bij elk verzoek naar Keycloak te bellen. Ze halen eenmalig de publieke
sleutels op (JWKS) en controleren daarmee de handtekening:

| Controle | Waarom |
|---|---|
| algoritme is `RS256` | voorkomt het aanvalspatroon "alg: none" en het omdraaien naar een symmetrisch algoritme |
| `kid` verwijst naar een bekende sleutel | alleen sleutels van deze Keycloak |
| handtekening klopt | het token is niet aangepast |
| `iss` is exact het verwachte adres | het token komt van deze Keycloak en dit realm |
| `aud` bevat `werkorders-api` | het token is voor deze diensten bedoeld, niet voor een andere app |
| `exp` en `nbf` (5 seconden speling) | niet verlopen en niet te vroeg |
| `preferred_username` is `m-` + cijfers | daaruit komt het monteurId, in hoofdletters (`m-017` wordt `M-017`) |

De sleutels staan 10 minuten in het geheugen. Kent de service een `kid` niet (Keycloak heeft de sleutel gewisseld), dan
haalt hij ze opnieuw op, hooguit één keer per 30 seconden. Is Keycloak tijdelijk weg, dan blijven de bekende sleutels
werken: een storing van de identity provider legt zo niet meteen alle ingelogde monteurs stil.

### Autorisatie in de API

- De lijst bevat alleen werkorders van de ingelogde monteur.
- Het detail van een werkorder van een ander geeft `403`; een werkorder die niet bestaat geeft `404`. De logregel
  vermeldt wie wat probeerde (`Toegang geweigerd: M-017 vroeg WO-1003 op (eigenaar: M-022)`), het antwoord noemt de eigenaar niet.
- **Afweging:** doordat `404` en `403` verschillen, kan iemand nagaan welke id's bestaan (*enumeratie*). Hier is dat
  acceptabel, omdat de id's toch in de meldingen staan. Bij gevoeliger gegevens antwoord je voor "niet van jou" ook
  `404`, dan geef je niets prijs.
- Antwoorden gaan met `Cache-Control: no-store`, zodat een gedeelde proxy of browsercache ze niet bewaart.

### De inrichting in Keycloak

Het realm `werkorders` wordt bij de start ingelezen uit [`keycloak/werkorders-realm.json`](keycloak/werkorders-realm.json):

| Onderdeel | Waarde |
|---|---|
| Client `monteur-app` | public, alleen *authorization code flow* met PKCE, doorverwijzing alleen naar `http://localhost/*` en `http://localhost:8080/*` |
| Client `werkorders-test` | alleen voor de demo (password grant), zie "Testen" |
| Audience mapper | zet `werkorders-api` in `aud` van elk token |
| Levensduur access token | 5 minuten |
| SSO-sessie | 30 minuten inactief, 10 uur maximaal |
| Gebruikers | `m-017` en `m-022` (wachtwoorden in de tabel bij "Snel starten") |

Keycloak slaat gebruikersnamen in kleine letters op, vandaar `m-017`. De services zetten dat om naar `M-017`. Een extra
attribuut met het monteurId zou netter zijn, maar vraagt in recente Keycloak-versies extra instelling van het gebruikersprofiel.
Voor een PoC is `preferred_username` genoeg.

> **Een wijziging in het realm-bestand werkt pas na het opnieuw aanmaken van Keycloak:**
> `docker compose up -d --force-recreate keycloak`. De import slaat een bestaand realm over.

### Het adres van Keycloak (`iss`)

Dit is de lastigste kant van OIDC en de meest waarschijnlijke bron van problemen. Het token bevat het adres waarmee de
**browser** bij Keycloak kwam (`http://localhost:8180/realms/werkorders`), en de services controleren exact dat adres.
Maar de services zelf bereiken Keycloak intern als `http://keycloak:8080`. Daarom zijn er twee instellingen:

| Variabele | Waarde | Betekenis |
|---|---|---|
| `OIDC_ISSUER` | `http://localhost:8180/realms/werkorders` | wat in `iss` moet staan (het publieke adres) |
| `OIDC_JWKS_URL` | `http://keycloak:8080/realms/werkorders/protocol/openid-connect/certs` | waar de service de sleutels ophaalt (intern adres) |
| `OIDC_AUDIENCE` | `werkorders-api` | wat in `aud` moet staan |

Staan de standaardwaarden goed (ze staan zo in de services en in de manifests), dan hoef je niets in te stellen. In
Kubernetes is `localhost:8180` hetzelfde adres via een tweede `port-forward` (zie hieronder). Voor een echt, openbaar adres
heeft Keycloak een eigen hostnaam met TLS nodig en moeten `KC_HOSTNAME`, `OIDC_ISSUER` en de constante bovenin
`monteur-app.html` samen worden aangepast.

## Gerichte levering en verbindingsbeheer

De notificatieservice houdt een register bij van wie waar verbonden is (`monteurId` naar een verzameling verbindingen).
Eén monteur kan meerdere verbindingen hebben, bijvoorbeeld telefoon en tablet.

1. De client verbindt met `/ws` en stuurt als eerste bericht zijn token. Zonder geldig token wordt de verbinding
   gesloten (code 1008). Het `monteurId` komt uit het token.
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
langlopende verbindingen niet worden afgebroken. De querystring (`?since=...`) wordt doorgegeven aan de
microservice. Bij `location /api/` staat bewust geen `/` achter de naam van de upstream, zodat het volledige pad
(`/api/werkorders/WO-1002`) ongewijzigd bij de API aankomt.

**Consumer group.** `monteur-notificatie-group` verdeelt de partities over instanties. Met één instantie werkt de
gerichte levering volledig. Met meerdere instanties niet (zie het volgende hoofdstuk).

## Van PoC naar productie

Dit project is een proof-of-concept. Bij duizenden monteurs komen er andere vragen bij.

| Onderwerp | Waarom het uitmaakt |
|---|---|
| **Authenticatie** | Hier opgelost met Keycloak, tokens en een eigenaarscheck. Voor productie ontbreekt: TLS en een eigen hostnaam voor Keycloak, Keycloak met een echte database en meerdere instanties (nu `start-dev`), het verwijderen van de demo-gebruikers en de test-client met password grant, een sterk beheerwachtwoord, een koppeling van gebruikers aan het bronsysteem, en een manier om bestaande verbindingen te sluiten als rechten intrekken (nu pas bij verlopen van het token, maximaal 5 minuten). |
| **Geheimen en TLS** | Hier opgelost met TLS op de Artemis-acceptor, `NAAM_FILE`-geheimen en een lokale Vault; zie [Geheimen en TLS](#geheimen-en-tls). Voor productie ontbreekt: certificaten van de CA van de organisatie (of cert-manager), rotatie van wachtwoorden en certificaten zonder het Artemis-volume te wissen, een beheerde kluis (Azure Key Vault) met audit-logging en toegang via workload identity in plaats van het lokale root-token, en TLS ook op Keycloak, Kafka en de console. |
| **Meerdere instanties** | In één consumer group krijgt één instantie elk bericht, dus een monteur die op een andere instantie verbonden is, mist het. Oplossingen: een eigen consumer group per instantie, een pub/sub-laag (Redis, NATS) of een beheerde dienst (Azure Web PubSub, SignalR). |
| **Inhalen na offline** | Hier opgelost met een buffer in het geheugen en `?since=`. In productie moet die buffer gedeeld en duurzaam zijn (Redis, database of opnieuw lezen uit Kafka), en hoort er een volgnummer per monteur in plaats van een tijdstip. |
| **Reconnect-storm** | Na een herstart of uitrol verbinden alle clients tegelijk opnieuw. Wachttijd met willekeurige vertraging (de app doet dit al) en gecontroleerd afbouwen van verbindingen bij het uitrollen helpen. |
| **Capaciteit** | Elke verbinding kost geheugen en een bestandsdescriptor. nginx (`worker_connections`) en de service moeten daarop zijn afgesteld, en `limit_req` per IP kan knellen als veel monteurs achter dezelfde mobiele provider zitten. |
| **Kanaal** | WebSocket is tweerichtingsverkeer. Voor alleen ontvangen is SSE eenvoudiger (met `Last-Event-ID` om in te halen). Voor een mobiele app in het veld zijn push-notificaties (FCM/APNs) of MQTT geschikter. |

Kafka is een backbone voor service-naar-service-verkeer. Je laat er geen duizenden eindgebruikers op aansluiten
(één consumer per monteur is een anti-patroon). Tussen Kafka en de monteur hoort een aparte laag (notification service of
push gateway) die per gebruiker routeert, verbindingen beheert en berichten opvangt voor wie offline is. De
`ws-microservice` is daar de eenvoudige eerste versie van.

## Deployen op Kubernetes (Azure AKS)

Dezelfde applicatie draait ook op Kubernetes. De manifests staan in `k8s/`. Ze zijn zo klein gehouden dat alles op
**één node met 2 vCPU en 8 GiB** past (Standard_B2s_v2). Zie [Kosten](#kosten-en-opruimen) hieronder.

> **Let op:** Keycloak draait hier in ontwikkelmodus (`start-dev`) en zonder TLS. Zet deze omgeving daarom niet openbaar
> op internet. De standaardopzet is alleen bereikbaar via `kubectl port-forward` vanaf je eigen computer. Daar past het
> inloggen goed bij: de browser gebruikt `http://localhost:8180` voor Keycloak, net als in Docker Compose.

### Wat is anders dan in Docker Compose

| Compose | Kubernetes |
|---|---|
| `services:` met `restart: unless-stopped` | `Deployment` (en `StatefulSet` voor Redpanda); Kubernetes herstart pods vanzelf |
| `depends_on` | geen volgorde; `readinessProbe` houdt verkeer weg tot een pod klaar is, en de services proberen opnieuw te verbinden |
| `redpanda-init`-container | een `Job` (`20-topics-job.yaml`) die de topics aanmaakt |
| volume voor Redpanda | `volumeClaimTemplate`: een Azure-schijf die blijft bestaan als de pod herstart |
| `ports:` en `expose:` | een `Service` per onderdeel; van buiten alleen via `port-forward` |
| `nginx.conf` en HTML als gemounte bestanden | twee `ConfigMap`s, aangemaakt door `deploy.sh` |
| Keycloak met `admin/admin` en het realm-bestand | een `Deployment` (`60-keycloak.yaml`); het realm in een `ConfigMap`, het beheerwachtwoord in een `Secret` dat `deploy.sh` willekeurig aanmaakt |
| `build:` | de image wordt in Azure Container Registry (ACR) gebouwd en uit die registry gehaald |
| Docker-secrets uit `secrets/` (gevuld door Vault), `NAAM_FILE` | Kubernetes-Secrets als projected volume onder `/geheimen` (zelfde `NAAM_FILE`; niet onder `/run/secrets`, want daar maakt Kubernetes zelf het service-accounttoken aan en een alleen-lezen map daar laat de container niet starten); standaard door `deploy.sh` willekeurig aangemaakt, of uit Azure Key Vault met `KEYVAULT_NAME=...` (`70-secrets-keyvault.yaml`, niet op een cluster getest) |
| TLS-keystore uit `scripts/maak-certs.sh` | Secret `artemis-tls` (`broker.p12`, `ca.pem`, `keystore-password`), door `deploy.sh` aangemaakt met hetzelfde script; voor productie cert-manager |

### Stap 1: voorbereiding

```bash
brew install azure-cli kubectl
az login
```

Bij een nieuw Azure-account moeten sommige onderdelen eenmalig worden geactiveerd (duurt een paar minuten):

```bash
for p in Microsoft.ContainerService Microsoft.ContainerRegistry Microsoft.Compute Microsoft.Network Microsoft.Storage; do
  az provider register --namespace $p
done
```

### Stap 2: registry en cluster aanmaken

```bash
RG=rg-werkorder
ACR=werkorder$RANDOM            # naam moet wereldwijd uniek zijn, alleen kleine letters en cijfers

az group create --name $RG --location westeurope
az acr create --resource-group $RG --name $ACR --sku Basic

az aks create --resource-group $RG --name aks-werkorder \
  --tier free --node-count 1 --node-vm-size Standard_B2s_v2 \
  --node-osdisk-type Managed --node-osdisk-size 32 \
  --attach-acr $ACR --generate-ssh-keys

az aks get-credentials --resource-group $RG --name aks-werkorder
kubectl get nodes                # de node hoort "Ready" te tonen
echo $ACR                        # onthoud de naam
```

### Stap 3: deployen

```bash
./k8s/deploy.sh $ACR
```

Het script bouwt de twee images in de cloud, maakt de configuratie aan en start alles. Het eindigt met een overzicht
van de pods; die horen allemaal `Running` te zijn (de topics-job staat op `Completed`).

Bij het bouwen in ACR wordt de hele map `microservice/` en `werkorder-api/` geüpload. Heb je daar een `node_modules`-map
staan, zet die dan in een `.dockerignore`, anders duurt het uploaden onnodig lang.

### Stap 4: gebruiken

Er zijn twee `port-forward`s nodig: één voor de app, één voor Keycloak (de browser moet daar rechtstreeks heen om in te loggen).
Gebruik twee terminalvensters en laat ze draaien:

```bash
kubectl -n werkorder port-forward svc/api-gateway 8080:80
kubectl -n werkorder port-forward svc/keycloak 8180:8080
```

Open `http://localhost:8080/` en log in als `m-017` (wachtwoord `welkom017`). Het beheerwachtwoord van Keycloak staat
in een `Secret` en is willekeurig:

```bash
kubectl -n werkorder get secret keycloak-admin -o jsonpath='{.data.password}' | base64 -d; echo
```

Stuur berichten via de pod:

```bash
printf '%s\n' \
'{"werkorderId":"WO-1001","monteurId":"M-017","status":"OPEN","bericht":"Nieuwe storing toegewezen"}' \
| kubectl -n werkorder exec -i redpanda-0 -- rpk topic produce werkorder-notificaties -z none
```

Logs en status:

```bash
kubectl -n werkorder logs deploy/ws-microservice --tail 10
kubectl -n werkorder get pods
kubectl -n werkorder top pods            # geheugen en cpu per pod
```

Een `port-forward` stopt als de pod waarmee hij verbonden is, herstart. Start het commando dan opnieuw.

### Optioneel: openbaar bereikbaar

Dit maakt een Azure Load Balancer met een openbaar IP-adres aan (extra kosten) en laat alleen jouw IP-adres toe:

```bash
sed "s#JOUW_IP#$(curl -s https://api.ipify.org)#" k8s/optioneel-publiek.yaml | kubectl apply -f -
kubectl -n werkorder get svc api-gateway-publiek     # wacht tot EXTERNAL-IP is gevuld
```

Er is geen TLS: verkeer loopt onversleuteld over http. Voor echt gebruik hoort er een ingress met een certificaat voor
(bijvoorbeeld cert-manager) en authenticatie voor. Een Azure Load Balancer sluit inactieve verbindingen na een tijd; de
heartbeat van de service (elke 30 seconden) houdt de WebSocket-verbindingen levend.

### Geheugenbudget op één node

| Onderdeel | Gevraagd (requests) | Maximaal (limits) |
|---|---|---|
| redpanda | 1 GiB | 1,5 GiB |
| ws-microservice | 96 MiB | 192 MiB |
| werkorder-api (met SQLite en kafkajs) | 96 MiB | 192 MiB |
| api-gateway | 16 MiB | 64 MiB |
| keycloak | 640 MiB | 1 GiB |
| artemis | 768 MiB | 1 GiB |
| source-adapter | 64 MiB | 128 MiB |
| target-adapter | 64 MiB | 128 MiB |
| bron-app | 32 MiB | 96 MiB |
| **Totaal** | **circa 2,8 GiB** | **circa 4,4 GiB** |

Met de taakgerichte keten (Artemis, twee adapters, bron-app) is dit krapper dan voorheen: controleer met `kubectl top pods`. Een node van 8 GiB houdt na Kubernetes zelf (systeempods en gereserveerd geheugen; reken op 5 tot 6 GiB bruikbaar)
daar ruimte voor over. Keycloak is de zwaarste: het opstarten in `start-dev` heeft een korte piek, vandaar het limiet van 1 GiB.

### Kosten en opruimen

Reken bij één node van het type Standard_B2s_v2 op circa $95 tot $110 per maand als het cluster de hele tijd aanstaat
(node circa $70, load balancer en IP circa $20 tot $25, schijven circa $5 tot $15). De controlelaag van AKS is gratis in
de gratis tier. Dit zijn richtprijzen; controleer ze in de Azure Pricing Calculator.

```bash
az aks stop  --resource-group $RG --name aks-werkorder    # node-kosten stoppen tussen sessies
az aks start --resource-group $RG --name aks-werkorder    # weer aanzetten

az group delete --name $RG --yes --no-wait                # ALLES verwijderen: cluster, registry, schijven, IP-adressen
```

Na `stop` en `start` herstarten de pods. De data van Redpanda blijft op de schijf, maar het register van verbindingen
en de inhaalbuffer van `ws-microservice` zijn dan leeg. Stel in Azure Cost Management een budgetalarm in.

## Geleerde lessen (troubleshooting)

| Symptoom | Oorzaak | Oplossing |
|---|---|---|
| `host not found in upstream` in nginx | een upstream-service (microservice of API) draait niet of crasht bij het opstarten | de service repareren, dan de gateway herstarten. Laat `api-gateway` via `depends_on` wachten op beide backends. |
| 502 Bad Gateway na herbouwen | nginx onthoudt het IP-adres van een upstream bij het opstarten | `docker compose restart api-gateway` |
| Wijziging in `nginx.conf` werkt niet of de gateway start niet | syntaxfout in de configuratie | `docker compose exec api-gateway nginx -t` voor herstarten |
| `Snappy compression not implemented`, consumer stopt | `rpk` comprimeert standaard met Snappy, kafkajs kent alleen gzip | produceer met `-z none`, of voeg een Snappy-codec toe (`kafkajs-snappy`) |
| Consumer blijft hetzelfde bericht opnieuw crashen | het bericht is niet als gelezen gemarkeerd | service stoppen, `rpk group seek monteur-notificatie-group --to end --topics werkorder-notificaties`, daarna starten |
| Consumer crasht op `message.value.toString()` | bericht zonder inhoud (`null`) | controle op lege waarde vóór verwerken |
| Melding komt niet aan in de app | het `monteurId` in het bericht komt niet overeen met de ingelogde monteur, of die is niet verbonden | controleer `monteurId` in het bericht en wie is ingelogd, en lees de log: `Monteur M-017 is niet verbonden` |
| Berichten verdwijnen naar de DLQ na de overstap op gerichte levering | de producer stuurt het verplichte veld `monteurId` nog niet mee | `monteurId` toevoegen aan het bericht, of het veld eerst optioneel maken |
| `Verbinding geweigerd` in de app | de service heeft het token niet geaccepteerd | lees `docker compose logs ws-microservice --tail 20`: daar staat de reden (iss, aud, handtekening, verlopen). Klik op "Opnieuw inloggen". |
| Elke API-aanroep geeft 401, ook met een vers token | `iss` of `aud` in het token komt niet overeen met de service | decodeer het token (`echo $T17 \| cut -d. -f2 \| base64 -d`) en vergelijk `iss` met `OIDC_ISSUER` en `aud` met `OIDC_AUDIENCE`. Het token moet uitgegeven zijn via `http://localhost:8180`, niet via `http://keycloak:8080`. |
| `aud` mist `werkorders-api` | de audience mapper is niet geladen (oud realm) | `docker compose up -d --force-recreate keycloak` en opnieuw inloggen |
| API of WebSocket geeft 503 / sluiting 1013 | Keycloak is nog aan het opstarten of onbereikbaar en de sleutels zijn nog niet opgehaald | wacht tot Keycloak klaar is (`docker compose logs keycloak --tail 5`); de service probeert het bij het volgende verzoek opnieuw |
| Het inlogscherm laadt niet, of `redirect_uri` is ongeldig | Keycloak is nog niet klaar, of je opent de app op een ander adres dan `http://localhost/` | open `http://localhost/` (niet `127.0.0.1` of een computernaam); toegestaan zijn `http://localhost/*` en `http://localhost:8080/*` |
| Wijziging in het realm-bestand werkt niet | Keycloak slaat het import over als het realm al bestaat | `docker compose up -d --force-recreate keycloak` |
| Keycloak start niet, of wordt steeds afgesloten | te weinig geheugen, of fout in `compose-snippet.yml` | `docker compose logs keycloak --tail 40`; controleer de inspringing en of Docker Desktop minstens 4 GB geheugen heeft |
| Op AKS: inloggen mislukt of de pagina van Keycloak laadt niet | de tweede `port-forward` (`svc/keycloak 8180:8080`) draait niet | start hem; de app en Keycloak hebben elk hun eigen `port-forward` nodig |
| Op AKS: Keycloak pod blijft `Starting` of `OOMKilled` | start-dev heeft een geheugenpiek bij het opstarten | `kubectl -n werkorder describe pod -l app=keycloak`; verhoog het limiet in `60-keycloak.yaml` naar 1,5Gi en `-Xmx` mee |
| Melding komt aan, detail zegt "Werkorder niet gevonden" | het id staat niet in de voorbeelddata (alleen WO-1001 t/m WO-1003) | gebruik een bestaand id (WO-1001 t/m WO-1003 komen uit `werkorder-api/seed.js`, andere ontstaan via de bron-app en de adapters) |
| Melding komt aan, detail zegt "Geen toegang" | de werkorder is van een andere monteur (bijvoorbeeld WO-1003 voor M-017) | dat is de eigenaarscheck die werkt; stuur het bericht met een werkorder van de juiste monteur (M-017: WO-1001 en WO-1002, M-022: WO-1003) |
| Meldingen zijn weg na wisselen van monteur of herladen | de lijst stond alleen in het geheugen van de pagina (oudere versie van de app) | gebruik de huidige `monteur-app.html`: die bewaart de lijst in `localStorage` en haalt gemiste meldingen in |
| Na herstart van `ws-microservice` komen oude meldingen niet terug | de inhaalbuffer leeft in het geheugen | bekende beperking, zie "Inhalen van gemiste meldingen" |
| `Verbinding geweigerd: since is ongeldig` | `since` is geen ISO 8601-tijdstip in UTC | gebruik bijvoorbeeld `2026-10-16T14:03:22.123Z` |
| Pod `ImagePullBackOff` op AKS | het cluster mag de registry niet lezen, of de tag bestaat niet | `az aks update --resource-group $RG --name aks-werkorder --attach-acr $ACR`, dan `./k8s/deploy.sh $ACR` opnieuw |
| `az aks create` meldt dat de VM-grootte niet beschikbaar is of dat de quota op is | niet elke grootte is overal vrij beschikbaar | kies een andere grootte met 8 GiB, bijvoorbeeld `Standard_B2as_v2`, of kijk met `az vm list-skus --location westeurope --size Standard_B2 --output table` |
| Pod `redpanda-0` blijft `Pending` | de schijf kan niet worden aangemaakt | `kubectl -n werkorder describe pvc data-redpanda-0` en `kubectl -n werkorder describe pod redpanda-0` |
| Pod `redpanda-0` herstart steeds, `OOMKilled` | het geheugenlimiet is te laag voor de belasting | verhoog het limiet in `10-redpanda.yaml`, en `--memory` mee |
| `ws-microservice` in `CrashLoopBackOff` met een rechtenfout | de image draait niet goed als gebruiker 1000 | bekijk `kubectl -n werkorder logs deploy/ws-microservice`; haal `runAsUser: 1000` uit `30-ws-microservice.yaml` als het aan de gebruiker ligt |
| Gateway-pod crasht met `host not found in upstream` | een service ontbreekt | `kubectl -n werkorder get svc`; controleer de namen `ws-microservice` en `werkorder-api` |
| Wijziging in `nginx.conf` of `monteur-app.html` werkt niet | de gateway leest ConfigMaps alleen bij het starten | `./k8s/deploy.sh $ACR` opnieuw draaien (herstart de gateway), of `kubectl -n werkorder rollout restart deployment/api-gateway` |
| Twee regels aan elkaar in `rpk` | meerdere regels tegelijk geplakt in het interactieve commando | één regel tegelijk plakken, of `printf ... \| docker exec -i ...` gebruiken |

## Mogelijke vervolgstappen

- Kubernetes uitbreiden met TLS (ingress en cert-manager, met een eigen hostnaam voor Keycloak), een Helm-chart of
  Kustomize, en een pipeline die de images bouwt en uitrolt.
- Keycloak productieklaar maken: `start` in plaats van `start-dev`, een externe database, meerdere instanties, het
  monteurId als eigen attribuut in plaats van de gebruikersnaam, en koppeling aan het echte gebruikersbestand.
- Bestaande WebSocket-verbindingen sluiten zodra rechten van een monteur worden ingetrokken.
- De inhaalbuffer duurzaam en gedeeld maken (Redis of database), met een volgnummer per monteur in plaats van een tijdstip.
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
