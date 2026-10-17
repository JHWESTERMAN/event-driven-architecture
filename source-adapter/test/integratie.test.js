'use strict';
// Integratietest: HTTP-ingang + validatie + transformatie + AMQP naar een nagebootste broker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { maakServer, configUitOmgeving } = require('../src/server');
const { laadValidators } = require('../src/validate');
const { BrokerVerbinding } = require('../src/broker');
const { maakFakeBroker } = require('./fake-broker');

const contracts = path.join(__dirname, '..', '..', 'contracts');
const leesJson = (...p) => JSON.parse(fs.readFileSync(path.join(contracts, ...p), 'utf8'));
const golden = (naam, soort) => leesJson('mapping-tests', 'golden', `${naam}.${soort}.json`);
const GOLDEN = ['001-nieuw-toegewezen', '002-wijziging-in-uitvoering', '003-intrekking-dubbel', '004-nieuw-niet-toegewezen-winter'];
const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
async function wachtTot(voorwaarde, ms = 8000, wat = 'voorwaarde') {
  const start = Date.now();
  while (!voorwaarde()) {
    if (Date.now() - start > ms) throw new Error(`time-out na ${ms} ms: ${wat}`);
    await wacht(25);
  }
}

async function opzet({ sendTimeoutMs = 400 } = {}) {
  const logs = [];
  const log = (r) => logs.push(r);
  const fake = maakFakeBroker();
  const poort = await fake.start();
  const broker = new BrokerVerbinding({ host: '127.0.0.1', port: poort, user: 'x', password: 'y', adres: 'eam.workorder.v1', log });
  broker.start();
  await wachtTot(() => broker.isVerbonden(), 8000, 'adapter verbonden met de fake broker');
  const config = { ...configUitOmgeving({}), queue: 'eam.workorder.v1', sendTimeoutMs, contractsDir: contracts };
  const server = maakServer({ config, broker, validators: laadValidators(contracts), log });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = async (body, headers = {}) => {
    const r = await fetch(`${url}/werkopdracht`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: r.status, headers: r.headers, json: await r.json() };
  };
  const sluit = async () => { broker.close(); await new Promise((r) => server.close(r)); await fake.stop().catch(() => {}); };
  return { fake, broker, server, url, post, logs, poort, sluit };
}

test('happy path: 202 pas na accepted, bericht op de queue met de juiste eigenschappen', async (t) => {
  const o = await opzet(); t.after(o.sluit);
  const bron = golden(GOLDEN[0], 'bron');
  const r = await o.post(bron);
  assert.equal(r.status, 202);
  assert.deepEqual(r.json, { status: 'accepted', messageId: bron.kop.berichtId, correlationId: bron.kop.berichtId, workOrderId: 'WO-1001', queue: 'eam.workorder.v1' });

  assert.equal(o.fake.ontvangen.length, 1);
  const { adres, bericht } = o.fake.ontvangen[0];
  assert.equal(adres, 'eam.workorder.v1');
  assert.equal(bericht.message_id, bron.kop.berichtId);
  assert.equal(bericht.subject, 'eam.workorder.created');
  assert.equal(bericht.group_id, 'WO-1001');
  assert.equal(bericht.durable, true);
  assert.equal(bericht.content_type, 'application/json');
  assert.equal(bericht.application_properties._AMQ_DUPL_ID, bron.kop.berichtId);
  assert.equal(bericht.application_properties.schemaVersion, '1.0');
  assert.equal(typeof bericht.body, 'string', 'het lichaam is tekst (JSON), geen binair');
  assert.deepEqual(JSON.parse(bericht.body), golden(GOLDEN[0], 'canoniek'));
});

test('elke golden pair komt als het verwachte canonieke bericht op de queue', async (t) => {
  const o = await opzet(); t.after(o.sluit);
  for (const naam of GOLDEN) assert.equal((await o.post(golden(naam, 'bron'))).status, 202, naam);
  assert.equal(o.fake.ontvangen.length, GOLDEN.length);
  GOLDEN.forEach((naam, i) => assert.deepEqual(JSON.parse(o.fake.ontvangen[i].bericht.body), golden(naam, 'canoniek'), naam));
});

test('X-Correlation-Id wordt overgenomen; een ongeldige header wordt genegeerd', async (t) => {
  const o = await opzet(); t.after(o.sluit);
  const bron = golden(GOLDEN[0], 'bron');
  const r1 = await o.post(bron, { 'X-Correlation-Id': 'ketting-42' });
  assert.equal(r1.json.correlationId, 'ketting-42');
  const r2 = await o.post(bron, { 'X-Correlation-Id': 'x'.repeat(100) });
  assert.equal(r2.json.correlationId, bron.kop.berichtId);
});

test('herhaling door de bron: zelfde berichtId, zelfde _AMQ_DUPL_ID (de broker ontdubbelt)', async (t) => {
  const o = await opzet(); t.after(o.sluit);
  const bron = golden(GOLDEN[0], 'bron');
  assert.equal((await o.post(bron)).status, 202);
  assert.equal((await o.post(bron)).status, 202);
  assert.equal(o.fake.ontvangen.length, 2);
  assert.equal(o.fake.ontvangen[0].bericht.application_properties._AMQ_DUPL_ID, o.fake.ontvangen[1].bericht.application_properties._AMQ_DUPL_ID);
});

