# Architectuurreview en doelarchitectuur: taakgerichte broker (ActiveMQ) met adapters en canoniek EAM-model

Datum: 2026-10-17. Gereviewd: de map `event-driven-architecture` zoals die op `main` staat (Redpanda, ws-microservice,
werkorder-api, nginx-gateway, Keycloak, monteur-app, k8s-manifests, `producer.js`).

## 1. Oordeel in het kort

De bestaande keten is voor een PoC netjes opgezet: dun event met synchroon detail, een eigenaarscheck tegen BOLA, een
DLQ met herkomstheaders, JWKS-afhandeling en een heldere README. De zwakke plek is precies waar jij naartoe wilt:
**de levering is niet taakgericht.** Er is geen bevestiging van de ontvanger, geen status per bericht en de
inhaalbuffer leeft in het geheugen. Een taakgerichte broker (ActiveMQ) vult dat gat. Kafka blijft nuttig voor wat het
goed kan: notificaties en fan-out. De twee vullen elkaar aan, ze vervangen elkaar niet.

## 2. Wat goed is

- Dun event, synchroon detail, met de API als bron van waarheid en de melding als signaal.
- Autorisatie per object (403/404-keuze bewust gedocumenteerd), token alleen in geheugen, PKCE, `aud`/`iss`-controle.
- DLQ met `dlq-reden`, bron-topic, partitie en offset; poison messages stoppen de consumer niet.
- Heartbeat, reconnect met jitter, `since`-inhaalmechanisme met ontdubbeling op `eventId`.
- Resourcebudgetten per pod en een README die ook de fouten en beperkingen eerlijk noemt.

## 3. Bevindingen op de huidige opzet

| # | Ernst | Bevinding | Gevolg / advies |
|---|---|---|---|
| 1 | Hoog | `producer.js` is syntactisch kapot (`node --check` faalt: onder meer `brokers: ['localhost:19092'` zonder `]`, `werkosder`, `conwole`). Los daarvan sluit hij niet aan op het contract: hij stuurt `monteur` (een naam) in plaats van `monteurId`, `status: TOEGEWEZEN` (niet in de enum), geen `bericht`, prefix `wO-`, en prioriteit `GEMIDDELD` terwijl de API `NORMAAL` kent. | Zelfs gerepareerd belandt elk bericht in de DLQ. Het contract wordt aan de bronkant niet afgedwongen. Wordt vervangen door de bronapp plus source-adapter (hoofdstuk 4). |
| 2 | Hoog | De Kafka-naar-WebSocket-keten is *at-most-once* richting de monteur. `ws.send` heeft geen bevestiging en de inhaalbuffer staat in het geheugen. Na een herstart van de service is een melding voor een offline monteur weg, terwijl de Kafka-offset al is opgeschoven. | Dit is precies het argument voor een taakgerichte broker: de broker bewaart het bericht tot de ontvanger het bevestigt. |
| 3 | Hoog | In `eachMessage` wordt elke onverwachte fout ingeslikt, en mislukt het versturen naar de DLQ, dan wordt dat alleen gelogd. Het bericht geldt dan als verwerkt. | Voor taakgerichte stromen mag een bericht pas worden bevestigd als de afhandeling echt geslaagd is. In de target-adapter: ack na commit, anders rollback. |
| 4 | Middel | Er is geen echte bron van waarheid: `werkorder-api` heeft drie hardgecodeerde werkorders, en events verwijzen alleen naar bestaande ids als je ze met de hand goed typt. | De target-adapter vult voortaan de werkorder-opslag via de werkorder-api. Daarmee is "dun event + synchroon detail" end-to-end testbaar. |
| 5 | Middel | Contractdrift: de statusenum staat op drie plekken (ws-microservice, API-code, `openapi.yaml`) en de producer wijkt er al van af. De schema registry van Redpanda draait, maar wordt niet gebruikt. | Eén JSON Schema per contract in een map `contracts/`, door alle componenten gebruikt, met contracttests. |
| 6 | Middel | De OIDC-tokenvalidatie (circa 120 regels) staat identiek in twee services. | Gedeelde module, of de controle naar de gateway (`auth_request`, oauth2-proxy of Envoy `jwt_authn`). Het AUTH-bericht op de WebSocket blijft nodig. |
| 7 | Laag | Versies lopen uiteen: Redpanda v23.3.10 in Compose, v24.3.1 in k8s. De comment in het manifest vraagt juist om dezelfde versie. | Pinnen op één versie. |
| 8 | Laag | Redpanda in `dev-container`-modus, Keycloak `start-dev` en `admin/admin`. Bekend en gedocumenteerd. | Bij ActiveMQ meteen goed beginnen: eigen gebruikers en rollen, geen standaardwachtwoord in de k8s-manifests. |

