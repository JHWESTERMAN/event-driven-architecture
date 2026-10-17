# werkorder-api

Leest (GET `/api/...`, met Keycloak-token), schrijft (PUT `/intern/werkorders/{id}`, met `X-Api-Key`) en publiceert events via een outbox.

| Bestand | Rol |
|---|---|
| `server.js` | HTTP, OIDC-validatie, routes |
| `db.js` | SQLite-opslag, versie-idempotentie, tombstones, outbox in dezelfde transactie |
| `intern.js` | validatie van de PUT-body |
| `outbox.js` / `publisher.js` | relay naar Kafka (at-least-once) / kafkajs-adapter |
| `seed.js` | startdata (WO-1001..1003) voor een lege database |

Omgeving: `PORT`, `DB_PATH` (default `./data/werkorders.db`, `:memory:` in tests), `INTERN_API_KEY` (leeg = interne API uit),
`KAFKA_BROKER` (leeg = relay uit, events blijven in de outbox), `TOPIC_EVENTS`, `TOPIC_NOTIFICATIES`, `OUTBOX_INTERVAL_MS`, `OIDC_*`.

Tests: `npm test` (Node 22.13 of hoger; gebruikt `node:sqlite`).
