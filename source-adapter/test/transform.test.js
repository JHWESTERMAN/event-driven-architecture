'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bronNaarCanoniek, lokaalNaarUtc, BronFout } = require('../src/transform');
const { rdNaarWgs84 } = require('../src/rd');
const referentie = require('../../contracts/tools/rd');

const goldenDir = path.join(__dirname, '..', '..', 'contracts', 'mapping-tests', 'golden');
const namen = [...new Set(fs.readdirSync(goldenDir).map((f) => f.split('.')[0]))].sort();
const lees = (naam, soort) => JSON.parse(fs.readFileSync(path.join(goldenDir, `${naam}.${soort}.json`), 'utf8'));

for (const naam of namen) {
  test(`golden ${naam}: bron wordt exact het verwachte canonieke bericht`, () => {
    assert.deepEqual(bronNaarCanoniek(lees(naam, 'bron')), lees(naam, 'canoniek'));
  });
}

test('de golden files zijn er (anders test deze suite niets)', () => {
  assert.ok(namen.length >= 4, `verwacht minstens 4 golden pairs, gevonden ${namen.length}`);
});

test('X-Correlation-Id wint van berichtId', () => {
  const r = bronNaarCanoniek(lees(namen[0], 'bron'), { correlationId: 'ketting-42' });
  assert.equal(r.envelope.correlationId, 'ketting-42');
  assert.equal(r.envelope.messageId, lees(namen[0], 'bron').kop.berichtId);
});

test('de transformatie verandert de invoer niet', () => {
  const bron = lees(namen[0], 'bron');
  const voor = JSON.stringify(bron);
  bronNaarCanoniek(bron);
  assert.equal(JSON.stringify(bron), voor);
});

test('rd.js in de adapter rekent hetzelfde uit als de referentie in contracts/tools', () => {
  for (let x = 20000; x <= 280000; x += 20000) {
    for (let y = 310000; y <= 610000; y += 30000) assert.deepEqual(rdNaarWgs84(x, y), referentie.rdNaarWgs84(x, y), `RD ${x},${y}`);
  }
});

test('tijd: zomertijd (UTC+2) en wintertijd (UTC+1)', () => {
  assert.equal(lokaalNaarUtc('17-10-2026 10:15:00'), '2026-10-17T08:15:00Z');
  assert.equal(lokaalNaarUtc('02-11-2026 09:00:00'), '2026-11-02T08:00:00Z');
  assert.equal(lokaalNaarUtc('01-01-2027 00:00:00'), '2026-12-31T23:00:00Z');
});

test('tijd: overgang naar zomertijd, het uur 02:00-03:00 bestaat niet (29 maart 2026)', () => {
  assert.equal(lokaalNaarUtc('29-03-2026 01:59:59'), '2026-03-29T00:59:59Z');
  assert.equal(lokaalNaarUtc('29-03-2026 03:00:00'), '2026-03-29T01:00:00Z');
  assert.throws(() => lokaalNaarUtc('29-03-2026 02:30:00'), BronFout);
});

test('tijd: overgang naar wintertijd, het uur 02:00-03:00 komt twee keer voor (25 oktober 2026)', () => {
  assert.equal(lokaalNaarUtc('25-10-2026 01:59:59'), '2026-10-24T23:59:59Z');
  // dubbelzinnig: wij lezen dit als de tweede keer (wintertijd)
  assert.equal(lokaalNaarUtc('25-10-2026 02:30:00'), '2026-10-25T01:30:00Z');
  assert.equal(lokaalNaarUtc('25-10-2026 03:00:00'), '2026-10-25T02:00:00Z');
});

test('tijd: een datum die niet bestaat is een BronFout', () => {
  assert.throws(() => lokaalNaarUtc('31-02-2026 10:00:00'), BronFout);
  assert.throws(() => lokaalNaarUtc('2026-10-17T10:15:00Z'), BronFout);
});
