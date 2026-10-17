// Voorbeelddata: de startinhoud van een lege database (alleen voor de PoC).
// Het zijn werkorders in het monteur-model, versie 1.
// Let op: "taken" en "materiaal" zijn lijsten (kardinaliteit 0..*)
// ---------------------------------------------------------------
const WERKORDERS = {
  'WO-1001': {
    werkorderId: 'WO-1001',
    status: 'OPEN',
    prioriteit: 'HOOG',
    omschrijving: 'Storing wissel 214, wisselmotor reageert niet',
    locatie: { plaats: 'Breda', spoorEmplacement: 'Breda Noord', coordinaten: { lat: 51.6, lon: 4.78 } },
    monteur: { id: 'M-017', naam: 'J. de Vries' },
    aangemaaktOp: '2026-10-16T06:12:00Z',
    taken: [
      { taakId: 'T-1', omschrijving: 'Wissel veiligstellen', gereed: true },
      { taakId: 'T-2', omschrijving: 'Wisselmotor controleren', gereed: false },
      { taakId: 'T-3', omschrijving: 'Rapport invullen', gereed: false }
    ],
    materiaal: [
      { artikelnr: 'WM-204', omschrijving: 'Wisselmotor 220V', aantal: 1 }
    ]
  },
  'WO-1002': {
    werkorderId: 'WO-1002',
    status: 'IN_BEHANDELING',
    prioriteit: 'NORMAAL',
    omschrijving: 'Seinlamp vervangen',
    locatie: { plaats: 'Tilburg', spoorEmplacement: 'Tilburg West', coordinaten: { lat: 51.56, lon: 5.08 } },
    monteur: { id: 'M-017', naam: 'J. de Vries' },
    aangemaaktOp: '2026-10-16T07:40:00Z',
    taken: [
      { taakId: 'T-1', omschrijving: 'Lamp vervangen', gereed: false }
    ],
    materiaal: []
  },
  'WO-1003': {
    werkorderId: 'WO-1003',
    status: 'AFGEROND',
    prioriteit: 'LAAG',
    omschrijving: 'Jaarlijkse inspectie overweg',
    locatie: { plaats: 'Eindhoven', spoorEmplacement: 'Eindhoven Zuid', coordinaten: { lat: 51.43, lon: 5.48 } },
    monteur: { id: 'M-022', naam: 'S. Jansen' },
    aangemaaktOp: '2026-10-15T13:05:00Z',
    taken: [
      { taakId: 'T-1', omschrijving: 'Inspectie uitvoeren', gereed: true },
      { taakId: 'T-2', omschrijving: 'Rapport indienen', gereed: true }
    ],
    materiaal: []
  }
};

module.exports = { WERKORDERS };
