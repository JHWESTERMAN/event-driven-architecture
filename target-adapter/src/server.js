'use strict';
// Target-adapter (connector-out).
//
//   ActiveMQ eam.workorder.v1 --> [1 lees, deserialiseer] -> [2 valideer canoniek] -> [3 transformeer] -> [4 PUT werkorder-api]
//                                                                               \-- permanente fout --> eam.workorder.v1.dlq
// Bevestigen bij de broker gebeurt pas na een 2xx van de API. De adapter publiceert niets op Kafka: dat doet de API via zijn outbox.
// GET /health: 200 zodra de adapter aan de queue hangt, anders 503. GET /status: tellers.
const http = require('http');
const path = require('path');
const { laadValidator } = require('./validate');
const { beslis } = require('./verwerk');
const { Consument } = require('./consument');

function maakLogger(uit = console.log) {
  return (regel) => uit(JSON.stringify({ tijd: new Date().toISOString(), niveau: 'info', ...regel }));
}

function configUitOmgeving(env = process.env) {
  return {
    poort: Number(env.PORT || 8091),
    contractsDir: env.CONTRACTS_DIR || path.join(__dirname, '..', '..', 'contracts'),
    broker: {
      host: env.BROKER_HOST || 'localhost', port: Number(env.BROKER_PORT || 5672),
      user: env.BROKER_USER || 'artemis', password: env.BROKER_PASSWORD || 'artemis',
      queue: env.BROKER_QUEUE || 'eam.workorder.v1', dlq: env.BROKER_DLQ || 'eam.workorder.v1.dlq'
    },
    api: { baseUrl: env.API_URL || 'http://werkorder-api:8081', apiKey: env.INTERN_API_KEY || '', timeoutMs: Number(env.API_TIMEOUT_MS || 5000) }
  };
}

function start(config = configUitOmgeving(), log = maakLogger()) {
  if (!config.api.apiKey) throw new Error('INTERN_API_KEY ontbreekt');
  const valideer = laadValidator(config.contractsDir);
  const consument = new Consument({
    ...config.broker, log,
    beslis: (body) => beslis(body, { valideer, api: config.api, log })
  });
  consument.start();

  const server = http.createServer((req, res) => {
    const stuur = (code, body) => { const t = JSON.stringify(body); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(t) }); res.end(t); };
    if (req.method === 'GET' && req.url === '/health') {
      return consument.isVerbonden() ? stuur(200, { status: 'UP' }) : stuur(503, { status: 'DOWN', reden: 'niet verbonden met de broker' });
    }
    if (req.method === 'GET' && req.url === '/status') return stuur(200, consument.stats);
    stuur(404, { status: 404, title: 'Not Found' });
  });
  server.listen(config.poort, () => log({ stap: 'start', gebeurtenis: 'gestart', poort: config.poort, queue: config.broker.queue, api: config.api.baseUrl }));
  return { server, consument, stop() { consument.close(); server.close(); } };
}

if (require.main === module) {
  const app = start();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { app.stop(); setTimeout(() => process.exit(0), 200); });
}

module.exports = { start, configUitOmgeving };
