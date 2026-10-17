'use strict';
// Bouwt berichten in de bron-interface van het onderhoudssysteem OMS (contracts/bron/werkopdracht-1.0.schema.json).
// Alleen standaardbibliotheek. Geen netwerk: server.js verstuurt, dit bestand bouwt.
const crypto = require('crypto');

// ---------- Catalogus (voorbeelddata) ----------
const MEDEWERKERS = [
  { nr: '000017', voornaam: 'J.', tussenvoegsel: 'de', achternaam: 'Vries', ploeg: 'Ploeg Breda 2' },   // Keycloak: m-017
  { nr: '000022', voornaam: 'S.', tussenvoegsel: '',   achternaam: 'Jansen', ploeg: 'Ploeg Eindhoven 1' }, // Keycloak: m-022
  { nr: '000031', voornaam: 'P.', tussenvoegsel: 'van', achternaam: 'Dijk', ploeg: 'Ploeg Utrecht 3' }
];

const LOCATIES = {
  Breda:     { emplacement: 'Breda Noord',      fl: 'BD-N',  rd: { x: 112650, y: 397750 }, wgs84: { breedte: 51.567093, lengte: 4.776389 } },
  Tilburg:   { emplacement: 'Tilburg West',     fl: 'TB-W',  rd: { x: 130400, y: 392500 }, wgs84: { breedte: 51.52096,  lengte: 5.032759 } },
  Eindhoven: { emplacement: 'Eindhoven Zuid',   fl: 'EHV-Z', rd: { x: 161000, y: 383500 }, wgs84: { breedte: 51.440568, lengte: 5.473501 } },
  Utrecht:   { emplacement: 'Utrecht Centraal', fl: 'UT-C',  rd: { x: 136400, y: 455900 }, wgs84: { breedte: 52.091048, lengte: 5.115801 } },
  Amsterdam: { emplacement: 'Amsterdam Zuidas', fl: 'AMS-Z', rd: { x: 119800, y: 483200 }, wgs84: { breedte: 52.335601, lengte: 4.870752 } }
};

const OBJECTSOORTEN = {
  WSL: { soortCode: 'COR', kort: (n) => `Storing wissel ${n}, wisselmotor reageert niet`,
         stappen: ['Wissel veiligstellen', 'Wisselmotor controleren', 'Rapport invullen'],
         materiaal: [{ artikelCode: 'WM-204', omschrijving: 'Wisselmotor 220V', waarde: 1, eenheid: 'ST' }] },
  SEI: { soortCode: 'COR', kort: (n) => `Seinlamp vervangen bij sein ${n}`,
         stappen: ['Sein buiten dienst nemen', 'Lamp vervangen', 'Sein testen'],
         materiaal: [{ artikelCode: 'SL-118', omschrijving: 'Seinlamp LED', waarde: 2, eenheid: 'ST' }] },
  OVW: { soortCode: 'INS', kort: (n) => `Jaarlijkse inspectie overweg ${n}`,
         stappen: ['Installatie inspecteren', 'Meetwaarden vastleggen', 'Rapport indienen'],
         materiaal: [] },
  KAB: { soortCode: 'COR', kort: (n) => `Kabelbreuk herstellen bij kabel ${n}`,
         stappen: ['Breuk lokaliseren', 'Kabel herstellen', 'Isolatiemeting uitvoeren', 'Rapport invullen'],
         materiaal: [{ artikelCode: 'KB-330', omschrijving: 'Seinkabel 12-aderig', waarde: 25, eenheid: 'M' }] }
};

const FOUTEN = ['statusCode', 'toewijzing', 'tijdstip', 'onbekendVeld', 'opdrachtNr', 'eenheid'];
const REDENEN = ['DUBBEL', 'FOUTIEF', 'VERVALLEN', 'OVERIG'];
const STATUSVOLGORDE = ['01', '02', '03', '04', '05'];

// ---------- Hulpfuncties ----------
const kies = (lijst) => lijst[Math.floor(Math.random() * lijst.length)];
const pad = (n, breedte) => String(n).padStart(breedte, '0');
const kopie = (o) => JSON.parse(JSON.stringify(o));

// Lokale tijd in Nederland, zonder tijdzone-aanduiding: dd-MM-yyyy HH:mm:ss (zoals het bronschema eist)
const deelFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Amsterdam', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
});
function lokaleTijd(datum = new Date()) {
  const d = Object.fromEntries(deelFormatter.formatToParts(datum).map((p) => [p.type, p.value]));
  return `${d.day}-${d.month}-${d.year} ${d.hour}:${d.minute}:${d.second}`;
}

function toewijzingVan(medewerker) {
  const naam = { voornaam: medewerker.voornaam, achternaam: medewerker.achternaam };
  if (medewerker.tussenvoegsel) naam.tussenvoegsel = medewerker.tussenvoegsel;
  return { medewerkerNr: medewerker.nr, naam, ploeg: medewerker.ploeg };
}

