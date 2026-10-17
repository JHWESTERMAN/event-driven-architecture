'use strict';
// De beslissing per bericht, los van het transport (zodat ze zonder broker te testen is).
//
// beslis(rauweBody, ctx) -> { actie: 'ACCEPT' | 'RETRY' | 'DLQ', reden?, detail?, messageId?, correlationId? }
//   ACCEPT  verwerkt (of bewust genegeerd): bevestig bij de broker
//   RETRY   tijdelijke fout: geef terug aan de broker als mislukte aflevering (herlevering met vertraging, daarna DLA)
//   DLQ     permanent onverwerkbaar: stuur met reden naar eam.workorder.v1.dlq en bevestig het origineel
const { canoniekNaarMonteur, TransformFout } = require('./transform');
const { schrijfWerkorder } = require('./api');

function tekstVan(body) {
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (body && Buffer.isBuffer(body.content)) return body.content.toString('utf8');   // rhea: data-sectie
  return null;
}

async function beslis(rauweBody, { valideer, api, log }) {
  const tekst = tekstVan(rauweBody);
  if (tekst === null) return { actie: 'DLQ', reden: 'ONLEESBAAR', detail: 'berichtbody is geen tekst' };

  let canoniek;
  try { canoniek = JSON.parse(tekst); } catch (e) { return { actie: 'DLQ', reden: 'GEEN_JSON', detail: e.message }; }

  const messageId = canoniek && canoniek.envelope && canoniek.envelope.messageId;
  const correlationId = canoniek && canoniek.envelope && canoniek.envelope.correlationId;
  const ids = { messageId, correlationId };

  const v = valideer(canoniek);
  if (!v.ok) return { actie: 'DLQ', reden: 'CANONIEK_ONGELDIG', detail: JSON.stringify(v.fouten), ...ids };

  let uit;
  try { uit = canoniekNaarMonteur(canoniek); } catch (e) {
    if (e instanceof TransformFout) return { actie: 'DLQ', reden: 'TRANSFORMATIE_MISLUKT', detail: e.message, ...ids };
    throw e;
  }

  const r = await schrijfWerkorder({ ...api, werkorderId: uit.werkorderId, body: uit.body });
  if (r.soort === 'OK') return { actie: 'ACCEPT', werkorderId: uit.werkorderId, versie: uit.body.versie, apiResultaat: r.resultaat && r.resultaat.resultaat, ...ids };
  if (r.soort === 'PERMANENT') return { actie: 'DLQ', reden: 'API_AFGEWEZEN', detail: `HTTP ${r.status}: ${r.detail}`, werkorderId: uit.werkorderId, ...ids };
  return { actie: 'RETRY', reden: r.reden, werkorderId: uit.werkorderId, ...ids };
}

module.exports = { beslis, tekstVan };
