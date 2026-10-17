'use strict';
// Contracttest: draait zonder framework (node test-contracts.js).
//  1. Alle schema's compileren (strikte modus).
//  2. Golden pairs: de bron-kant voldoet aan het bronschema, de canonieke kant aan het canonieke schema.
//  3. Ongeldige voorbeelden worden afgewezen (en we tonen waarom, zodat je ziet dat het om de juiste reden is).
//  4. De bronapp bouwt alleen berichten die aan zijn eigen schema voldoen.
//  5. De referentie voor Rijksdriehoek naar WGS84 klopt op het bekende referentiepunt.
// De transformatie zelf (bron naar canoniek) wordt in de source-adapter getest tegen dezelfde golden files.
const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const lees = (...p) => JSON.parse(fs.readFileSync(path.join(__dirname, ...p), 'utf8'));
const bestanden = (...p) => fs.readdirSync(path.join(__dirname, ...p)).filter((f) => f.endsWith('.json')).sort();

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);

let fouten = 0, gelukt = 0;
function check(naam, voorwaarde, detail = '') {
  if (voorwaarde) { gelukt++; console.log(`  ok    ${naam}`); }
  else { fouten++; console.log(`  FOUT  ${naam}${detail ? '\n        ' + detail : ''}`); }
}
const kort = (errors) => errors.slice(0, 2).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');

console.log('Schema\'s compileren');
const valBron = ajv.compile(lees('bron', 'werkopdracht-1.0.schema.json'));
const valCanoniek = ajv.compile(lees('canoniek', 'eam-workorder-1.0.schema.json'));
const valMonteur = ajv.compile(lees('monteur', 'werkorder-notificatie.schema.json'));
check('bron, canoniek en monteur compileren', true);

console.log('\nGolden pairs');
const golden = [...new Set(bestanden('mapping-tests', 'golden').map((f) => f.split('.')[0]))];
for (const naam of golden) {
  const bron = lees('mapping-tests', 'golden', `${naam}.bron.json`);
  const canoniek = lees('mapping-tests', 'golden', `${naam}.canoniek.json`);
  check(`${naam}: bron voldoet aan bronschema`, valBron(bron), kort(valBron.errors || []));
  check(`${naam}: canoniek voldoet aan canoniek schema`, valCanoniek(canoniek), kort(valCanoniek.errors || []));
  check(`${naam}: messageId en versie komen uit de kop van de bron`,
    canoniek.envelope.messageId === bron.kop.berichtId && canoniek.envelope.version === bron.kop.volgnummer);
  check(`${naam}: sourceReference is het opdrachtnummer van de bron`,
    canoniek.workOrder.sourceReference === bron.opdracht.opdrachtNr);
}

console.log('\nOngeldige voorbeelden moeten worden afgewezen');
for (const f of bestanden('bron', 'ongeldig')) {
  const ok = valBron(lees('bron', 'ongeldig', f));
  check(`bron/${f}`, !ok); if (!ok) console.log(`        reden: ${kort(valBron.errors)}`);
}
for (const f of bestanden('canoniek', 'ongeldig')) {
  const ok = valCanoniek(lees('canoniek', 'ongeldig', f));
  check(`canoniek/${f}`, !ok); if (!ok) console.log(`        reden: ${kort(valCanoniek.errors)}`);
}

console.log('\nMonteur-event (bestaand contract van de ws-microservice)');
for (const f of bestanden('monteur', 'geldig')) check(`monteur/geldig/${f}`, valMonteur(lees('monteur', 'geldig', f)), kort(valMonteur.errors || []));
for (const f of bestanden('monteur', 'ongeldig')) check(`monteur/ongeldig/${f}`, !valMonteur(lees('monteur', 'ongeldig', f)));

console.log('\nReferentie Rijksdriehoek naar WGS84');
const { rdNaarWgs84 } = require('./tools/rd.js');
const ref = rdNaarWgs84(155000, 463000);
check('referentiepunt Amersfoort (155000, 463000) geeft 52.155174, 5.387206', ref.lat === 52.155174 && ref.lon === 5.387206, JSON.stringify(ref));
const breda = rdNaarWgs84(112650, 397750);
check('Breda Noord komt overeen met de golden file', breda.lat === 51.567093 && breda.lon === 4.776389, JSON.stringify(breda));

const bouwPad = path.join(__dirname, '..', 'bron-app', 'bouw.js');
if (fs.existsSync(bouwPad)) {
  console.log('\nBronapp bouwt alleen geldige berichten');
  const bouw = require(bouwPad);
  const staat = bouw.nieuweStaat({ start: 2001 });
  let aantal = 0, slecht = 0, voorbeeld = '';
  const soorten = { NIEUW: 0, WIJZIGING: 0, INTREKKING: 0 };
  for (let i = 0; i < 300; i++) {
    const bericht = bouw.volgendeActie(staat);
    aantal++; soorten[bericht.kop.berichtSoort]++;
    if (!valBron(bericht)) { slecht++; voorbeeld = voorbeeld || `${kort(valBron.errors)} :: ${JSON.stringify(bericht).slice(0, 200)}`; }
  }
  check(`300 gegenereerde berichten geldig (NIEUW ${soorten.NIEUW}, WIJZIGING ${soorten.WIJZIGING}, INTREKKING ${soorten.INTREKKING})`, slecht === 0, voorbeeld);
  check('alle drie de berichtsoorten komen voor', soorten.NIEUW > 0 && soorten.WIJZIGING > 0 && soorten.INTREKKING > 0);
  for (const fout of bouw.FOUTEN) {
    const s = bouw.nieuweStaat({ start: 9001 });
    const bericht = bouw.maakNieuw(s, {}, fout);
    check(`opzettelijke fout '${fout}' wordt door het schema afgewezen`, !valBron(bericht));
  }
}

console.log(`\n${gelukt} gelukt, ${fouten} mislukt`);
process.exit(fouten === 0 ? 0 : 1);
