const test = require('node:test');
const assert = require('node:assert/strict');
const { maakStore } = require('../db');
const { maakRelay } = require('../outbox');
const { wo, put } = require('./helpers');
const stil = { error() {}, log() {} };

test('relay publiceert in volgorde en markeert als verzonden', async () => {
  const s = maakStore({ pad: ':memory:' });
  s.verwerk(put(1, wo()));
  s.verwerk(put(2, wo({ status: 'IN_BEHANDELING' })));
  const verstuurd = [];
  const relay = maakRelay({ store: s, publiceer: async (b) => verstuurd.push(...b), log: stil, batch: 2 });
  assert.equal(await relay.eenRonde(), 4);
  assert.equal(s.outboxAantalOpen(), 0);
  const events = verstuurd.filter((b) => b.topic === 'werkorder-events').map((b) => JSON.parse(b.value).versie);
  assert.deepEqual(events, [1, 2]);
  assert.ok(verstuurd.every((b) => b.key === 'WO-2001'));
  assert.equal(await relay.eenRonde(), 0);
});

test('Kafka down: regels blijven staan en gaan later alsnog (at-least-once)', async () => {
  const s = maakStore({ pad: ':memory:' });
  s.verwerk(put(1, wo()));
  let stuk = true; const ontvangen = [];
  const relay = maakRelay({ store: s, publiceer: async (b) => { if (stuk) throw new Error('broker weg'); ontvangen.push(...b); }, log: stil });
  assert.equal(await relay.eenRonde(), 0);
  assert.equal(relay.status().open, 2);
  assert.equal(relay.status().laatsteFout, 'broker weg');
  stuk = false;
  assert.equal(await relay.eenRonde(), 2);
  assert.equal(relay.status().laatsteFout, null);
  assert.equal(ontvangen.length, 2);
});

test('notificatie voldoet aan het bestaande contract van de ws-microservice', async () => {
  const Ajv = (() => { try { return require('../../contracts/node_modules/ajv/dist/2020'); } catch { return null; } })();
  const s = maakStore({ pad: ':memory:' });
  s.verwerk(put(1, wo()));
  const n = s.outboxOpen(10).find((r) => r.topic === 'werkorder-notificaties').payload;
  assert.deepEqual(Object.keys(n).sort(), ['bericht', 'eventId', 'monteurId', 'status', 'werkorderId']);
  if (Ajv) {
    const ajv = new (Ajv.default || Ajv)({ strict: true });
    const schema = require('../../contracts/monteur/werkorder-notificatie.schema.json');
    assert.ok(ajv.compile(schema)(n));
  }
});