## 4. Doelarchitectuur

```
 Bron-app          Source-adapter           ActiveMQ Artemis             Target-adapter            werkorder-api (monteursysteem)
 (unieke,      ──►  1. valideer bron   ──►  queue eam.workorder.v1  ──►  1. deserialiseer     ──►  1. idempotente upsert (id + version)
  complexe          2. naar canoniek        DLA   ...v1.dlq              2. valideer canoniek      2. outbox, in dezelfde transactie
  interface)        3. valideer canoniek    persistent, durable          3. naar monteur-model     3. antwoord 2xx / 4xx / 5xx
                    4. serialiseer + send                                4. roep API aan                     │ outbox-relay
                    202 pas ná commit                                    5. ack pas bij 2xx                  ▼
                                                                                          Redpanda / Kafka
                                                                    ┌─────────────────────────┴───────────────────────┐
                                                        werkorder-notificaties (dun, per monteur)          werkorder-events (domeinevent, keyed op werkorder)
                                                                    │                                                  │
                                                        ws-microservice ─► gateway ─► monteur-app          analytics, audit, andere apps
```

Wat bestaat blijft: `ws-microservice`, het topic `werkorder-notificaties`, gateway, Keycloak en de monteur-app. Nieuw zijn
de bronapp, twee adapters, de ActiveMQ-broker, een tweede topic `werkorder-events` en de map `contracts/`.

**Verdeling van verantwoordelijkheid.** ActiveMQ zorgt dat de werkorder gegarandeerd bij het monteursysteem aankomt (taak).
Kafka meldt dat er iets veranderd is, aan iedereen die dat wil weten (feit). De adapters publiceren zelf niets op Kafka:
de werkorder-api is de eigenaar van de data en dus van de events.

### 4.1 Waarom beide brokers

| | ActiveMQ (taakgericht) | Kafka / Redpanda (event) |
|---|---|---|
| Paradigma | Werk dat afgehandeld moet worden: één ontvanger (of een groep concurrerende) neemt het bericht aan | Feiten die gebeurd zijn: iedereen mag meelezen, opnieuw lezen |
| Bericht na afhandeling | Weg (bevestigd) | Blijft staan tot retentie |
| Falen | Herlevering met vertraging, daarna Dead Letter Address | Consumer beheert zelf offset, DLQ moet je zelf bouwen (zoals in de ws-microservice) |
| Hier gebruikt voor | De overdracht van een werkorder van bron naar monteursysteem | Events voor de WebSocket-laag (`werkorder-notificaties`) en voor andere afnemers zoals analytics (`werkorder-events`) |

### 4.2 Kanttekening bij "de broker houdt per bericht de status bij"

Dat klopt voor de levering, maar een JMS-broker heeft geen blijvend statusregister per bericht. Wat Artemis wel doet:

| Jouw begrip | Wat de broker doet |
|---|---|
| aangeboden | bericht staat *in flight* bij de consumer (delivering), nog niet bevestigd |
| bevestigd | consumer commit/ack: het bericht wordt verwijderd, er is daarna geen spoor meer in de queue |
| mislukt | rollback of geen ack: herlevering (`redelivery-delay`, `max-delivery-attempts`), daarna naar de Dead Letter Address |

