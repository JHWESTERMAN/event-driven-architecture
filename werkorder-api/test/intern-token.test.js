// De interne API met Keycloak-tokens: alleen het service-account van de target-adapter met de juiste rol mag schrijven.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { wo, put } = require('./helpers');

const ISSUER = 'http://localhost:8180/realms/werkorders';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: vreemdeSleutel } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function token(claims = {}, { sleutel = privateKey, alg = 'RS256', kid = 'k1' } = {}) {
  const nu = Math.floor(Date.now() / 1000);
  const basis = { iss: ISSUER, aud: 'werkorders-api', exp: nu + 300, azp: 'target-adapter', realm_access: { roles: ['werkorder-schrijver'] }, preferred_username: 'service-account-target-adapter', ...claims };
  const kop = `${b64({ alg, kid, typ: 'JWT' })}.${b64(basis)}`;
  return `${kop}.${crypto.sign('RSA-SHA256', Buffer.from(kop), sleutel).toString('base64url')}`;
}

let jwks, server, basis;
test.before(async () => {
  jwks = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise((r) => jwks.listen(0, '127.0.0.1', r));
  process.env.OIDC_JWKS_URL = `http://127.0.0.1:${jwks.address().port}/certs`;
  process.env.OIDC_ISSUER = ISSUER;
  process.env.DB_PATH = ':memory:';
  delete process.env.INTERN_API_KEY;
  delete process.env.KAFKA_BROKER;
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  basis = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); jwks.close(); });

const stuur = (t, id = 'WO-3001', versie = 1) => fetch(`${basis}/intern/werkorders/${id}`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
  body: JSON.stringify((({ werkorderId, ...rest }) => rest)(put(versie, wo({ werkorderId: id }))))
});

test('service-account met de juiste rol mag schrijven', async () => {
  const r = await stuur(token());
  assert.equal(r.status, 200);
  assert.equal((await r.json()).resultaat, 'VERWERKT');
});

test('zonder token: 401', async () => { assert.equal((await stuur(null)).status, 401); });

test('API-sleutel werkt niet meer als INTERN_API_KEY niet is gezet', async () => {
  const r = await fetch(`${basis}/intern/werkorders/WO-3002`, { method: 'PUT', headers: { 'X-Api-Key': 'iets', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
});

test('monteurtoken (andere client, geen rol): 403 of 401, nooit 200', async () => {
  const t = token({ azp: 'monteur-app', realm_access: { roles: [] }, preferred_username: 'm-017' });
  const r = await stuur(t, 'WO-3003');
  assert.equal(r.status, 401);                       // verkeerde client
});

test('juiste client maar rol ontbreekt: 403', async () => {
  const r = await stuur(token({ realm_access: { roles: ['iets-anders'] } }), 'WO-3004');
  assert.equal(r.status, 403);
});

test('token met verkeerde handtekening, uitgever, doelgroep of verlopen: 401', async () => {
  assert.equal((await stuur(token({}, { sleutel: vreemdeSleutel }), 'WO-3005')).status, 401);
  assert.equal((await stuur(token({ iss: 'http://evil/realms/x' }), 'WO-3005')).status, 401);
  assert.equal((await stuur(token({ aud: 'iets-anders' }), 'WO-3005')).status, 401);
  assert.equal((await stuur(token({ exp: Math.floor(Date.now() / 1000) - 60 }), 'WO-3005')).status, 401);
  assert.equal((await stuur(token({}, { alg: 'none' }), 'WO-3005')).status, 401);
});

test('service-account heeft geen toegang tot de monteur-API', async () => {
  const r = await fetch(`${basis}/api/werkorders`, { headers: { Authorization: `Bearer ${token()}` } });
  assert.equal(r.status, 401);                       // preferred_username is geen monteur-id
});
