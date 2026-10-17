'use strict';
// Canoniek EAM-model -> monteur-model (zie docs/architectuur-review.md, 4.6). Zuivere functie, geen I/O.
//
// Verliesgevend, bewust: het monteur-model kent geen sourceReference, asset, type, planning en eenheid. CANCELLED wordt
// status AFGEROND met ingetrokken=true.
const STATUS = {
  REQUESTED: 'OPEN', PLANNED: 'OPEN', ASSIGNED: 'OPEN',
  IN_PROGRESS: 'IN_BEHANDELING',
  COMPLETED: 'AFGEROND', CANCELLED: 'AFGEROND'
};
const PRIORITEIT = { HIGH: 'HOOG', NORMAL: 'NORMAAL', LOW: 'LAAG' };

class TransformFout extends Error {
  constructor(bericht) { super(bericht); this.name = 'TransformFout'; }
}

// Geeft de body voor PUT /intern/werkorders/{id}
function canoniekNaarMonteur(c) {
  const e = c.envelope;
  const w = c.workOrder;
  const basis = { messageId: e.messageId, correlationId: e.correlationId, versie: e.version };

  if (e.type === 'eam.workorder.cancelled' || w.status === 'CANCELLED') {
    return { werkorderId: w.id, body: { ...basis, ingetrokken: true, reden: w.cancellationReason } };
  }

  if (!STATUS[w.status]) throw new TransformFout(`onbekende status ${w.status}`);
  if (!PRIORITEIT[w.priority]) throw new TransformFout(`onbekende prioriteit ${w.priority}`);

  const locatie = {
    plaats: w.location.place,
    spoorEmplacement: w.location.site || w.location.place
  };
  if (w.location.lat !== undefined) locatie.coordinaten = { lat: w.location.lat, lon: w.location.lon };

  const werkorder = {
    werkorderId: w.id,
    status: STATUS[w.status],
    prioriteit: PRIORITEIT[w.priority],
    omschrijving: w.description,
    locatie,
    // De monteur-API kent geen "aangemaakt op"; het tijdstip van het eerste bericht is de beste benadering.
    // De API behoudt de waarde van de eerste versie bij een wijziging.
    aangemaaktOp: e.occurredAt,
    taken: (w.tasks || []).map((t) => ({ taakId: t.id, omschrijving: t.description, gereed: t.done })),
    materiaal: (w.materials || []).map((m) => ({ artikelnr: m.itemNumber, omschrijving: m.description, aantal: m.quantity }))
  };
  if (w.assignee) werkorder.monteur = { id: w.assignee.id, naam: w.assignee.name };

  return { werkorderId: w.id, body: { ...basis, ingetrokken: false, werkorder } };
}

module.exports = { canoniekNaarMonteur, TransformFout };