Wil je achteraf per `messageId` kunnen zien wat er gebeurd is (audit, "waar is mijn werkorder?"), dan heb je een eigen
verwerkingslog nodig. Eenvoudigste vorm: elke adapter schrijft per `messageId` een regel (ontvangen, getransformeerd,
afgeleverd, afgekeurd, met `correlationId`) in een tabel of logstroom. Daarnaast levert de Artemis management-API
(Jolokia/JMX, Prometheus-plugin) de actuele tellers: in flight, aantal herleveringen, grootte van de DLQ.

### 4.3 Source-adapter (bronapp naar broker)

1. **Invoer**: de bronapp roept de adapter aan (HTTP POST is het eenvoudigst). De adapter antwoordt `202` pas nadat de
   broker het bericht persistent heeft aangenomen. Daarmee is de verantwoordelijkheid aantoonbaar overgedragen.
2. **Valideren tegen het bronschema** (XSD of JSON Schema, afhankelijk van de bron-interface). Mislukt dit, dan is dat
   een fout van de bron: `4xx` terug, **niet** op de broker. De broker is voor geldige zaken.
3. **Transformeren** naar het canonieke model als zuivere functie, getest met golden files (voorbeeldbericht in, verwachte
   canonieke JSON uit).
4. **Valideren van de uitvoer** tegen het canonieke schema. Zo vang je mapping-fouten in de adapter en niet bij de ontvanger.
5. **Serialiseren** naar JSON (tekstbericht) en versturen met een transacted sessie, `PERSISTENT`. Zet headers:
   `JMSType` (bijvoorbeeld `eam.workorder.created`), `JMSCorrelationID`, `schemaVersion`, `messageId` (UUID) en
   `JMSXGroupID` = `workOrder.id`, zodat wijzigingen aan dezelfde werkorder op volgorde bij dezelfde consumer landen.

### 4.4 Target-adapter (broker naar monteursysteem)

1. Ontvangen in een transacted sessie (of `CLIENT_ACKNOWLEDGE`).
2. Deserialiseren en valideren tegen het canonieke schema. Is het bericht structureel ongeldig, dan helpt herleveren
   niet: stuur het met reden-headers naar `eam.workorder.v1.dlq` en bevestig het origineel (zelfde patroon als de
   huidige DLQ-headers).
3. Transformeren naar het monteur-model (zie 4.6) en aanroepen van de werkorder-api, bijvoorbeeld
   `PUT /intern/werkorders/{id}`, met het token van het Keycloak-service-account `target-adapter` (client credentials, rol `werkorder-schrijver`).
4. Het antwoord bepaalt wat er met het bericht gebeurt (zoals gebouwd; de adapter verwerkt één bericht tegelijk en meldt een tijdelijke fout als *modified* met `delivery_failed`, zodat Artemis de poging telt):

   | Antwoord van de API | Actie in de adapter |
   |---|---|
   | `2xx` | ack (commit) |
   | time-out, `503`, `5xx` | rollback: de broker herlevert met oplopende vertraging, na het maximum naar de DLA |
   | `400`, `404`, `413`, `415`, `422` | permanent onverwerkbaar: naar `eam.workorder.v1.dlq` met reden-headers (`dlqReden`, `dlqDetail`, `dlqTijd`), daarna ack van het origineel. Lukt de DLQ niet, dan telt het als mislukte aflevering |
   | `401`, `403`, `429` | tijdelijk (meestal een configuratiefout die een operator herstelt): herlevering, daarna de DLA |

De adapter publiceert dus **niets** op Kafka. Hij blijft een vertaler en heeft geen tweede schrijfactie die niet atomair is.

### 4.4a werkorder-api: opslag en events

De werkorder-api verwerkt de aanroep als **idempotente upsert** op `werkorderId` plus `versie`. Een versie die niet hoger is dan wat er
staat wordt genegeerd (antwoord `200` met `GENEGEERD`, geen wijziging), zodat herlevering veilig is. Een intrekking voor een nog
onbekende werkorder wordt bewaard als *tombstone* (`TOMBSTONE_BEWAARD`); een latere, lagere versie wordt daarna genegeerd. Zo
overleeft de API ook de herordening die bron-retries veroorzaken. Het contract staat in `werkorder-api/openapi.yaml` (tag *Intern*).

