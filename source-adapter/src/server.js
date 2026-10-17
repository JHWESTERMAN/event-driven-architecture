'use strict';
// Source-adapter (connector-in).
//
//   bronapp --POST /werkopdracht--> [1 valideer bron] -> [2 transformeer] -> [3 valideer canoniek] -> [4 serialiseer, verstuur] --> ActiveMQ
//
// Antwoorden:
//   202  het bericht staat persistent op de broker (de verantwoordelijkheid is overgedragen)
//   400  geen geldige JSON          413  te groot          415  geen application/json
//   422  het bericht voldoet niet aan het bronschema, of de inhoud kan niet vertaald worden. Fout van de bron: niet herhalen.
//   500  ons eigen canonieke bericht is ongeldig: een fout in de adapter, niet van de bron. Wel loggen.
//   503  de broker nam het bericht niet over (of is niet bereikbaar). Herhalen met dezelfde berichtId mag en moet.
//
// Elke stap schrijft een JSON-logregel met messageId en correlationId, zodat je een bericht kunt volgen.
const http = require('http');
const path = require('path');
const { laadValidators } = require('./validate');
const { bronNaarCanoniek, BronFout } = require('./transform');
const { BrokerVerbinding, BrokerFout } = require('./broker');

const MAX_BODY = 256 * 1024;
const CORRELATIE = /^[A-Za-z0-9._:-]{1,64}$/;

function maakLogger(uit = console.log) {
  return (regel) => uit(JSON.stringify({ tijd: new Date().toISOString(), niveau: 'info', ...regel }));
}

// Het bericht zoals de broker het krijgt: JSON als tekst (JMS TextMessage), persistent, met de eigenschappen waarop de
// ontvangende kant routeert, ontdubbelt en groepeert.
function bouwBrokerBericht(canoniek) {
  const e = canoniek.envelope;
  return {
    message_id: e.messageId,
    correlation_id: e.correlationId,
    subject: e.type,                      // JMSType
    group_id: canoniek.workOrder.id,      // JMSXGroupID: wijzigingen aan dezelfde werkorder gaan naar dezelfde consument, op volgorde
    content_type: 'application/json',
    durable: true,                        // persistent: de broker bevestigt pas na het wegschrijven
    creation_time: Date.parse(e.occurredAt),
    application_properties: {
      _AMQ_DUPL_ID: e.messageId,          // ontdubbeling door de broker bij herhaling door de bron
      schemaVersion: e.schemaVersion,
      sourceSystem: e.sourceSystem,
      eamType: e.type,
      workOrderId: canoniek.workOrder.id,
      version: e.version
    },
    body: JSON.stringify(canoniek)        // string: AMQP-value, bij Artemis een TextMessage
  };
}

function leesBody(req) {
  return new Promise((resolve, reject) => {
    const delen = []; let grootte = 0;
    req.on('data', (d) => {
      grootte += d.length;
      if (grootte > MAX_BODY) { reject(Object.assign(new Error('bericht is te groot'), { status: 413 })); req.destroy(); return; }
      delen.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(delen).toString('utf8')));
    req.on('error', reject);
  });
}