test('ongeldige bronberichten: 422 met reden en niets op de queue', async (t) => {
  const o = await opzet(); t.after(o.sluit);
  const dir = path.join(contracts, 'bron', 'ongeldig');
  const bestanden = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  assert.ok(bestanden.length >= 10);
  for (const f of bestanden) {
    const r = await o.post(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    assert.equal(r.status, 422, f);
    assert.ok(Array.isArray(r.json.details) && r.json.details.length > 0, `${f}: details ontbreken`);
    assert.ok(r.json.details.every((d) => d.pad && d.melding), `${f}: elk detail heeft pad en melding`);
  }
  assert.equal(o.fake.ontvangen.length, 0, 'er mag niets op de broker staan');
});

test('een tijdstip dat niet bestaat haalt het schema maar wordt bij de vertaling afgewezen (422)', async (t) => {
  const o = await opzet(); t.after(o.sluit);
  const bron = golden(GOLDEN[0], 'bron');
  bron.kop.verzondenOp = '29-03-2026 02:30:00';       // het overgeslagen uur bij de overgang naar zomertijd
  const r = await o.post(bron);
  assert.equal(r.status, 422);
  assert.match(r.json.details[0].melding, /bestaat niet/);
  assert.equal(o.fake.ontvangen.length, 0);
});

test('geen geldige JSON: 400. Geen application/json: 415. Te groot: 413. Onbekend pad: 404', async (t) => {
  const o = await opzet(); t.after(o.sluit);
  assert.equal((await o.post('{kapot')).status, 400);
  const r415 = await fetch(`${o.url}/werkopdracht`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hallo' });
  assert.equal(r415.status, 415);
  const r413 = await fetch(`${o.url}/werkopdracht`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(300 * 1024) }).then((r) => r.status, () => 413);
  assert.equal(r413, 413);
  assert.equal((await fetch(`${o.url}/anders`)).status, 404);
  assert.equal(o.fake.ontvangen.length, 0);
});

test('broker wijst af: 503 met Retry-After, de reden komt in de log', async (t) => {
  const o = await opzet(); t.after(o.sluit);
  o.fake.gedrag = 'wijs-af';
  const r = await o.post(golden(GOLDEN[0], 'bron'));
  assert.equal(r.status, 503);
  assert.equal(r.json.reden, 'AFGEWEZEN');
  assert.equal(r.headers.get('retry-after'), '5');
  const regel = o.logs.find((l) => l.stap === 'verzonden' && l.uitkomst === 'mislukt');
  assert.ok(regel && /unauthorized-access/.test(regel.reden), 'reden van de broker staat in de log');
});

test('broker geeft vrij (released): 503', async (t) => {
  const o = await opzet(); t.after(o.sluit);
  o.fake.gedrag = 'geef-vrij';
  const r = await o.post(golden(GOLDEN[0], 'bron'));
  assert.equal(r.status, 503);
  assert.equal(r.json.reden, 'VRIJGEGEVEN');
});

test('broker antwoordt niet binnen de time-out: 503, geen 202', async (t) => {
  const o = await opzet({ sendTimeoutMs: 300 }); t.after(o.sluit);
  o.fake.gedrag = 'negeer';
  const start = Date.now();
  const r = await o.post(golden(GOLDEN[0], 'bron'));
  assert.equal(r.status, 503);
  assert.equal(r.json.reden, 'TIMEOUT');
  assert.ok(Date.now() - start >= 280);
  assert.equal(o.fake.ontvangen.length, 1, 'het bericht is wel aangekomen maar nooit bevestigd; de bron herhaalt, de broker ontdubbelt');
});

test('brokeruitval: 503 en /health DOWN; na herstel herverbindt de adapter vanzelf en slaagt een herhaling', async (t) => {
  const o = await opzet(); t.after(o.sluit);
  const bron = golden(GOLDEN[0], 'bron');
  assert.equal((await o.post(bron)).status, 202);
  assert.equal((await fetch(`${o.url}/health`)).status, 200);

  await o.fake.stop();
  await wachtTot(() => !o.broker.isVerbonden(), 5000, 'adapter merkt de uitval');
  const r = await o.post(bron);
  assert.equal(r.status, 503);
  assert.equal(r.json.reden, 'GEEN_VERBINDING');
  assert.equal((await fetch(`${o.url}/health`)).status, 503);

  await o.fake.start(o.poort);
  await wachtTot(() => o.broker.isVerbonden(), 15000, 'adapter herverbindt');
  assert.equal((await fetch(`${o.url}/health`)).status, 200);
  assert.equal((await o.post(bron)).status, 202);
  assert.ok(o.fake.ontvangen.length >= 2);
});

test('logregels volgen een bericht van ontvangst tot verzending, met dezelfde messageId', async (t) => {
  const o = await opzet(); t.after(o.sluit);
  const bron = golden(GOLDEN[0], 'bron');
  await o.post(bron);
  const stappen = o.logs.filter((l) => l.messageId === bron.kop.berichtId).map((l) => `${l.stap}:${l.uitkomst}`);
  assert.deepEqual(stappen, ['ontvangen:ok', 'bronvalidatie:ok', 'transformatie:ok', 'canonieke-validatie:ok', 'verzonden:ok']);
});
