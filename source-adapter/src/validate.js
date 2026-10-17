'use strict';
// Laadt het bronschema en het canonieke schema uit de contracts-map en maakt er validators van.
const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

function laadValidators(contractsDir) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const lees = (...delen) => JSON.parse(fs.readFileSync(path.join(contractsDir, ...delen), 'utf8'));
  const bron = ajv.compile(lees('bron', 'werkopdracht-1.0.schema.json'));
  const canoniek = ajv.compile(lees('canoniek', 'eam-workorder-1.0.schema.json'));

  // Geeft { ok, fouten } terug. De 'if'-regels van conditionele schema's laten we weg: dat is ruis.
  const maak = (validator) => (data) => {
    if (validator(data)) return { ok: true, fouten: [] };
    const fouten = validator.errors
      .filter((e) => e.keyword !== 'if')
      .slice(0, 10)
      .map((e) => ({ pad: e.instancePath || '/', melding: e.message }));
    return { ok: false, fouten };
  };
  return { valideerBron: maak(bron), valideerCanoniek: maak(canoniek) };
}

module.exports = { laadValidators };