function kiesMedewerker(nr) {
  if (nr) return MEDEWERKERS.find((m) => m.nr === nr);
  // De twee medewerkers die kunnen inloggen in de monteur-app krijgen het merendeel van het werk
  return Math.random() < 0.7 ? kies(MEDEWERKERS.slice(0, 2)) : MEDEWERKERS[2];
}

function planningVanaf(uren) {
  const start = new Date(Date.now() + uren * 3600e3);
  return { geplandStart: lokaleTijd(start), geplandEinde: lokaleTijd(new Date(start.getTime() + 3 * 3600e3)) };
}

function kop(staat, soort, volgnummer) {
  return { berichtId: crypto.randomUUID(), verzondenOp: lokaleTijd(), bronSysteem: 'OMS', berichtSoort: soort, volgnummer };
}

// ---------- Staat ----------
function nieuweStaat({ start = 2001 } = {}) {
  return { teller: start, opdrachten: new Map() };
}

function opdrachtNrVan(teller) { return `WOP-${pad(teller, 6)}`; }

// ---------- Berichten ----------
// opties: { medewerkerNr, plaats, objectType, statusCode ('01' of '03') }
function maakNieuw(staat, opties = {}, fout = null) {
  const plaats = opties.plaats || kies(Object.keys(LOCATIES));
  const locatie = LOCATIES[plaats];
  const objectType = opties.objectType || kies(Object.keys(OBJECTSOORTEN));
  const soort = OBJECTSOORTEN[objectType];
  const statusCode = opties.statusCode || (Math.random() < 0.7 ? '03' : '01');
  const objectVolgnr = 100 + Math.floor(Math.random() * 900);
  const nr = opdrachtNrVan(staat.teller);

  const opdracht = {
    opdrachtNr: nr,
    soortCode: soort.soortCode,
    prioriteitCode: soort.soortCode === 'COR' ? kies([1, 1, 2]) : kies([3, 4]),
    statusCode,
    omschrijving: { kort: soort.kort(objectVolgnr) },
    object: { objectNr: `OBJ-${pad(objectVolgnr, 5)}`, functioneleLocatie: `${locatie.fl}-${objectType}-${pad(objectVolgnr, 4)}`, objectType },
    locatie: { plaats, emplacement: locatie.emplacement },
    werkpakket: soort.stappen.map((omschrijving, i) => ({ stapNr: (i + 1) * 10, omschrijving, gereed: 'N' })),
    materialen: soort.materiaal.map((m) => ({ artikelCode: m.artikelCode, omschrijving: m.omschrijving, hoeveelheid: { waarde: m.waarde, eenheid: m.eenheid } }))
  };

  const r = Math.random();
  if (r < 0.6) opdracht.locatie.positie = { rd: { ...locatie.rd } };
  else if (r < 0.85) opdracht.locatie.positie = { wgs84: { ...locatie.wgs84 } };

  if (statusCode !== '01') opdracht.planning = planningVanaf(1);
  if (STATUSVOLGORDE.indexOf(statusCode) >= 2) opdracht.toewijzing = toewijzingVan(kiesMedewerker(opties.medewerkerNr));

  const bericht = { kop: kop(staat, 'NIEUW', 1), opdracht };

  if (fout) {                       // opzettelijk fout bericht: wordt niet geregistreerd, zodat de staat schoon blijft
    return maakFout(bericht, fout);
  }
  staat.opdrachten.set(nr, { opdracht: kopie(opdracht), volgnummer: 1, ingetrokken: false });
  staat.teller++;
  bewaakGrootte(staat);
  return bericht;
}

function maakFout(bericht, fout) {
  const o = bericht.opdracht;
  switch (fout) {
    case 'statusCode':    o.statusCode = '07'; break;
    case 'toewijzing':    o.statusCode = '03'; delete o.toewijzing; break;
    case 'tijdstip':      bericht.kop.verzondenOp = new Date().toISOString(); break;
    case 'onbekendVeld':  o.prioriteit = 'HOOG'; break;
    case 'opdrachtNr':    o.opdrachtNr = o.opdrachtNr.replace('WOP-', 'WO-'); break;
    case 'eenheid':
      if (o.materialen.length === 0) o.materialen.push({ artikelCode: 'XX-001', omschrijving: 'Testartikel', hoeveelheid: { waarde: 1, eenheid: 'ST' } });
      o.materialen[0].hoeveelheid.eenheid = 'L';
      break;
    default: throw new Error(`onbekende fout '${fout}' (kies uit: ${FOUTEN.join(', ')})`);
  }
  return bericht;
}