Zoals gebouwd: de domeinevents heten `werkorder.aangemaakt`, `werkorder.gewijzigd` en `werkorder.ingetrokken` (met `eventId`,
`versie`, `vorigeStatus`, `vorigeMonteurId`, `gewijzigdeVelden`, `correlationId`). Een versie-ophoging zonder inhoudelijke wijziging
maakt geen events. Bij herplaatsing krijgen zowel de oude als de nieuwe monteur een dunne notificatie.

Opslag en events worden in **één transactie** vastgelegd met een *outbox-tabel*: de API schrijft de werkorder en de
te publiceren events naar dezelfde database. **Voor de PoC is dat SQLite** (zie 4.4b). Een relay (een klein proces in de API, of Debezium) leest de outbox en publiceert
op Kafka. Zo kan een event niet verloren gaan of bestaan zonder dat de werkorder is opgeslagen.

| Topic | Inhoud | Key | Voor wie |
|---|---|---|---|
| `werkorder-notificaties` (bestaand) | dun event: `werkorderId`, `monteurId`, `status`, `bericht` | `werkorderId` | `ws-microservice` en dus de monteur |
| `werkorder-events` (nieuw) | domeinevent met de relevante toestand: type (bijvoorbeeld `WorkOrderAssigned`, `WorkOrderStatusChanged`), `eventId`, `occurredAt`, `version`, en de werkorder of de wijziging | `werkorderId` | analytics, audit en andere apps |

