'use strict';
// Geheimen en TLS-instellingen uit de omgeving.
//
// Geheimen komen niet meer als gewone omgevingsvariabele (die staat in `docker inspect` en in /proc/<pid>/environ), maar uit
// een bestand dat een kluis-agent of het platform neerzet (Docker/Kubernetes-secret onder /run/secrets). De conventie is die van
// de officiële images: NAAM_FILE=<pad> gaat voor NAAM=<waarde>. Zonder NAAM_FILE blijft NAAM werken, voor lokale tests.
const fs = require('fs');

function leesGeheim(env, naam, standaard = '') {
  const pad = env[`${naam}_FILE`];
  if (pad) {
    let tekst;
    try { tekst = fs.readFileSync(pad, 'utf8'); } catch (e) { throw new Error(`${naam}_FILE: kan ${pad} niet lezen (${e.code || e.message})`); }
    const waarde = tekst.replace(/\r?\n$/, '');       // alleen één afsluitende regeleinde weg; spaties horen bij het geheim
    if (!waarde) throw new Error(`${naam}_FILE: ${pad} is leeg`);
    return waarde;
  }
  return env[naam] !== undefined && env[naam] !== '' ? env[naam] : standaard;
}

// TLS naar de broker. Aan als BROKER_TLS_CA (pad naar het CA-certificaat, PEM) is gezet, of BROKER_TLS=true (dan met de
// systeemlijst van vertrouwde CA's). De broker wordt altijd geverifieerd: certificaatketen én hostnaam (BROKER_HOST, of
// BROKER_TLS_SERVERNAME als je via een andere naam verbindt). Er is bewust geen "onveilig doorgaan"-schakelaar.
function brokerTlsOpties(env) {
  const ca = env.BROKER_TLS_CA || '';
  const aan = env.BROKER_TLS ? env.BROKER_TLS === 'true' : Boolean(ca);
  if (!aan) return {};
  const opties = { transport: 'tls' };
  if (ca) {
    try { opties.ca = [fs.readFileSync(ca)]; } catch (e) { throw new Error(`BROKER_TLS_CA: kan ${ca} niet lezen (${e.code || e.message})`); }
  }
  if (env.BROKER_TLS_SERVERNAME) opties.servername = env.BROKER_TLS_SERVERNAME;
  return opties;
}

module.exports = { leesGeheim, brokerTlsOpties };
