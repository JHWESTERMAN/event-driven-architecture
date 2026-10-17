'use strict';
// Nagebootste AMQP 1.0-broker voor de tests (rhea als server). Dit test het gedrag van de adapter tegenover een broker,
// niet het gedrag van Artemis zelf. Gedrag per bericht: accepteer | wijs-af | geef-vrij | negeer (geen antwoord).
const rhea = require('rhea');

function maakFakeBroker({ tls } = {}) {
  const container = rhea.create_container({ autoaccept: false });
  container.sasl_server_mechanisms.enable_plain((gebruiker, wachtwoord) => gebruiker === 'x' && wachtwoord === 'y');

  const fake = { ontvangen: [], gedrag: 'accepteer', server: null, sockets: new Set(), verbindingen: 0 };

  container.on('connection_open', () => { fake.verbindingen++; });
  container.on('message', (ctx) => {
    fake.ontvangen.push({ adres: ctx.receiver.target && ctx.receiver.target.address, bericht: ctx.message });
    switch (fake.gedrag) {
      case 'accepteer': ctx.delivery.accept(); break;
      case 'wijs-af': ctx.delivery.reject({ condition: 'amqp:unauthorized-access', description: 'geen rechten op de queue' }); break;
      case 'geef-vrij': ctx.delivery.release(); break;
      case 'negeer': break;
      default: throw new Error(`onbekend gedrag ${fake.gedrag}`);
    }
  });

  fake.start = (poort = 0) => new Promise((resolve, reject) => {
    fake.server = container.listen({ port: poort, host: '127.0.0.1', autoaccept: false, ...(tls ? { transport: 'tls', key: tls.key, cert: tls.cert } : {}) });
    fake.server.on('connection', (s) => { fake.sockets.add(s); s.on('close', () => fake.sockets.delete(s)); });
    fake.server.once('error', reject);
    fake.server.once('listening', () => resolve(fake.server.address().port));
  });
  // Stopt hard, zoals een gecrashte broker: bestaande verbindingen worden verbroken
  fake.stop = () => new Promise((resolve) => {
    for (const s of fake.sockets) s.destroy();
    fake.server.close(() => resolve());
  });
  return fake;
}

module.exports = { maakFakeBroker };
