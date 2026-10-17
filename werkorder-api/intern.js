// Validatie van de interne schrijf-API (PUT /intern/werkorders/{id}), bedoeld voor de target-adapter.
// Bewust met de hand geschreven: de API heeft zo geen extra bibliotheek nodig. De adapter heeft zijn eigen
// (strengere) schemavalidatie; dit is de laatste verdedigingslinie van de opslag.
const STATUSSEN = ['OPEN', 'IN_BEHANDELING', 'AFGEROND'];
const PRIORITEITEN = ['HOOG', 'NORMAAL', 'LAAG'];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const isTekst = (v) => typeof v === 'string' && v.trim() !== '';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function toegestaan(obj, velden, pad, fouten) {
  for (const k of Object.keys(obj)) if (!velden.includes(k)) fouten.push(`${pad}.${k}: onbekend veld`);
}

function valideerWerkorder(w, id, fouten) {
  if (!isObj(w)) { fouten.push('werkorder: moet een object zijn'); return; }
  toegestaan(w, ['werkorderId', 'status', 'prioriteit', 'omschrijving', 'locatie', 'monteur', 'aangemaaktOp', 'taken', 'materiaal'], 'werkorder', fouten);
  if (w.werkorderId !== id) fouten.push('werkorder.werkorderId: moet gelijk zijn aan het id in de URL');
  if (!STATUSSEN.includes(w.status)) fouten.push(`werkorder.status: moet een van ${STATUSSEN.join(', ')} zijn`);
  if (!PRIORITEITEN.includes(w.prioriteit)) fouten.push(`werkorder.prioriteit: moet een van ${PRIORITEITEN.join(', ')} zijn`);
  if (!isTekst(w.omschrijving)) fouten.push('werkorder.omschrijving: verplicht');
  if (typeof w.aangemaaktOp !== 'string' || !ISO_UTC.test(w.aangemaaktOp)) fouten.push('werkorder.aangemaaktOp: verwacht ISO-8601 UTC (Z)');

  const l = w.locatie;
  if (!isObj(l) || !isTekst(l.plaats) || !isTekst(l.spoorEmplacement)) fouten.push('werkorder.locatie: plaats en spoorEmplacement zijn verplicht (coordinaten optioneel)');
  else if (l.coordinaten !== undefined && (!isObj(l.coordinaten) || !(l.coordinaten.lat >= -90 && l.coordinaten.lat <= 90) || !(l.coordinaten.lon >= -180 && l.coordinaten.lon <= 180))) {
    fouten.push('werkorder.locatie.coordinaten: lat/lon liggen buiten bereik');
  }

  if (w.monteur !== undefined && w.monteur !== null) {
    if (!isObj(w.monteur) || typeof w.monteur.id !== 'string' || !/^M-\d+$/.test(w.monteur.id) || !isTekst(w.monteur.naam)) {
      fouten.push('werkorder.monteur: id (M-nnn) en naam zijn verplicht');
    }
  } else if (w.status !== 'OPEN') {
    fouten.push('werkorder.monteur: verplicht zodra de status niet OPEN is');
  }

  if (!Array.isArray(w.taken)) fouten.push('werkorder.taken: moet een lijst zijn (mag leeg)');
  else w.taken.forEach((t, i) => {
    if (!isObj(t) || !isTekst(t.taakId) || !isTekst(t.omschrijving) || typeof t.gereed !== 'boolean') fouten.push(`werkorder.taken[${i}]: taakId, omschrijving en gereed (boolean) zijn verplicht`);
  });
  if (!Array.isArray(w.materiaal)) fouten.push('werkorder.materiaal: moet een lijst zijn (mag leeg)');
  else w.materiaal.forEach((m, i) => {
    if (!isObj(m) || !isTekst(m.artikelnr) || !isTekst(m.omschrijving) || !Number.isInteger(m.aantal) && !(typeof m.aantal === 'number' && m.aantal > 0)) {
      fouten.push(`werkorder.materiaal[${i}]: artikelnr, omschrijving en aantal (>0) zijn verplicht`);
    }
  });
}

// Geeft { fouten: [], invoer } terug
function valideerPut(id, body) {
  const fouten = [];
  if (!isObj(body)) return { fouten: ['body: moet een JSON-object zijn'] };
  toegestaan(body, ['messageId', 'correlationId', 'versie', 'ingetrokken', 'reden', 'werkorder'], 'body', fouten);
  if (!isTekst(body.messageId)) fouten.push('messageId: verplicht');
  if (body.correlationId !== undefined && !isTekst(body.correlationId)) fouten.push('correlationId: moet tekst zijn');
  if (!Number.isInteger(body.versie) || body.versie < 1) fouten.push('versie: geheel getal >= 1');
  const ingetrokken = body.ingetrokken === true;
  if (body.ingetrokken !== undefined && typeof body.ingetrokken !== 'boolean') fouten.push('ingetrokken: moet boolean zijn');
  if (ingetrokken) {
    if (body.werkorder !== undefined) fouten.push('werkorder: niet toegestaan bij een intrekking');
  } else {
    if (body.reden !== undefined) fouten.push('reden: alleen toegestaan bij een intrekking');
    valideerWerkorder(body.werkorder, id, fouten);
  }
  if (fouten.length) return { fouten };
  return {
    fouten,
    invoer: {
      werkorderId: id, messageId: body.messageId, correlationId: body.correlationId,
      versie: body.versie, ingetrokken, reden: body.reden, werkorder: body.werkorder
    }
  };
}

module.exports = { valideerPut };