function maakServer({ config, broker, validators, log }) {
  const { valideerBron, valideerCanoniek } = validators;

  function antwoord(res, status, data, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(data) + '\n');
  }

  async function verwerk(req, res) {
    const ontvangen = Date.now();
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      log({ niveau: 'waarschuwing', stap: 'ontvangen', uitkomst: 'afgewezen', status: 415 });
      return antwoord(res, 415, { fout: 'Content-Type moet application/json zijn' });
    }
    const tekst = await leesBody(req);
    let bericht;
    try { bericht = JSON.parse(tekst); } catch (e) {
      log({ niveau: 'waarschuwing', stap: 'ontvangen', uitkomst: 'afgewezen', status: 400, reden: 'geen geldige JSON' });
      return antwoord(res, 400, { fout: 'Geen geldige JSON' });
    }

    const kopId = bericht && bericht.kop && typeof bericht.kop.berichtId === 'string' ? bericht.kop.berichtId : null;
    const opdrachtNr = bericht && bericht.opdracht && typeof bericht.opdracht.opdrachtNr === 'string' ? bericht.opdracht.opdrachtNr : null;
    const header = req.headers['x-correlation-id'];
    const correlationId = typeof header === 'string' && CORRELATIE.test(header) ? header : undefined;
    const ctx = { messageId: kopId, correlationId: correlationId || kopId, opdrachtNr };
    log({ ...ctx, stap: 'ontvangen', uitkomst: 'ok', soort: bericht && bericht.kop && bericht.kop.berichtSoort });

    // 1. valideren tegen het bronschema: een fout hier is van de bron
    const bronCheck = valideerBron(bericht);
    if (!bronCheck.ok) {
      log({ ...ctx, niveau: 'waarschuwing', stap: 'bronvalidatie', uitkomst: 'afgewezen', aantalFouten: bronCheck.fouten.length, eerste: bronCheck.fouten[0] });
      return antwoord(res, 422, { fout: 'Het bericht voldoet niet aan het bronschema', details: bronCheck.fouten });
    }
    log({ ...ctx, stap: 'bronvalidatie', uitkomst: 'ok' });

    // 2. transformeren naar het canonieke model
    let canoniek;
    try {
      canoniek = bronNaarCanoniek(bericht, { correlationId });
    } catch (fout) {
      if (fout instanceof BronFout) {
        log({ ...ctx, niveau: 'waarschuwing', stap: 'transformatie', uitkomst: 'afgewezen', reden: fout.message });
        return antwoord(res, 422, { fout: 'Het bericht kan niet worden vertaald', details: [{ pad: '/', melding: fout.message }] });
      }
      throw fout;
    }
    log({ ...ctx, stap: 'transformatie', uitkomst: 'ok', type: canoniek.envelope.type, workOrderId: canoniek.workOrder.id, versie: canoniek.envelope.version });

    // 3. valideren van onze eigen uitvoer: een fout hier is een fout in de adapter, niet van de bron
    const canoniekCheck = valideerCanoniek(canoniek);
    if (!canoniekCheck.ok) {
      log({ ...ctx, niveau: 'fout', stap: 'canonieke-validatie', uitkomst: 'mislukt', details: canoniekCheck.fouten });
      return antwoord(res, 500, { fout: 'Interne fout: het vertaalde bericht is ongeldig. Dit is gemeld in de log van de adapter.' });
    }
    log({ ...ctx, stap: 'canonieke-validatie', uitkomst: 'ok' });

    // 4. serialiseren en naar de broker; pas bij 'accepted' antwoorden we 202
    try {
      await broker.send(bouwBrokerBericht(canoniek), config.sendTimeoutMs);
    } catch (fout) {
      if (fout instanceof BrokerFout) {
        log({ ...ctx, niveau: 'fout', stap: 'verzonden', uitkomst: 'mislukt', brokerFout: fout.soort, reden: fout.message });
        return antwoord(res, 503, { fout: 'De broker heeft het bericht niet overgenomen. Probeer het opnieuw met dezelfde berichtId.', reden: fout.soort }, { 'Retry-After': '5' });
      }
      throw fout;
    }
    log({ ...ctx, stap: 'verzonden', uitkomst: 'ok', adres: config.queue, ms: Date.now() - ontvangen });
    return antwoord(res, 202, {
      status: 'accepted', messageId: canoniek.envelope.messageId, correlationId: canoniek.envelope.correlationId,
      workOrderId: canoniek.workOrder.id, queue: config.queue
    });
  }

  return http.createServer((req, res) => {
    const pad = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && pad === '/health') {
      const klaar = broker.isVerbonden();
      return antwoord(res, klaar ? 200 : 503, { status: klaar ? 'UP' : 'DOWN', broker: { verbonden: klaar, queue: config.queue } });
    }
    if (req.method === 'POST' && pad === '/werkopdracht') {
      return verwerk(req, res).catch((fout) => {
        const status = fout.status || 500;
        if (status === 500) log({ niveau: 'fout', stap: 'onverwacht', uitkomst: 'mislukt', fout: fout.stack || fout.message });
        if (!res.headersSent) antwoord(res, status, { fout: status === 500 ? 'Interne fout' : fout.message });
      });
    }
    antwoord(res, 404, { fout: 'niet gevonden', endpoints: ['POST /werkopdracht', 'GET /health'] });
  });
}

function configUitOmgeving(env = process.env) {
  return {
    port: Number(env.PORT) || 8090,
    queue: env.BROKER_QUEUE || 'eam.workorder.v1',
    brokerHost: env.BROKER_HOST || 'artemis',
    brokerPort: Number(env.BROKER_PORT) || 61616,
    brokerUser: env.BROKER_USER || 'artemis',
    brokerPassword: env.BROKER_PASSWORD || 'artemis',
    sendTimeoutMs: Number(env.BROKER_SEND_TIMEOUT_MS) || 5000,
    contractsDir: env.CONTRACTS_DIR || path.join(__dirname, '..', '..', 'contracts')
  };
}

module.exports = { maakServer, bouwBrokerBericht, configUitOmgeving, maakLogger };

if (require.main === module) {
  const config = configUitOmgeving();
  const log = maakLogger();
  const validators = laadValidators(config.contractsDir);
  const broker = new BrokerVerbinding({ host: config.brokerHost, port: config.brokerPort, user: config.brokerUser, password: config.brokerPassword, adres: config.queue, log });
  broker.start();
  const server = maakServer({ config, broker, validators, log });
  server.listen(config.port, () => log({ stap: 'start', gebeurtenis: 'luistert', poort: config.port, broker: `${config.brokerHost}:${config.brokerPort}`, queue: config.queue }));
  for (const signaal of ['SIGTERM', 'SIGINT']) {
    process.on(signaal, () => { broker.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
  }
}
