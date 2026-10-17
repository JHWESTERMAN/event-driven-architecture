'use strict';
// TLS naar de broker: de consument ontvangt alleen van een broker met een vertrouwd certificaat dat bij de hostnaam past.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Consument } = require('../src/consument');
const { brokerTlsOpties } = require('../src/omgeving');
const { maakFakeBroker } = require('./helpers');
const { maakPki } = require('./tls-helper');

const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

async function opzet(t, { broker, vertrouw }) {
  const pki = maakPki();
  if (!pki) { t.skip('openssl ontbreekt'); return null; }
  t.after(() => pki.ruim());
  const fake = maakFakeBroker(broker ? { tls: pki[broker] } : {});
  const poort = await fake.start();
  t.after(() => fake.stop());
  const tls = vertrouw ? brokerTlsOpties({ BROKER_TLS_CA: pki[vertrouw].certPad }) : {};
  const consument = new Consument({
    host: '127.0.0.1', port: poort, user: 'x', password: 'y', tls, queue: 'eam.workorder.v1', dlq: 'eam.workorder.v1.dlq',
    beslis: async () => ({ actie: 'ACCEPT', messageId: 'tls-1' })
  });
  consument.start();
  t.after(() => consument.close());
  return { fake, consument };
}

test('TLS: de consument ontvangt en bevestigt via een vertrouwd certificaat', async (t) => {
  const o = await opzet(t, { broker: 'goed', vertrouw: 'goed' }); if (!o) return;
  const start = Date.now();
  while (!o.consument.isVerbonden() && Date.now() - start < 5000) await wacht(25);
  assert.equal(o.consument.isVerbonden(), true);
  o.fake.zet({ message_id: 'tls-1', durable: true, body: '{}' });
  const einde = Date.now() + 3000;
  while (!o.fake.uitkomsten.length && Date.now() < einde) await wacht(25);
  assert.deepEqual(o.fake.uitkomsten.map((u) => u.soort), ['accepted']);
});

test('TLS: een certificaat van een andere CA wordt geweigerd', async (t) => {
  const o = await opzet(t, { broker: 'goed', vertrouw: 'anderen' }); if (!o) return;
  await wacht(1200);
  assert.equal(o.consument.isVerbonden(), false);
});

test('TLS: een certificaat dat niet bij de hostnaam past wordt geweigerd', async (t) => {
  const o = await opzet(t, { broker: 'verkeerdeNaam', vertrouw: 'verkeerdeNaam' }); if (!o) return;
  await wacht(1200);
  assert.equal(o.consument.isVerbonden(), false);
});

test('TLS: zonder TLS-instelling komt de consument niet door een broker die TLS eist', async (t) => {
  const o = await opzet(t, { broker: 'goed', vertrouw: null }); if (!o) return;
  await wacht(1200);
  assert.equal(o.consument.isVerbonden(), false);
});
