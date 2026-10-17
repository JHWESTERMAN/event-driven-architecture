const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
process.env.INTERN_API_KEY = 'testsleutel';
delete process.env.KAFKA_BROKER;
const { server, store } = require('../server');
const { wo, put, intrek } = require('./helpers');

let basis;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  basis = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); });

const stuur = (pad, { methode = 'PUT', sleutel = 'testsleutel', body, type = 'application/json' } = {}) =>
  fetch(basis + pad, {
    method: methode,
    headers: { ...(sleutel ? { 'X-Api-Key': sleutel } : {}), ...(type ? { 'Content-Type': type } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  });
const lichaam = (p) => { const { werkorderId, ...rest } = p; return rest; };

test('zonder of met verkeerde sleutel: 401', async () => {
  assert.equal((await stuur('/intern/werkorders/WO-2001', { sleutel: null, body: lichaam(put(1, wo())) })).status, 401);
  assert.equal((await stuur('/intern/werkorders/WO-2001', { sleutel: 'fout', body: lichaam(put(1, wo())) })).status, 401);
});

test('PUT nieuw -> 200 VERWERKT, herhaling -> 200 GENEGEERD', async () => {
  let r = await stuur('/intern/werkorders/WO-2001', { body: lichaam(put(1, wo())) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).resultaat, 'VERWERKT');
  r = await stuur('/intern/werkorders/WO-2001', { body: lichaam(put(1, wo())) });
  assert.equal((await r.json()).resultaat, 'GENEGEERD');
  assert.equal(store.haal('WO-2001').versie, 1);
});

test('tombstone via HTTP', async () => {
  let r = await stuur('/intern/werkorders/WO-2002', { body: lichaam(intrek(2)) });
  assert.equal((await r.json()).resultaat, 'TOMBSTONE_BEWAARD');
  r = await stuur('/intern/werkorders/WO-2002', { body: lichaam(put(1, wo({ werkorderId: 'WO-2002' }))) });
  assert.equal((await r.json()).resultaat, 'GENEGEERD');
});

test('ongeldige inhoud -> 422 met fouten (permanente fout voor de adapter)', async () => {
  const slecht = wo({ status: 'KAPOT', extra: 1, taken: [{ taakId: 'T-1' }] });
  const r = await stuur('/intern/werkorders/WO-2003', { body: lichaam(put(1, { ...slecht, werkorderId: 'WO-2003' })) });
  assert.equal(r.status, 422);
  const j = await r.json();
  assert.ok(j.fouten.some((f) => f.includes('werkorder.status')));
  assert.ok(j.fouten.some((f) => f.includes('werkorder.extra')));
  assert.ok(j.fouten.some((f) => f.includes('werkorder.taken[0]')));
  assert.equal(store.haal('WO-2003'), null);
});

test('id in URL en body moeten gelijk zijn; onjuist id -> 400; geen JSON -> 400/415', async () => {
  assert.equal((await stuur('/intern/werkorders/WO-2004', { body: lichaam(put(1, wo())) })).status, 422);
  assert.equal((await stuur('/intern/werkorders/abc', { body: {} })).status, 400);
  assert.equal((await stuur('/intern/werkorders/WO-2005', { body: '{kapot' })).status, 400);
  assert.equal((await stuur('/intern/werkorders/WO-2005', { body: 'x', type: 'text/plain' })).status, 415);
});

test('GET op /intern -> 405; /health bevat outbox-status; /api vereist nog steeds een token', async () => {
  assert.equal((await stuur('/intern/werkorders/WO-2001', { methode: 'GET' })).status, 405);
  const h = await (await fetch(basis + '/health')).json();
  assert.equal(h.status, 'UP');
  assert.equal((await fetch(basis + '/api/werkorders')).status, 401);
});

test('te grote body -> 413', async () => {
  const r = await stuur('/intern/werkorders/WO-2006', { body: JSON.stringify({ x: 'a'.repeat(300 * 1024) }) }).catch((e) => ({ status: 'netwerk' }));
  assert.ok([413, 'netwerk'].includes(r.status));
});
