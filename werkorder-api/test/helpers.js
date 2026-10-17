const wo = (over = {}) => ({
  werkorderId: 'WO-2001', status: 'OPEN', prioriteit: 'HOOG', omschrijving: 'Storing wissel 214',
  locatie: { plaats: 'Breda', spoorEmplacement: 'Breda Noord', coordinaten: { lat: 51.567093, lon: 4.776389 } },
  monteur: { id: 'M-017', naam: 'J. de Vries' }, aangemaaktOp: '2026-10-17T08:15:00Z',
  taken: [{ taakId: 'T-1', omschrijving: 'Wissel veiligstellen', gereed: false }],
  materiaal: [{ artikelnr: 'WM-204', omschrijving: 'Wisselmotor 220V', aantal: 1 }],
  ...over
});
const put = (versie, werkorder, extra = {}) => ({ werkorderId: 'WO-2001', messageId: `m-${versie}`, correlationId: 'c-1', versie, ingetrokken: false, werkorder, ...extra });
const intrek = (versie, extra = {}) => ({ werkorderId: 'WO-2001', messageId: `m-${versie}`, correlationId: 'c-1', versie, ingetrokken: true, reden: 'DUPLICATE', ...extra });
module.exports = { wo, put, intrek };
