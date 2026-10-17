'use strict';
// Haalt een access token op bij Keycloak met de client credentials grant (service-account) en bewaart het tot kort voor het verloopt.
// Gelijktijdige aanvragen delen één ophaalactie. Gaat het mis, dan gooit haal() een fout; de aanroeper behandelt dat als een tijdelijke fout.
function maakTokenBron({ tokenUrl, clientId, clientSecret, timeoutMs = 5000, margeMs = 30000, fetchFn = fetch, nu = Date.now }) {
  let token = null;
  let verlooptOp = 0;
  let bezig = null;

  async function ophalen() {
    let antwoord;
    try {
      antwoord = await fetchFn(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      throw new Error(`Keycloak niet bereikbaar: ${e.name === 'TimeoutError' ? 'time-out' : e.message}`);
    }
    if (!antwoord.ok) throw new Error(`Keycloak weigerde de inlog van client '${clientId}' (HTTP ${antwoord.status})`);
    const j = await antwoord.json().catch(() => null);
    if (!j || typeof j.access_token !== 'string') throw new Error('Keycloak gaf geen access token');
    token = j.access_token;
    verlooptOp = nu() + (Number(j.expires_in) || 60) * 1000;
    return token;
  }

  return {
    async haal() {
      if (token && nu() < verlooptOp - margeMs) return token;
      if (!bezig) bezig = ophalen().finally(() => { bezig = null; });
      return bezig;
    },
    vergeet() { token = null; verlooptOp = 0; }
  };
}

module.exports = { maakTokenBron };