Waarom twee topics: een dun event is bewust zonder inhoud, omdat de monteur het detail via de API moet ophalen met zijn
eigen rechten. Voor analytics is dat onbruikbaar; die heeft de gegevens zelf nodig. Zo'n rijker event bevat potentieel
persoonsgegevens (naam monteur) en hoort dus achter eigen toegangsrechten (ACL's per topic). Wil je het eenvoudig houden,
begin dan met één topic `werkorder-events` en laat de `ws-microservice` daaruit het dunne bericht afleiden. De scheiding is dan een latere stap.

Aandachtspunt: de relay publiceert *minstens één keer*, dus afnemers moeten ontdubbelen op `eventId` (de monteur-app doet dat al).

### 4.4b Opslag voor de PoC: SQLite

De `werkorder-api` heeft nu geen database (drie hardgecodeerde werkorders in het geheugen). Voor de PoC komt er een
SQLite-bestand bij, zonder extra pod.

| Onderdeel | Keuze |
|---|---|
| Bibliotheek | het ingebouwde `node:sqlite` (Node 22.5 of hoger; de API gebruikt nu alleen de standaardbibliotheek en dat blijft zo). De basisimage gaat daarom van `node:20-alpine` naar `node:22-alpine`. Is `node:sqlite` je te experimenteel, dan is `better-sqlite3` het alternatief, met een npm-dependency. |
| Tabellen | `werkorder` (kolommen die je nodig hebt voor zoeken, plus het volledige document als JSON), `taak`, `materiaal` of die twee als JSON, en `outbox` (`id`, `topic`, `key`, `payload`, `aangemaakt_op`, `verzonden_op`) |
| Modus | `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`, `busy_timeout` ingesteld |
| Transactie | upsert van de werkorder en het wegschrijven van de outbox-regels in één `BEGIN IMMEDIATE ... COMMIT` |
| Relay | een timer in hetzelfde proces: leest onverzonden regels op volgorde, publiceert naar Kafka, zet `verzonden_op`, ruimt oude regels op |
| Opslaglocatie | Compose: een named volume op `/data`. k8s: een PVC van 1 GiB |
| Inrichting k8s | `replicas: 1` en `strategy: Recreate` (een tweede pod mag niet tegelijk dezelfde schijf schrijven) |
| Seed | de drie huidige voorbeeldwerkorders worden bij het opstarten geladen als de tabel leeg is, zodat de bestaande tests uit de README blijven werken |

**Beperkingen van deze keuze.** SQLite werkt met één schrijver en dus met één API-instantie, en verhuist niet mee als de pod op
een andere node komt (de schijf is gebonden aan één zone). Voor de PoC is dat acceptabel. De overstap naar PostgreSQL blijft klein
omdat de logica (upsert op `werkorderId` plus `version`, outbox in dezelfde transactie) gelijk blijft; alleen de driver en de SQL-dialect-details veranderen.

### 4.5 Het canonieke EAM-model

Houd het klein en neutraal: het model is niet de bron-interface en niet het monteur-model, maar wat beide *delen*.

- **Envelop** (altijd): `messageId`, `correlationId`, `type`, `schemaVersion`, `sourceSystem`, `occurredAt`, `sequence`/`version`.
- **Kernentiteiten (eerste versie)**: `WorkOrder`, `Asset` (met `functionalLocation`), `Location` (WGS84), `Task`,
  `MaterialRequirement`, `Person` (assignee).
- **Statusvocabulaire rijker dan de ontvanger**: `REQUESTED`, `PLANNED`, `ASSIGNED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`.
  De target-adapter beperkt dat naar het monteur-contract; die mapping is bewust verliesgevend en staat in code én in de documentatie.
- **Taal**: Engelse veldnamen voor het canonieke model (neutraal ten opzichte van beide kanten), de monteurkant houdt zijn Nederlandse velden.
- **Referenties om op te leunen**, niet om volledig over te nemen: MIMOSA OSA-EAI/CCOM (OpenO&M), de work-order-BOD's van OAGIS, en ISO 14224 voor de taxonomie van assets.
- **Versioneren**: nieuwe velden optioneel toevoegen is compatibel; verplichte velden of betekeniswijzigingen leveren `v2`
  en een tweede queue (`eam.workorder.v2`) op. Dat is dezelfde les als bij `monteurId` in de README.

Voorbeeld van een canoniek bericht (uit `contracts/mapping-tests/golden/001-nieuw-toegewezen.canoniek.json`; de bijbehorende bronvorm staat ernaast):

```json
{
  "envelope": {
    "messageId": "7d3f2b1e-5c0a-4c0e-9a55-2b6f7f3b9a10",
    "correlationId": "7d3f2b1e-5c0a-4c0e-9a55-2b6f7f3b9a10",
    "type": "eam.workorder.created",
    "schemaVersion": "1.0",
    "sourceSystem": "OMS",
    "occurredAt": "2026-10-17T08:15:00Z",
    "version": 1
  },
  "workOrder": {
    "id": "WO-1001",
    "sourceReference": "WOP-001001",
    "type": "CORRECTIVE",
    "priority": "HIGH",
    "status": "ASSIGNED",
    "description": "Storing wissel 214, wisselmotor reageert niet",
    "asset": { "id": "A-214", "functionalLocation": "BD-N-WSL-0214", "kind": "SWITCH" },
    "location": { "place": "Breda", "site": "Breda Noord", "lat": 51.567093, "lon": 4.776389 },
    "assignee": { "id": "M-017", "name": "J. de Vries", "team": "Ploeg Breda 2" },
    "schedule": { "plannedStart": "2026-10-17T09:00:00Z", "plannedEnd": "2026-10-17T12:00:00Z" },
    "tasks": [
      { "id": "T-1", "description": "Wissel veiligstellen", "done": false },
      { "id": "T-2", "description": "Wisselmotor controleren", "done": false },
      { "id": "T-3", "description": "Rapport invullen", "done": false }
    ],
    "materials": [
      { "itemNumber": "WM-204", "description": "Wisselmotor 220V", "quantity": 1, "unit": "PCS" }
    ]
  }
}
```

### 4.6 Mapping canoniek naar monteur-model (huidige API)

| Canoniek | Monteur-model | Opmerking |
|---|---|---|
| `workOrder.id` | `werkorderId` | formaat `WO-\d+` blijft gelden |
| `status` ASSIGNED / PLANNED / REQUESTED | `OPEN` | verliesgevend |
| `status` IN_PROGRESS | `IN_BEHANDELING` | |
| `status` COMPLETED / CANCELLED | `AFGEROND` | CANCELLED verdient eigenlijk een eigen waarde; bewuste keuze nodig |
| `priority` HIGH / NORMAL / LOW | `HOOG` / `NORMAAL` / `LAAG` | lost de `GEMIDDELD`-afwijking van `producer.js` op |
| `assignee.id` | `monteur.id` en event-veld `monteurId` | routeringssleutel voor de WebSocket-laag |
| `location.*` | `locatie.{plaats, spoorEmplacement, coordinaten}` | |
| `tasks[]`, `materials[]` | `taken[]`, `materiaal[]` | kardinaliteit 0..* blijft: lege lijst betekent "geen" |

## 5. Wat er in de repository bijkomt

```
contracts/       (gebouwd) schema's, voorbeelden, golden files, contracttest; zie contracts/README.md
bron-app/        (gebouwd) heeft het verwijderde producer.js vervangen; bouwt berichten in de bron-interface en stuurt ze naar de source-adapter
artemis/         (gebouwd, nog niet getest tegen een draaiende broker) broker.xml met queue, DLA en herlevering
docker-compose.yml    (aangepast) services `artemis`, `source-adapter` en `bron-app`, volume `artemis-data`
source-adapter/  (gebouwd, 24 tests groen tegen een nagebootste AMQP-broker, nog niet tegen Artemis) connector-in
werkorder-api/   (gebouwd, 21 tests groen; Kafka-publisher nog niet tegen Redpanda getest) SQLite (`node:sqlite`), intern PUT, tombstones, outbox-relay; `node:22-alpine`
target-adapter/  (gebouwd, 16 tests groen tegen nagebootste broker en API, nog niet tegen Artemis) connector-out
k8s/             (aangepast, nooit toegepast op een cluster) 15-artemis (StatefulSet+PVC 2 GiB), 42/43/44 adapters en bron-app, 40-werkorder-api (PVC 1 GiB, Recreate, secret), topic werkorder-events, deploy.sh met secrets
```

Geheugen op de ene AKS-node (SQLite draait in het proces van de API en kost nauwelijks extra geheugen; de PVC van 1 GiB komt erbij): Artemis (circa 512 MiB tot 1 GiB heap plus overhead) en twee kleine adapters (circa 128 MiB elk)
brengen de limieten van circa 2,9 GiB naar circa 4,4 GiB (requests circa 2,8 GiB). Dat past nog in de 5 tot 6 GiB bruikbaar op de B2s_v2, maar de marge
wordt krapper; houd `kubectl top` in de gaten.

## 6. Beslissingen

Genomen (2026-10-17):

1. **Broker: Apache ActiveMQ Artemis**, image `apache/artemis:2.57.0`.
2. **Adapters: Node.js met AMQP 1.0** (bijvoorbeeld `rhea`). Validatie en transformatie zijn zuivere functies los van het transport, zodat een latere port naar Java mogelijk blijft.
3. **Bron-interface: JSON Schema** (`contracts/bron/werkopdracht-1.0.schema.json`), bewust afwijkend van het canonieke model.
4. **Opslag in de werkorder-api voor de PoC: SQLite** (`node:sqlite`). Overstap naar PostgreSQL is een latere stap.
5. **Kafka blijft voor events** (`werkorder-notificaties` dun, `werkorder-events` voor analytics en andere afnemers). De werkorder-api publiceert via een outbox, niet de adapter.
6. **Verwerkingslog:** gestructureerde JSON-logregels per bericht (`messageId`, `correlationId`, stap, uitkomst). Een Kafka-topic `eam-integration-log` volgt als analytics erom vraagt.

7. **Interne schrijf-API beveiligd met een Keycloak-service-account** (client `target-adapter`, client credentials, realmrol
   `werkorder-schrijver`). De API controleert handtekening, uitgever, doelgroep, `azp` en rol; een monteurtoken komt er niet door en
   het service-token mag de monteur-API niet lezen. Het pad `/intern` loopt bovendien niet via de gateway. De gedeelde sleutel
   `INTERN_API_KEY` bestaat nog alleen voor lokaal testen zonder Keycloak.
8. **Artemis met minimale rechten per partij:** beheerder (rol `amq`), source-adapter (rol `eam-source`: alleen versturen naar
   `eam.workorder.v1`) en target-adapter (rol `eam-target`: ontvangen van de queue, versturen naar de `.dlq`). Gebruikers en rollen komen
   uit `artemis/init-users.sh`; de rechten staan in `broker.xml`.
9. **TLS op de Artemis-acceptor** (`sslEnabled=true`, TLS 1.2 en 1.3, PKCS12-keystore). De adapters vertrouwen alleen de eigen CA en
   controleren keten én hostnaam; er is geen schakelaar om dat uit te zetten. Geen clientcertificaten (mTLS): de adapters loggen in met
   gebruikersnaam en wachtwoord, wat veilig is omdat de verbinding versleuteld is. Certificaten lokaal: `scripts/maak-certs.sh`; productie:
   CA van de organisatie of cert-manager.
10. **Geheimen uit een kluis, als bestand.** Applicaties lezen `NAAM_FILE` (pad onder `/run/secrets`) in plaats van een omgevingsvariabele, zodat
   wachtwoorden niet in `docker inspect` of in `/proc/<pid>/environ` staan. De bron is lokaal HashiCorp Vault (`scripts/kluis.sh`, leestoken met
   alleen-lezenbeleid, kortlevend) en op AKS Azure Key Vault via de Secrets Store CSI-driver (`k8s/70-secrets-keyvault.yaml`). Waarom bestanden en
   geen directe kluisaanroep in de code: de applicaties blijven onafhankelijk van de kluis, en de kluis kan zonder codewijziging worden vervangen.
   Lokaal komt `.env` zonder wachtwoorden; de rooktest (stap 4d) controleert dat geen enkel geheim in `docker inspect` staat.

TLS en kluis (besluit 9 en 10) zijn op 2026-10-17 geverifieerd met `scripts/smoketest.sh --volledig` (alles groen, inclusief stap 4d): plaintext AMQP wordt
geweigerd, TLS met de juiste gegevens werkt, het certificaat past bij `artemis` en niet bij een andere naam, de opstartgebruiker kan niet inloggen en geen geheim staat in `docker inspect`.

Eerder geverifieerd op 2026-10-17 met `scripts/smoketest.sh --volledig` (42 controles groen, Docker Compose, Artemis 2.57.0):

- `broker.xml` wordt door Artemis geaccepteerd; queue `eam.workorder.v1` en DLA bestaan.
- Keten bron-app, source-adapter, Artemis, target-adapter, werkorder-api (SQLite), Kafka (`werkorder-events` en `werkorder-notificaties`) werkt voor nieuw, wijziging en intrekking.
- Ongeldig bronbericht: 422 aan de rand, niets op de broker, bron herhaalt niet.
- API valt uit: het bericht blijft op de queue en wordt na herstel verwerkt (herlevering na `modified` met `delivery_failed`).
- Broker valt uit: de source-adapter geeft 503 en het systeem herstelt zonder handmatig ingrijpen.
- Permanent onverwerkbaar bericht (geen JSON, ongeldig canoniek model): de target-adapter stuurt het met reden naar `eam.workorder.v1.dlq` en bevestigt het origineel (rooktest stap 4b).
- Een bericht dat blijft mislukken (API uit) gaat na de maximale pogingen naar de DLA en blijft daar staan, zonder de API te bereiken (stap 8). Rooktest totaal: 42 groen.
- Artemis ontdubbelt een herhaald bericht op `_AMQ_DUPL_ID`: de target-adapter zag het één keer (stap 7). De API vangt dubbelen daarnaast op via `versie`, dus er zijn twee lagen.

Nog te verifiëren:

- Mapping van `subject` en `group_id` naar `JMSType` en `JMSXGroupID` bij een JMS-consument.
- Kubernetes: `k8s/70-secrets-keyvault.yaml`, de Secret-volumes, het TLS-Secret `artemis-tls` en `deploy.sh` zijn niet op een cluster toegepast.

Een canoniek model tussen één bron en één ontvanger kost twee transformaties in plaats van één. Het verdient zich terug
vanaf ongeveer drie gekoppelde systemen. Voor deze PoC is het vooral waardevol als demonstratie van het patroon; houd het model
daarom klein en laat het niet de spiegel van de bron worden.
