'use strict';
// Aanroep van PUT /intern/werkorders/{id} op de werkorder-api.
//
// Uitkomst:
//   { soort: 'OK', resultaat }          2xx (ook GENEGEERD en TOMBSTONE_BEWAARD: het bericht mag bevestigd worden)
//   { soort: 'PERMANENT', status, detail }  400/404/413/415/422: opnieuw proberen helpt niet
//   { soort: 'TIJDELIJK', reden }        netwerk, time-out, 5xx, 401/403 (misconfiguratie: herstelbaar door een operator), 429
const PERMANENT = new Set([400, 404, 405, 409, 413, 415, 422]);

// Authenticatie: tokenBron (Keycloak, service-account) heeft voorrang; zonder tokenBron valt hij terug op apiKey (alleen lokaal).
async function schrijfWerkorder({ baseUrl, apiKey, tokenBron, werkorderId, body, timeoutMs = 5000, fetchFn = fetch }) {
  const auth = {};
  if (tokenBron) {
    try { auth.Authorization = `Bearer ${await tokenBron.haal()}`; }
    catch (fout) { return { soort: 'TIJDELIJK', reden: `geen token: ${fout.message}` }; }
  } else {
    auth['X-Api-Key'] = apiKey;
  }
  let antwoord;
  try {
    antwoord = await fetchFn(`${baseUrl}/intern/werkorders/${encodeURIComponent(werkorderId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (fout) {
    return { soort: 'TIJDELIJK', reden: `werkorder-api niet bereikbaar: ${fout.name === 'TimeoutError' ? 'time-out' : fout.message}` };
  }
  let tekst = '';
  try { tekst = await antwoord.text(); } catch (_) { /* leeg */ }

  if (antwoord.status >= 200 && antwoord.status < 300) {
    let resultaat = null;
    try { resultaat = JSON.parse(tekst); } catch (_) { /* geen JSON: niet erg */ }
    return { soort: 'OK', resultaat };
  }
  if (PERMANENT.has(antwoord.status)) return { soort: 'PERMANENT', status: antwoord.status, detail: tekst.slice(0, 1000) };
  // 401/403: het token is niet (meer) geldig of de rol ontbreekt. Een nieuw token kan helpen; een operator moet het oplossen als het blijft duren.
  if (tokenBron && (antwoord.status === 401 || antwoord.status === 403)) tokenBron.vergeet();
  return { soort: 'TIJDELIJK', reden: `werkorder-api antwoordde ${antwoord.status}` };
}

module.exports = { schrijfWerkorder };
