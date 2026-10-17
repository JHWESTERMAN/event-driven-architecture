const test = require('node:test');
const assert = require('node:assert/strict');
const { maakStore } = require('../db');
const { WERKORDERS } = require('../seed');
const { wo, put, intrek } = require('./helpers');

const nieuweStore = (seed = null) => maakStore({ pad: ':memory:', seed });
const topics = (s) => s.outboxOpen(100).map((r) => `${r.topic}:${r.payload.eventType || 'notificatie'}`);

test('seed vult een lege database, zonder events', () => {
  const s = nieuweStore(WERKORDERS);
  assert.equal(s.aantalWerkorders(), 3);
  assert.equal(s.haal('WO-1001').versie, 1);
  assert.equal(s.lijstVan('M-017').length, 2);
  assert.equal(s.outboxAantalOpen(), 0);
});

test('nieuwe werkorder: opgeslagen + domeinevent + notificatie in de outbox', () => {
  const s = nieuweStore();
  const r = s.verwerk(put(1, wo()));
  assert.deepEqual(r, { resultaat: 'VERWERKT', versie: 1 });
  assert.equal(s.haal('WO-2001').ingetrokken, false);
  const regels = s.outboxOpen(10);
  assert.equal(regels.length, 2);
  const ev = regels.find((x) => x.topic === 'werkorder-events').payload;
  assert.equal(ev.eventType, 'werkorder.aangemaakt');
  assert.equal(ev.correlationId, 'c-1');
  assert.equal(regels[0].sleutel, 'WO-2001');
  const n = regels.find((x) => x.topic === 'werkorder-notificaties').payload;
  assert.equal(n.monteurId, 'M-017');
  assert.match(n.bericht, /Nieuwe werkorder WO-2001/);
});

test('herhaald bericht (zelfde versie) is een no-op en maakt geen events', () => {
  const s = nieuweStore();
  s.verwerk(put(1, wo()));
  const voor = s.outboxAantalOpen();
  const r = s.verwerk(put(1, wo()));
  assert.equal(r.resultaat, 'GENEGEERD');
  assert.equal(s.outboxAantalOpen(), voor);
});

test('lagere versie wordt genegeerd, hogere gewijzigd met statusnotificatie', () => {
  const s = nieuweStore();
  s.verwerk(put(2, wo()));
  assert.equal(s.verwerk(put(1, wo({ omschrijving: 'oud' }))).resultaat, 'GENEGEERD');
  assert.equal(s.haal('WO-2001').omschrijving, 'Storing wissel 214');
  s.outboxVerzonden(s.outboxOpen(10).map((r) => r.id));
  const r = s.verwerk(put(3, wo({ status: 'IN_BEHANDELING' })));
  assert.equal(r.resultaat, 'VERWERKT');
  const regels = s.outboxOpen(10);
  const ev = regels.find((x) => x.topic === 'werkorder-events').payload;
  assert.equal(ev.eventType, 'werkorder.gewijzigd');
  assert.equal(ev.vorigeStatus, 'OPEN');
  assert.deepEqual(ev.gewijzigdeVelden, ['status']);
  assert.match(regels.find((x) => x.topic === 'werkorder-notificaties').payload.bericht, /status IN_BEHANDELING/);
});

test('versie omhoog zonder inhoudelijke wijziging: opgeslagen, maar geen events', () => {
  const s = nieuweStore();
  s.verwerk(put(1, wo()));
  s.outboxVerzonden(s.outboxOpen(10).map((r) => r.id));
  assert.equal(s.verwerk(put(2, wo())).resultaat, 'VERWERKT');
  assert.equal(s.haal('WO-2001').versie, 2);
  assert.equal(s.outboxAantalOpen(), 0);
});

test('herplaatsing: oude monteur en nieuwe monteur krijgen elk een notificatie', () => {
  const s = nieuweStore();
  s.verwerk(put(1, wo()));
  s.outboxVerzonden(s.outboxOpen(10).map((r) => r.id));
  s.verwerk(put(2, wo({ monteur: { id: 'M-022', naam: 'S. Jansen' } })));
  const n = s.outboxOpen(10).filter((x) => x.topic === 'werkorder-notificaties').map((x) => [x.payload.monteurId, x.payload.bericht]);
  assert.equal(n.length, 2);
  assert.match(n.find(([m]) => m === 'M-017')[1], /niet langer aan jou/);
  assert.match(n.find(([m]) => m === 'M-022')[1], /aan jou toegewezen/);
  assert.equal(s.lijstVan('M-017').length, 0);
  assert.equal(s.lijstVan('M-022').length, 1);
});

test('intrekking van bestaande werkorder: AFGEROND + ingetrokken + event', () => {
  const s = nieuweStore();
  s.verwerk(put(1, wo()));
  s.outboxVerzonden(s.outboxOpen(10).map((r) => r.id));
  const r = s.verwerk(intrek(2));
  assert.equal(r.resultaat, 'VERWERKT');
  const d = s.haal('WO-2001');
  assert.equal(d.status, 'AFGEROND');
  assert.equal(d.ingetrokken, true);
  assert.equal(d.redenIntrekking, 'DUPLICATE');
  assert.deepEqual(topics(s).sort(), ['werkorder-events:werkorder.ingetrokken', 'werkorder-notificaties:notificatie']);
});

test('tombstone: intrekking vóór het nieuw-bericht (bron-retry herordent), daarna wordt versie 1 genegeerd', () => {
  const s = nieuweStore();
  assert.equal(s.verwerk(intrek(2)).resultaat, 'TOMBSTONE_BEWAARD');
  assert.equal(s.haal('WO-2001'), null);
  assert.equal(s.tombstone('WO-2001').versie, 2);
  assert.equal(s.verwerk(put(1, wo())).resultaat, 'GENEGEERD');
  assert.equal(s.haal('WO-2001'), null);
  assert.equal(s.outboxAantalOpen(), 0);
});

test('ingetrokken werkorder wordt niet meer gewijzigd door een oudere of nieuwere update zonder heropenen', () => {
  const s = nieuweStore();
  s.verwerk(put(1, wo()));
  s.verwerk(intrek(2));
  assert.equal(s.verwerk(put(3, wo({ omschrijving: 'x' }))).resultaat, 'GENEGEERD');
  assert.equal(s.haal('WO-2001').ingetrokken, true);
});

test('hogere versie na een tombstone heropent (bron heeft kennelijk opnieuw aangemaakt)', () => {
  const s = nieuweStore();
  s.verwerk(intrek(2));
  assert.equal(s.verwerk(put(3, wo())).resultaat, 'VERWERKT');
  assert.equal(s.tombstone('WO-2001'), null);
});

test('outbox: fout in de transactie draait alles terug', () => {
  const s = nieuweStore();
  assert.throws(() => s.verwerk(put(1, wo({ status: null }))));  // NOT NULL-schending in werkorders
  assert.equal(s.haal('WO-2001'), null);
  assert.equal(s.outboxAantalOpen(), 0);
});
