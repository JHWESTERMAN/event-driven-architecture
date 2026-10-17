const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { start } = require('../src/server');
const { maakFakeApi, maakFakeBroker, wacht } = require('./helpers');

const contractsDir = path.join(__dirname, '..', '..', 'contracts');
const golden = (n) => fs.readFileSync(path.join(contractsDir, 'mapping-tests', 'golden', n + '.canoniek.json'), 'utf8');
const ongeldigCanoniek = (n) => fs.readFileSync(path.join(contractsDir, 'canoniek', 'ongeldig', n), 'utf8');
const brokerBericht = (tekst, extra = {}) => ({ message_id: 'm-1', durable: true, application_properties: { workOrderId: 'WO-1001' }, body: tekst, ...extra });

let api, broker, app, apiPoort, brokerPoort;
const logs = [];

test.before(async () => {
  api = maakFakeApi(); broker = maakFakeBroker();
  apiPoort = await api.start(); brokerPoort = await broker.start();
  app = start({
    poort: 0, contractsDir,
    broker: { host: '127.0.0.1', port: brokerPoort, user: 'x', password: 'y', queue: 'eam.workorder.v1', dlq: 'eam.workorder.v1.dlq' },
    api: { baseUrl: `http://127.0.0.1:${apiPoort}`, apiKey: 'sleutel', timeoutMs: 500 }
  }, (r) => logs.push(r));
  await wacht(() => app.consument.isVerbonden());
});
test.after(async () => { app.stop(); await api.stop(); await broker.stop(); });

const reset = () => { broker.uitkomsten.length = 0; broker.dlq.length = 0; api.verzoeken.length = 0; api.status = 200; api.vertraging = 0; broker.dlqGedrag = 'accepteer'; };
const naUitkomst = async (n = 1) => { await wacht(() => broker.uitkomsten.length >= n); return broker.uitkomsten; };

test('geldig bericht: PUT met sleutel naar de API, daarna accepted', async () => {
  reset();
  broker.zet(brokerBericht(golden('001-nieuw-toegewezen')));
  const [u] = await naUitkomst();
  assert.equal(u.soort, 'accepted');
  assert.equal(api.verzoeken.length, 1);
  assert.equal(api.verzoeken[0].url, '/intern/werkorders/WO-1001');
  assert.equal(api.verzoeken[0].sleutel, 'sleutel');
  assert.equal(api.verzoeken[0].body.werkorder.status, 'OPEN');
  assert.equal(broker.dlq.length, 0);
});

test('API vraagt om tijd (time-out): bericht wordt pas bevestigd als de API antwoordt, bij time-out mislukte aflevering', async () => {
  reset();
  api.vertraging = 1500;      // langer dan API_TIMEOUT 500 ms
  broker.zet(brokerBericht(golden('001-nieuw-toegewezen')));
  const [u] = await naUitkomst();
  assert.equal(u.soort, 'modified');
  assert.equal(u.params.delivery_failed, true);
  assert.equal(broker.dlq.length, 0);
});

test('API 503: mislukte aflevering (broker herlevert)', async () => {
  reset();
  api.status = 503;
  broker.zet(brokerBericht(golden('002-wijziging-in-uitvoering')));
  const [u] = await naUitkomst();
  assert.equal(u.soort, 'modified');
  assert.equal(u.params.delivery_failed, true);
});

test('API 422: naar de DLQ met reden, origineel wordt bevestigd', async () => {
  reset();
  api.status = 422; api.antwoord = { fouten: ['x'] };
  broker.zet(brokerBericht(golden('001-nieuw-toegewezen')));
  const [u] = await naUitkomst();
  assert.equal(u.soort, 'accepted');
  assert.equal(broker.dlq.length, 1);
  const p = broker.dlq[0].application_properties;
  assert.equal(p.dlqReden, 'API_AFGEWEZEN');
  assert.match(p.dlqDetail, /422/);
  assert.equal(p.dlqBron, 'eam.workorder.v1');
  assert.equal(p.workOrderId, 'WO-1001');
  assert.equal(broker.dlq[0].message_id, 'm-1');
  api.antwoord = { resultaat: 'VERWERKT', versie: 1 };
});

test('geen JSON en ongeldig canoniek bericht: DLQ zonder API-aanroep', async () => {
  reset();
  broker.zet(brokerBericht('dit is geen json'));
  broker.zet(brokerBericht(ongeldigCanoniek('01-assigned-zonder-assignee.json') ));
  await naUitkomst(2);
  assert.equal(api.verzoeken.length, 0);
  assert.deepEqual(broker.dlq.map((m) => m.application_properties.dlqReden), ['GEEN_JSON', 'CANONIEK_ONGELDIG']);
  assert.deepEqual(broker.uitkomsten.map((u) => u.soort), ['accepted', 'accepted']);
});

test('DLQ weigert het bericht: origineel wordt niet bevestigd maar mislukt (niets gaat verloren)', async () => {
  reset();
  broker.dlqGedrag = 'wijs-af';
  broker.zet(brokerBericht('geen json'));
  const [u] = await naUitkomst();
  assert.equal(u.soort, 'modified');
  assert.equal(u.params.delivery_failed, true);
});

test('intrekking gaat als ingetrokken=true zonder werkorder', async () => {
  reset();
  broker.zet(brokerBericht(golden('003-intrekking-dubbel')));
  await naUitkomst();
  assert.equal(api.verzoeken[0].body.ingetrokken, true);
  assert.equal('werkorder' in api.verzoeken[0].body, false);
  assert.equal(api.verzoeken[0].url, '/intern/werkorders/WO-1002');
});

test('berichten worden één voor één verwerkt, in volgorde', async () => {
  reset();
  api.vertraging = 60;
  broker.zet(brokerBericht(golden('001-nieuw-toegewezen'), { message_id: 'a' }));
  broker.zet(brokerBericht(golden('002-wijziging-in-uitvoering'), { message_id: 'b' }));
  await naUitkomst(2);
  assert.deepEqual(api.verzoeken.map((v) => v.body.versie), [1, 2]);
});

test('/health is 200 zolang de receiver open is; logregels bevatten messageId en correlationId', async () => {
  const poort = app.server.address().port;
  assert.equal((await fetch(`http://127.0.0.1:${poort}/health`)).status, 200);
  const regel = logs.find((l) => l.uitkomst === 'bevestigd');
  assert.ok(regel.messageId && regel.correlationId && regel.werkorderId);
});
