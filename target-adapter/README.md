# target-adapter (connector-out)

Leest `eam.workorder.v1` van ActiveMQ Artemis (AMQP 1.0, `rhea`), valideert tegen het canonieke schema, transformeert naar het
monteur-model en schrijft via `PUT /intern/werkorders/{id}` naar de werkorder-api. Pas na een 2xx wordt het bericht bevestigd.

| Situatie | Wat de adapter doet | Wat de broker ziet |
|---|---|---|
| API 2xx (ook `GENEGEERD`/`TOMBSTONE_BEWAARD`) | bevestigen | accepted: bericht weg |
| API-time-out, 5xx, 401/403/429, netwerkfout, onverwachte fout | niets bevestigen | modified `delivery_failed`: herlevering met vertraging, na 5 pogingen naar `eam.workorder.v1.dlq` |
| geen JSON, canoniek schema niet gehaald, transformatie onmogelijk, API 400/404/413/415/422 | kopie naar `eam.workorder.v1.dlq` met `dlqReden`/`dlqDetail`, dan bevestigen | accepted |
| DLQ-doorsturen mislukt | niets bevestigen | zoals tijdelijke fout |

Eén bericht tegelijk (krediet 1). Overtakelen door herlevering is veilig omdat elk bericht de volledige toestand draagt en de API
op `versie` ontdubbelt; een intrekking vóór de aanmaak wordt een tombstone.

Omgeving: `BROKER_HOST/PORT/USER/PASSWORD/QUEUE/DLQ`, `API_URL`, `INTERN_API_KEY` (verplicht), `API_TIMEOUT_MS` (5000), `CONTRACTS_DIR`, `PORT` (8091).
`GET /health` (200 als aan de queue gekoppeld), `GET /status` (tellers). Logregels zijn JSON met `messageId`, `correlationId`, `werkorderId`, `poging`, `uitkomst`.

Tests: `npm test`. Bouwen: `docker build -f target-adapter/Dockerfile .` vanuit de repo-root.
