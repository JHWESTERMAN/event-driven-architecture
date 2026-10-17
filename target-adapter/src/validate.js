'use strict';
// Laadt het canonieke schema uit de contracts-map. De target-adapter vertrouwt het bericht niet blind, ook al
// heeft de source-adapter het al gevalideerd: er staat een broker tussen en schema's kunnen uit de pas lopen.
const fs = require('fs');
const path = require('path');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

function laadValidator(contractsDir) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(path.join(contractsDir, 'canoniek', 'eam-workorder-1.0.schema.json'), 'utf8'));
  const validator = ajv.compile(schema);
  return (data) => {
    if (validator(data)) return { ok: true, fouten: [] };
    return {
      ok: false,
      fouten: validator.errors.filter((e) => e.keyword !== 'if').slice(0, 10).map((e) => ({ pad: e.instancePath || '/', melding: e.message }))
    };
  };
}

module.exports = { laadValidator };