// wijziging: { statusCode, prioriteitCode, medewerkerNr, stappenGereed: [10, 20] }
function maakWijziging(staat, nr, wijziging = {}) {
  const s = staat.opdrachten.get(nr);
  if (!s) throw Object.assign(new Error(`opdracht ${nr} bestaat niet`), { code: 404 });
  if (s.ingetrokken) throw Object.assign(new Error(`opdracht ${nr} is ingetrokken`), { code: 409 });
  const o = s.opdracht;

  if (wijziging.statusCode !== undefined) {
    if (!STATUSVOLGORDE.includes(wijziging.statusCode)) throw Object.assign(new Error(`statusCode moet een van ${STATUSVOLGORDE.join(', ')} zijn`), { code: 400 });
    o.statusCode = wijziging.statusCode;
  }
  if (wijziging.prioriteitCode !== undefined) {
    if (![1, 2, 3, 4].includes(wijziging.prioriteitCode)) throw Object.assign(new Error('prioriteitCode moet 1 t/m 4 zijn'), { code: 400 });
    o.prioriteitCode = wijziging.prioriteitCode;
  }
  if (wijziging.medewerkerNr !== undefined) {
    const m = kiesMedewerker(wijziging.medewerkerNr);
    if (!m) throw Object.assign(new Error(`onbekende medewerker ${wijziging.medewerkerNr}`), { code: 400 });
    o.toewijzing = toewijzingVan(m);
  }
  for (const stapNr of wijziging.stappenGereed || []) {
    const stap = o.werkpakket.find((x) => x.stapNr === stapNr);
    if (!stap) throw Object.assign(new Error(`stap ${stapNr} bestaat niet`), { code: 400 });
    stap.gereed = 'J';
  }

  // Afgeleide regels, zodat het resultaat altijd binnen het bronschema blijft
  const index = STATUSVOLGORDE.indexOf(o.statusCode);
  if (index >= 1 && !o.planning) o.planning = planningVanaf(1);
  if (index >= 2 && !o.toewijzing) o.toewijzing = toewijzingVan(kiesMedewerker());
  if (o.statusCode === '05') o.werkpakket.forEach((x) => { x.gereed = 'J'; });

  s.volgnummer++;
  return { kop: kop(staat, 'WIJZIGING', s.volgnummer), opdracht: kopie(o) };
}

function maakIntrekking(staat, nr, redenCode = 'OVERIG') {
  const s = staat.opdrachten.get(nr);
  if (!s) throw Object.assign(new Error(`opdracht ${nr} bestaat niet`), { code: 404 });
  if (s.ingetrokken) throw Object.assign(new Error(`opdracht ${nr} is al ingetrokken`), { code: 409 });
  if (!REDENEN.includes(redenCode)) throw Object.assign(new Error(`redenCode moet een van ${REDENEN.join(', ')} zijn`), { code: 400 });
  s.ingetrokken = true;
  s.volgnummer++;
  return { kop: kop(staat, 'INTREKKING', s.volgnummer), opdracht: { opdrachtNr: nr, redenCode } };
}

// Willekeurige volgende actie voor de automatische modus
function volgendeActie(staat) {
  const open = [...staat.opdrachten.entries()].filter(([, s]) => !s.ingetrokken && s.opdracht.statusCode !== '05');
  const intrekbaar = open.filter(([, s]) => ['01', '02', '03'].includes(s.opdracht.statusCode));
  const r = Math.random();
  if (open.length === 0 || r < 0.45) return maakNieuw(staat);
  if (r >= 0.9 && intrekbaar.length > 0) return maakIntrekking(staat, kies(intrekbaar)[0], kies(REDENEN));

  const [nr, s] = kies(open);
  const o = s.opdracht;
  const openStappen = o.werkpakket.filter((x) => x.gereed === 'N');
  if (o.statusCode === '04' && openStappen.length > 1 && Math.random() < 0.6) {
    return maakWijziging(staat, nr, { stappenGereed: [openStappen[0].stapNr] });   // een stap afvinken
  }
  return maakWijziging(staat, nr, { statusCode: STATUSVOLGORDE[STATUSVOLGORDE.indexOf(o.statusCode) + 1] });
}

// Houd het geheugen begrensd: oudste afgesloten opdrachten vallen af
function bewaakGrootte(staat, max = 500) {
  if (staat.opdrachten.size <= max) return;
  for (const [nr, s] of staat.opdrachten) {
    if (s.ingetrokken || s.opdracht.statusCode === '05') staat.opdrachten.delete(nr);
    if (staat.opdrachten.size <= max) return;
  }
}

module.exports = {
  FOUTEN, REDENEN, STATUSVOLGORDE, MEDEWERKERS, LOCATIES, OBJECTSOORTEN,
  lokaleTijd, nieuweStaat, maakNieuw, maakWijziging, maakIntrekking, volgendeActie
};
