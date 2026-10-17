# source-adapter (connector-in)

Ontvangt werkopdrachten van de bronapp, valideert ze tegen het bronschema, vertaalt ze naar het canonieke EAM-model, valideert
het resultaat en zet het persistent op de ActiveMQ-queue `eam.workorder.v1`.

```
POST /werkopdracht  ->  1 bronschema  ->  2 transformatie  ->  3 canoniek schema  ->  4 AMQP naar Artemis  ->  202
```

## Antwoorden

| Status | Betekenis | Bron moet |
|---|---|---|
| `202` | Het bericht staat persistent op de broker (de broker heeft het bevestigd). | niets meer |
| `400` / `413` / `415` | geen geldige JSON / te groot (256 KiB) / geen `application/json` | het bericht herstellen |
| `422` | Voldoet niet aan het bronschema (met `details`: pad en melding), of kan niet vertaald worden (bijvoorbeeld een tijdstip dat niet bestaat). Het bericht komt niet op de broker. | het bericht herstellen; herhalen helpt niet |
| `500` | Ons eigen canonieke bericht is ongeldig: een fout in de adapter. Staat met details in de log. | niet herhalen tot de adapter is hersteld |
| `503` | De broker nam het bericht niet over (afgewezen, vrijgegeven, geen antwoord, geen verbinding). Met `Retry-After`. | herhalen met **dezelfde** `berichtId` |

`GET /health`: `200` als de adapter verbonden is met de broker, anders `503` (geschikt als readiness-probe).

## Wat er naar de broker gaat

Een AMQP 1.0-bericht met als lichaam het canonieke bericht als JSON-tekst (bij Artemis een `TextMessage`):

| AMQP-veld | Waarde | JMS-equivalent |
|---|---|---|
| `durable` | `true` | persistent (`DeliveryMode`) |
| `message_id` | `envelope.messageId` | `JMSMessageID` |
| `correlation_id` | `envelope.correlationId` | `JMSCorrelationID` |
| `subject` | `envelope.type`, bijvoorbeeld `eam.workorder.created` | `JMSType` |
| `group_id` | `workOrder.id` | `JMSXGroupID` (wijzigingen aan een werkorder, op volgorde, bij dezelfde consument) |
| `application_properties._AMQ_DUPL_ID` | `envelope.messageId` | ontdubbeling door de broker |
| `application_properties` overig | `schemaVersion`, `sourceSystem`, `eamType`, `workOrderId`, `version` | message properties |

Of Artemis `subject` en `group_id` precies op `JMSType` en `JMSXGroupID` afbeeldt, en of `_AMQ_DUPL_ID` via AMQP ontdubbelt, is nog niet
tegen een echte broker gecontroleerd (zie `docs/architectuur-review.md`, hoofdstuk 6).

## Instellingen (omgevingsvariabelen)

| Variabele | Standaard |
|---|---|
| `PORT` | `8090` |
| `BROKER_HOST`, `BROKER_PORT` | `artemis`, `61616` |
| `BROKER_USER`, `BROKER_PASSWORD` | `artemis`, `artemis` (lokaal; in k8s uit een Secret) |
| `BROKER_QUEUE` | `eam.workorder.v1` |
| `BROKER_SEND_TIMEOUT_MS` | `5000` |
| `CONTRACTS_DIR` | `../contracts` (in de image `/app/contracts`) |

## Logs

Elke stap schrijft een JSON-regel naar stdout. Zo volg je een bericht:

```bash
docker compose logs source-adapter | grep <messageId>
```

Stappen: `ontvangen`, `bronvalidatie`, `transformatie`, `canonieke-validatie`, `verzonden`, met `uitkomst` `ok`, `afgewezen` of `mislukt`.

## Tests

```bash
cd source-adapter && npm install && npm test
```

- `test/transform.test.js`: elke golden pair uit `contracts/mapping-tests/golden`, tijdzones (zomertijd, wintertijd, overgangen), coördinaten.
- `test/integratie.test.js`: HTTP-ingang tegen een **nagebouwde** AMQP-broker (`test/fake-broker.js`): bericht en eigenschappen, 422 zonder bericht op de
  queue, afwijzen, vrijgeven, time-out, brokeruitval met herverbinden.

Wat deze tests **niet** bewijzen: gedrag van Artemis zelf (persistentie, ontdubbeling, DLA, de afbeelding op JMS-velden).
Daarvoor is een draaiende broker nodig.
