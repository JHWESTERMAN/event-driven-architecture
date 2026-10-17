'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { leesGeheim } = require('../src/omgeving');
const { configUitOmgeving } = require('../src/server');

function tijdelijkBestand(inhoud) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geheim-'));
  const pad = path.join(dir, 'geheim');
  fs.writeFileSync(pad, inhoud);
  return { pad, ruim: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('geheim: NAAM_FILE gaat voor NAAM en één afsluitende regeleinde valt weg', (t) => {
  const f = tijdelijkBestand('uit-bestand\n'); t.after(f.ruim);
  assert.equal(leesGeheim({ W: 'uit-omgeving', W_FILE: f.pad }, 'W'), 'uit-bestand');
});

test('geheim: zonder bestand telt de omgevingsvariabele, anders de standaardwaarde', () => {
  assert.equal(leesGeheim({ W: 'x' }, 'W'), 'x');
  assert.equal(leesGeheim({}, 'W', 'standaard'), 'standaard');
});

test('geheim: een ontbrekend of leeg bestand is een duidelijke fout, geen stille terugval', (t) => {
  const leeg = tijdelijkBestand(''); t.after(leeg.ruim);
  assert.throws(() => leesGeheim({ W: 'terugval', W_FILE: '/bestaat/niet' }, 'W'), /W_FILE: kan \/bestaat\/niet niet lezen/);
  assert.throws(() => leesGeheim({ W: 'terugval', W_FILE: leeg.pad }, 'W'), /is leeg/);
});

test('config: brokerwachtwoord, client-secret en TLS komen uit de omgeving, bestand boven variabele', (t) => {
  const bw = tijdelijkBestand('broker-uit-kluis'); t.after(bw.ruim);
  const cs = tijdelijkBestand('client-uit-kluis\n'); t.after(cs.ruim);
  const c = configUitOmgeving({
    BROKER_PASSWORD: 'oud', BROKER_PASSWORD_FILE: bw.pad, BROKER_TLS: 'true',
    OIDC_TOKEN_URL: 'http://keycloak/token', OIDC_CLIENT_SECRET_FILE: cs.pad
  });
  assert.equal(c.broker.password, 'broker-uit-kluis');
  assert.equal(c.broker.tls.transport, 'tls');
  assert.ok(c.api.tokenBron, 'token-bron is aangemaakt met het client-secret uit het bestand');
  assert.deepEqual(configUitOmgeving({}).broker.tls, {});
});
