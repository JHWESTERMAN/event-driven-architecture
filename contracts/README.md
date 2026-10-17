# contracts/

Eén plek voor alle berichtcontracten van de EAM-integratie, met voorbeelden en golden files. Alles is JSON Schema 2020-12
en wordt getest met Ajv in strikte modus.

```
bron/            werkopdracht-1.0.schema.json   de eigen interface van de bronapp (OMS): Nederlandse veldnamen, codelijsten,
                                                lokale tijden, Rijksdriehoek-coordinaten
                 ongeldig/                      voorbeelden die het schema moet afwijzen (elk om een eigen reden)
canoniek/        eam-workorder-1.0.schema.json  het gedeelde EAM-model: Engels, UTC, WGS84
                 ongeldig/
monteur/         werkorder-notificatie.schema.json   het bestaande dunne event op werkorder-notificaties
                 geldig/, ongeldig/
mapping-tests/golden/   NNN-naam.bron.json + NNN-naam.canoniek.json: dezelfde gebeurtenis in beide vormen
tools/rd.js      referentie voor Rijksdriehoek naar WGS84
test-contracts.js
```

## Draaien

```bash
cd contracts
npm install
npm test
```

De test controleert: schema's compileren, elke golden pair voldoet aan zijn schema, elk ongeldig voorbeeld wordt afgewezen,
de bronapp bouwt alleen geldige berichten (ook 300 willekeurige) en de coordinatenomzetting klopt op het referentiepunt.
De transformatie zelf (bron naar canoniek) komt in de source-adapter en wordt daar tegen dezelfde golden files getest.

## Mapping bron naar canoniek (de afspraak voor de source-adapter)

| Bron | Canoniek | Regel |
|---|---|---|
| `kop.berichtId` | `envelope.messageId` | ongewijzigd overnemen, zodat een herhaling door de bron dezelfde `messageId` houdt |
| `kop.berichtId` | `envelope.correlationId` | tenzij het verzoek een `X-Correlation-Id`-header heeft: die wint |
| `kop.verzondenOp` | `envelope.occurredAt` | `dd-MM-yyyy HH:mm:ss` is lokale tijd in `Europe/Amsterdam`; omzetten naar UTC met `Z` (let op zomer- en wintertijd: golden 004 is wintertijd) |
| `kop.volgnummer` | `envelope.version` | |
| `kop.bronSysteem` | `envelope.sourceSystem` | |
| `kop.berichtSoort` | `envelope.type` | NIEUW naar `eam.workorder.created`, WIJZIGING naar `.updated`, INTREKKING naar `.cancelled` |
| `opdracht.opdrachtNr` | `workOrder.sourceReference` en `workOrder.id` | `WOP-001001` is de referentie; het id is `WO-` plus het getal zonder voorloopnullen: `WO-1001` |
| `soortCode` | `type` | COR naar CORRECTIVE, PRV naar PREVENTIVE, INS naar INSPECTION |
| `prioriteitCode` | `priority` | 1 en 2 naar HIGH, 3 naar NORMAL, 4 naar LOW |
| `statusCode` | `status` | 01 REQUESTED, 02 PLANNED, 03 ASSIGNED, 04 IN_PROGRESS, 05 COMPLETED |
| `omschrijving.kort` | `description` | `omschrijving.lang` valt in versie 1.0 af |
| `object.objectNr` | `asset.id` | `OBJ-00214` naar `A-214` |
| `object.functioneleLocatie` | `asset.functionalLocation` | |
| `object.objectType` | `asset.kind` | WSL SWITCH, SEI SIGNAL, OVW LEVEL_CROSSING, KAB CABLE, PRT PLATFORM; ontbreekt het, laat dan `kind` weg |
| `locatie.plaats` / `emplacement` | `location.place` / `site` | |
| `locatie.positie.rd` | `location.lat` en `lon` | Rijksdriehoek naar WGS84, afgerond op 6 decimalen (zie `tools/rd.js`) |
| `locatie.positie.wgs84` | `location.lat` en `lon` | `breedte` naar `lat`, `lengte` naar `lon` |
| geen `positie` | geen `lat`/`lon` | |
| `toewijzing.medewerkerNr` | `assignee.id` | voorloopnullen weg, maar minimaal drie cijfers: `000017` naar `M-017`, `001234` naar `M-1234` |
| `toewijzing.naam` | `assignee.name` | voornaam, tussenvoegsel en achternaam met een spatie, lege delen weglaten: `J. de Vries` |
| `toewijzing.ploeg` | `assignee.team` | |
| geen `toewijzing` | geen `assignee` | het bronschema eist `toewijzing` vanaf statusCode 03 |
| `planning.geplandStart` / `geplandEinde` | `schedule.plannedStart` / `plannedEnd` | lokale tijd naar UTC |
| `werkpakket[]` | `tasks[]` | `stapNr / 10` wordt `T-n`; `gereed` J naar `true`, N naar `false` |
| `materialen[]` | `materials[]` | `artikelCode` naar `itemNumber`; `hoeveelheid.waarde` naar `quantity`; eenheid ST naar PCS, M naar M, KG naar KG |
| INTREKKING: `redenCode` | `cancellationReason` | DUBBEL DUPLICATE, FOUTIEF ERRONEOUS, VERVALLEN OBSOLETE, OVERIG OTHER; `status` wordt `CANCELLED` |

Ontbrekende `werkpakket` of `materialen` in de bron worden lege lijsten in het canonieke bericht.

## Van canoniek naar het monteur-model (voor de target-adapter, stap 5 en 6)

`status`: REQUESTED, PLANNED en ASSIGNED naar `OPEN`; IN_PROGRESS naar `IN_BEHANDELING`; COMPLETED en CANCELLED naar `AFGEROND`
(verliesgevend, bewust). `priority`: HIGH, NORMAL, LOW naar `HOOG`, `NORMAAL`, `LAAG`. De rest staat in
`docs/architectuur-review.md`, hoofdstuk 4.6.

## Ontwerpregels die uit de bronapp volgen

- **Herhaling door de bron.** De bronapp herhaalt bij een time-out of 5xx hetzelfde bericht met dezelfde `berichtId`. De
  source-adapter en de werkorder-api moeten daar tegen kunnen (idempotent op `messageId` en `version`).
- **Volgorde gaat niet gegarandeerd goed door herhalingen.** Met een mislukte eerste poging kan een INTREKKING (versie 2)
  vóór het bijbehorende NIEUW (versie 1) aankomen. De werkorder-api moet dus een intrekking voor een nog onbekende
  werkorder bewaren (een "tombstone" met versie) en een latere, lagere versie daarna negeren.
- **Afkeuring is een antwoord, geen retry.** Een bericht dat het bronschema niet haalt krijgt `422` en komt niet op de broker.
- **Canoniek is strikt.** Onbekende velden worden afgewezen, zodat mapping-fouten in de adapter opvallen en niet pas bij de ontvanger.
  Voor uitbreiding binnen 1.x: nieuwe velden optioneel toevoegen, in een nieuw schemabestand, en de consumerende adapter bijwerken.
