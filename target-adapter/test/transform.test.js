const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { canoniekNaarMonteur, TransformFout } = require('../src/transform');

const golden = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'contracts', 'mapping-tests', 'golden', n + '.canoniek.json'), 'utf8'));

test('001: toegewezen werkorder wordt monteur-model', () => {
  const { werkorderId, body } = canoniekNaarMonteur(golden('001-nieuw-toegewezen'));
  assert.equal(werkorderId, 'WO-1001');
  assert.equal(body.versie, 1);
  assert.equal(body.ingetrokken, false);
  const w = body.werkorder;
  assert.equal(w.status, 'OPEN');            // ASSIGNED -> OPEN
  assert.equal(w.prioriteit, 'HOOG');
  assert.deepEqual(w.monteur, { id: 'M-017', naam: 'J. de Vries' });
  assert.deepEqual(w.locatie, { plaats: 'Breda', spoorEmplacement: 'Breda Noord', coordinaten: { lat: 51.567093, lon: 4.776389 } });
  assert.deepEqual(w.taken[0], { taakId: 'T-1', omschrijving: 'Wissel veiligstellen', gereed: false });
  assert.deepEqual(w.materiaal, [{ artikelnr: 'WM-204', omschrijving: 'Wisselmotor 220V', aantal: 1 }]);
  assert.equal(w.aangemaaktOp, '2026-10-17T08:15:00Z');
  assert.equal('asset' in w, false);
});

test('002: IN_PROGRESS wordt IN_BEHANDELING', () => {
  const { body } = canoniekNaarMonteur(golden('002-wijziging-in-uitvoering'));
  assert.equal(body.werkorder.status, 'IN_BEHANDELING');
  assert.ok(body.versie > 1);
});

test('003: intrekking heeft geen werkorder, wel reden en versie', () => {
  const { werkorderId, body } = canoniekNaarMonteur(golden('003-intrekking-dubbel'));
  assert.equal(werkorderId, 'WO-1002');
  assert.deepEqual(body, { messageId: '5b8e1d90-2f47-4a6c-8c13-9d0e7a4b6f22', correlationId: '5b8e1d90-2f47-4a6c-8c13-9d0e7a4b6f22', versie: 3, ingetrokken: true, reden: 'DUPLICATE' });
});

test('004: niet toegewezen heeft geen monteur', () => {
  const { body } = canoniekNaarMonteur(golden('004-nieuw-niet-toegewezen-winter'));
  assert.equal('monteur' in body.werkorder, false);
  assert.equal(body.werkorder.status, 'OPEN');
});

test('ontbrekende site valt terug op plaats; ontbrekende coördinaten blijven weg', () => {
  const c = golden('001-nieuw-toegewezen');
  c.workOrder.location = { place: 'Breda' };
  const { body } = canoniekNaarMonteur(c);
  assert.deepEqual(body.werkorder.locatie, { plaats: 'Breda', spoorEmplacement: 'Breda' });
});

test('onbekende status geeft TransformFout', () => {
  const c = golden('001-nieuw-toegewezen');
  c.workOrder.status = 'RAAR';
  assert.throws(() => canoniekNaarMonteur(c), TransformFout);
});

// Contracttest tussen de twee kanten: wat de transformatie produceert, moet de werkorder-api accepteren
test('elke golden file levert een body die de validatie van de werkorder-api haalt', () => {
  const { valideerPut } = require('../../werkorder-api/intern');
  for (const n of ['001-nieuw-toegewezen', '002-wijziging-in-uitvoering', '003-intrekking-dubbel', '004-nieuw-niet-toegewezen-winter']) {
    const { werkorderId, body } = canoniekNaarMonteur(golden(n));
    const r = valideerPut(werkorderId, body);
    assert.deepEqual(r.fouten, [], n);
  }
  const c = golden('001-nieuw-toegewezen'); delete c.workOrder.location.lat; delete c.workOrder.location.lon;
  const { werkorderId, body } = canoniekNaarMonteur(c);
  assert.deepEqual(valideerPut(werkorderId, body).fouten, []);
});
