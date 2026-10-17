'use strict';
// Zuivere vertaling van het bronbericht (OMS) naar het canonieke EAM-bericht. Geen netwerk, geen klok.
// De afspraken staan in contracts/README.md en worden getest tegen contracts/mapping-tests/golden.
const { rdNaarWgs84 } = require('./rd');

// Een fout in de inhoud van het bronbericht die het schema niet vangt (bijvoorbeeld een tijdstip dat niet bestaat).
// Dit is een fout van de bron: de adapter antwoordt 422.
class BronFout extends Error {
  constructor(bericht) { super(bericht); this.name = 'BronFout'; }
}

const BERICHTSOORT = { NIEUW: 'eam.workorder.created', WIJZIGING: 'eam.workorder.updated', INTREKKING: 'eam.workorder.cancelled' };
const SOORT = { COR: 'CORRECTIVE', PRV: 'PREVENTIVE', INS: 'INSPECTION' };
const STATUS = { '01': 'REQUESTED', '02': 'PLANNED', '03': 'ASSIGNED', '04': 'IN_PROGRESS', '05': 'COMPLETED' };
const OBJECTSOORT = { WSL: 'SWITCH', SEI: 'SIGNAL', OVW: 'LEVEL_CROSSING', KAB: 'CABLE', PRT: 'PLATFORM' };
const EENHEID = { ST: 'PCS', M: 'M', KG: 'KG' };
const REDEN = { DUBBEL: 'DUPLICATE', FOUTIEF: 'ERRONEOUS', VERVALLEN: 'OBSOLETE', OVERIG: 'OTHER' };
const prioriteit = (code) => (code <= 2 ? 'HIGH' : code === 3 ? 'NORMAL' : 'LOW');

// ---------- Tijd: lokale tijd in Nederland (zonder tijdzone) naar UTC ----------
const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Amsterdam', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
});
function lokaleDelen(ms) {
  return Object.fromEntries(formatter.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}
function lokaalTekst(ms) {
  const d = lokaleDelen(ms);
  return `${d.day}-${d.month}-${d.year} ${d.hour}:${d.minute}:${d.second}`;
}
// Verschil tussen lokale tijd en UTC op dit moment, in milliseconden (3.600.000 in de winter, 7.200.000 in de zomer)
function offsetMs(ms) {
  const d = lokaleDelen(ms);
  return Date.UTC(d.year, d.month - 1, d.day, d.hour, d.minute, d.second) - Math.floor(ms / 1000) * 1000;
}

// 'dd-MM-yyyy HH:mm:ss' (Europe/Amsterdam) naar ISO 8601 in UTC, zonder milliseconden.
// Een tijdstip dat niet bestaat (31-02, of het uur dat bij de overgang naar zomertijd wordt overgeslagen) is een BronFout.
// Het uur dat bij de overgang naar wintertijd twee keer voorkomt, wordt gelezen als de tweede keer (wintertijd).
function lokaalNaarUtc(tekst, veld = 'tijdstip') {
  const m = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(tekst);
  if (!m) throw new BronFout(`${veld}: '${tekst}' heeft niet het formaat dd-MM-yyyy HH:mm:ss`);
  const [, dd, mm, jjjj, uu, mi, ss] = m;
  const naief = Date.UTC(+jjjj, +mm - 1, +dd, +uu, +mi, +ss);
  let utc = naief - offsetMs(naief);
  utc = naief - offsetMs(utc);
  if (lokaalTekst(utc) !== tekst) throw new BronFout(`${veld}: '${tekst}' bestaat niet in tijdzone Europe/Amsterdam`);
  return new Date(utc).toISOString().replace('.000Z', 'Z');
}

// ---------- Vertaling ----------
const getalNa = (tekst, voorvoegsel) => Number(tekst.slice(voorvoegsel.length));
const werkorderId = (opdrachtNr) => `WO-${getalNa(opdrachtNr, 'WOP-')}`;

function positie(locatie) {
  const p = locatie.positie;
  if (!p) return {};
  if (p.rd) return rdNaarWgs84(p.rd.x, p.rd.y);
  return { lat: p.wgs84.breedte, lon: p.wgs84.lengte };
}

function bronNaarCanoniek(bericht, { correlationId } = {}) {
  const k = bericht.kop;
  const o = bericht.opdracht;

  const envelope = {
    messageId: k.berichtId,
    correlationId: correlationId || k.berichtId,
    type: BERICHTSOORT[k.berichtSoort],
    schemaVersion: '1.0',
    sourceSystem: k.bronSysteem,
    occurredAt: lokaalNaarUtc(k.verzondenOp, 'kop.verzondenOp'),
    version: k.volgnummer
  };

  if (k.berichtSoort === 'INTREKKING') {
    return {
      envelope,
      workOrder: { id: werkorderId(o.opdrachtNr), sourceReference: o.opdrachtNr, status: 'CANCELLED', cancellationReason: REDEN[o.redenCode] }
    };
  }

  const asset = { id: `A-${getalNa(o.object.objectNr, 'OBJ-')}`, functionalLocation: o.object.functioneleLocatie };
  if (o.object.objectType) asset.kind = OBJECTSOORT[o.object.objectType];

  const location = { place: o.locatie.plaats };
  if (o.locatie.emplacement) location.site = o.locatie.emplacement;
  Object.assign(location, positie(o.locatie));

  const workOrder = {
    id: werkorderId(o.opdrachtNr),
    sourceReference: o.opdrachtNr,
    type: SOORT[o.soortCode],
    priority: prioriteit(o.prioriteitCode),
    status: STATUS[o.statusCode],
    description: o.omschrijving.kort,
    asset,
    location
  };

  if (o.toewijzing) {
    const n = o.toewijzing.naam;
    workOrder.assignee = {
      id: `M-${String(Number(o.toewijzing.medewerkerNr)).padStart(3, '0')}`,   // 000017 wordt M-017 (minimaal drie cijfers, zoals in Keycloak en de API)
      name: [n.voornaam, n.tussenvoegsel, n.achternaam].filter(Boolean).join(' ')
    };
    if (o.toewijzing.ploeg) workOrder.assignee.team = o.toewijzing.ploeg;
  }
  if (o.planning) {
    workOrder.schedule = {
      plannedStart: lokaalNaarUtc(o.planning.geplandStart, 'opdracht.planning.geplandStart'),
      plannedEnd: lokaalNaarUtc(o.planning.geplandEinde, 'opdracht.planning.geplandEinde')
    };
  }
  workOrder.tasks = (o.werkpakket || []).map((s) => ({ id: `T-${s.stapNr / 10}`, description: s.omschrijving, done: s.gereed === 'J' }));
  workOrder.materials = (o.materialen || []).map((m) => ({
    itemNumber: m.artikelCode, description: m.omschrijving, quantity: m.hoeveelheid.waarde, unit: EENHEID[m.hoeveelheid.eenheid]
  }));

  return { envelope, workOrder };
}

module.exports = { bronNaarCanoniek, lokaalNaarUtc, BronFout };
