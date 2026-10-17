'use strict';
// TLS naar de broker: alleen een broker met een certificaat dat we vertrouwen en dat bij de hostnaam past, krijgt berichten.
const test = require('node:test');
const assert = require('node:assert/strict');
const { BrokerVerbinding } = require('../src/broker');
const { brokerTlsOpties } = require('../src/omgeving');
const { maakFakeBroker } = require('./fake-broker');
const { maakPki } = require('./tls-helper');

const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
const bericht = () => ({ message_id: 'tls-1', durable: true, body: '{}' });

async function opzet(t, { broker, vertrouw }) {
  const pki = maakPki();
  if (!pki) { t.skip('openssl ontbreekt'); return null; }
  t.after(() => pki.ruim());
  const fake = maakFakeBroker(broker ? { tls: pki[broker] } : {});
  const poort = await fake.start();
  t.after(() => fake.stop());
  const tls = vertrouw ? brokerTlsOpties({ BROKER_TLS_CA: pki[vertrouw].certPad }) : {};
  const verbinding = new BrokerVerbinding({ host: '127.0.0.1', port: poort, user: 'x', password: 'y', adres: 'eam.workorder.v1', tls });
  verbinding.start();
  t.after(() => verbinding.close());
  return { pki, fake, verbinding };
}

test('TLS: verbindt met een vertrouwd certificaat en het bericht komt aan', async (t) => {
  const o = await opzet(t, { broker: 'goed', vertrouw: 'goed' }); if (!o) return;
  const start = Date.now();
  while (!o.verbinding.isVerbonden() && Date.now() - start < 5000) await wacht(25);
  assert.equal(o.verbinding.isVerbonden(), true);
  await o.verbinding.send(bericht(), 2000);
  assert.equal(o.fake.ontvangen.length, 1);
});

test('TLS: een certificaat van een andere CA wordt geweigerd', async (t) => {
  const o = await opzet(t, { broker: 'goed', vertrouw: 'anderen' }); if (!o) return;
  await wacht(1200);
  assert.equal(o.verbinding.isVerbonden(), false);
  assert.equal(o.fake.verbindingen, 0);
  await assert.rejects(() => o.verbinding.send(bericht(), 500), { soort: 'GEEN_VERBINDING' });
});

test('TLS: een certificaat dat niet bij de hostnaam past wordt geweigerd', async (t) => {
  const o = await opzet(t, { broker: 'verkeerdeNaam', vertrouw: 'verkeerdeNaam' }); if (!o) return;
  await wacht(1200);
  assert.equal(o.verbinding.isVerbonden(), false);
  assert.equal(o.fake.verbindingen, 0);
});

test('TLS: een adapter zonder TLS komt niet door een broker die TLS eist', async (t) => {
  const o = await opzet(t, { broker: 'goed', vertrouw: null }); if (!o) return;
  await wacht(1200);
  assert.equal(o.verbinding.isVerbonden(), false);
  assert.equal(o.fake.ontvangen.length, 0);
});

test('TLS-instellingen: uit zonder BROKER_TLS_CA, aan met CA of BROKER_TLS=true, onleesbare CA is een duidelijke fout', () => {
  assert.deepEqual(brokerTlsOpties({}), {});
  assert.deepEqual(brokerTlsOpties({ BROKER_TLS: 'true' }), { transport: 'tls' });
  assert.deepEqual(brokerTlsOpties({ BROKER_TLS: 'false', BROKER_TLS_CA: '/bestaat/niet.pem' }), {});
  assert.deepEqual(brokerTlsOpties({ BROKER_TLS: 'true', BROKER_TLS_SERVERNAME: 'artemis' }), { transport: 'tls', servername: 'artemis' });
  assert.throws(() => brokerTlsOpties({ BROKER_TLS_CA: '/bestaat/niet.pem' }), /BROKER_TLS_CA: kan \/bestaat\/niet\.pem niet lezen/);
});
