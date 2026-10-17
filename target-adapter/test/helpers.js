const http = require('http');
const rhea = require('rhea');

// Nagebootste werkorder-api: neemt PUT /intern/... aan en antwoordt met `status`/`antwoord` na `vertraging` ms
function maakFakeApi() {
  const fake = { verzoeken: [], status: 200, antwoord: { resultaat: 'VERWERKT', versie: 1 }, vertraging: 0 };
  fake.server = http.createServer((req, res) => {
    const delen = [];
    req.on('data', (d) => delen.push(d));
    req.on('end', () => {
      fake.verzoeken.push({ method: req.method, url: req.url, sleutel: req.headers['x-api-key'], body: JSON.parse(Buffer.concat(delen).toString() || 'null') });
      setTimeout(() => {
        try { res.writeHead(fake.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(fake.antwoord)); } catch (_) { /* client weg */ }
      }, fake.vertraging);
    });
  });
  fake.start = () => new Promise((r) => fake.server.listen(0, '127.0.0.1', () => r(fake.server.address().port)));
  fake.stop = () => new Promise((r) => { fake.server.closeAllConnections?.(); fake.server.close(r); });
  return fake;
}

// Nagebootste broker: levert berichten aan de receiver zodra die krediet geeft en noteert hoe de adapter ze afhandelt.
// Ontvangt ook de berichten die de adapter naar de DLQ stuurt.
function maakFakeBroker({ tls } = {}) {
  const container = rhea.create_container({ autoaccept: false });
  container.sasl_server_mechanisms.enable_plain((g, w) => g === 'x' && w === 'y');
  const fake = { rij: [], zender: null, uitkomsten: [], dlq: [], sockets: new Set(), dlqGedrag: 'accepteer' };

  const lever = () => {
    while (fake.zender && fake.zender.is_open() && fake.zender.sendable() && fake.rij.length) {
      const bericht = fake.rij.shift();
      fake.zender.send(bericht).__bericht = bericht;
    }
  };
  container.on('sendable', lever);
  container.on('sender_open', (ctx) => { fake.zender = ctx.sender; });
  for (const soort of ['accepted', 'rejected', 'released', 'modified']) {
    container.on(soort, (ctx) => {
      const state = ctx.delivery.remote_state || {};
      // rhea meldt een 'modified'-uitkomst als 'released' (met delivery_failed in de state)
      const echt = soort === 'released' && state.delivery_failed ? 'modified' : soort;
      fake.uitkomsten.push({ soort: echt, params: { delivery_failed: state.delivery_failed }, bericht: ctx.delivery.__bericht });
    });
  }
  container.on('message', (ctx) => {
    fake.dlq.push(ctx.message);
    if (fake.dlqGedrag === 'accepteer') ctx.delivery.accept();
    else if (fake.dlqGedrag === 'wijs-af') ctx.delivery.reject({ condition: 'amqp:resource-limit-exceeded' });
  });
  fake.zet = (bericht) => { fake.rij.push(bericht); lever(); };
  fake.start = () => new Promise((resolve, reject) => {
    fake.server = container.listen({ port: 0, host: '127.0.0.1', autoaccept: false, ...(tls ? { transport: 'tls', key: tls.key, cert: tls.cert } : {}) });
    fake.server.on('connection', (s) => { fake.sockets.add(s); s.on('close', () => fake.sockets.delete(s)); });
    fake.server.once('error', reject);
    fake.server.once('listening', () => resolve(fake.server.address().port));
  });
  fake.stop = () => new Promise((resolve) => { for (const s of fake.sockets) s.destroy(); fake.server.close(() => resolve()); });
  return fake;
}

const wacht = async (voorwaarde, ms = 4000) => {
  const einde = Date.now() + ms;
  while (Date.now() < einde) { if (voorwaarde()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('time-out bij wachten op voorwaarde');
};

module.exports = { maakFakeApi, maakFakeBroker, wacht };
