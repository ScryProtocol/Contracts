const path = require("path");
const Ajv = require("ajv");

function normalizeSchema(schema) {
  const out = JSON.parse(JSON.stringify(schema));
  if (out.$id && !out.id) out.id = out.$id;
  delete out.$schema;
  return out;
}

function buildValidators() {
  const ajv = new Ajv({
    allErrors: true,
    jsonPointers: true,
    schemaId: "auto",
    unknownFormats: "ignore",
    validateSchema: false
  });

  const schemaDir = path.resolve(__dirname, "../../docs/schemas");
  const channelStateRaw = require(path.join(schemaDir, "scp.channel-state.v1.schema.json"));
  const quoteRequestRaw = require(path.join(schemaDir, "scp.quote-request.v1.schema.json"));
  const quoteResponseRaw = require(path.join(schemaDir, "scp.quote-response.v1.schema.json"));
  const ticketRaw = require(path.join(schemaDir, "scp.ticket.v1.schema.json"));

  const channelState = normalizeSchema(channelStateRaw);
  const quoteRequest = normalizeSchema(quoteRequestRaw);
  const quoteResponse = normalizeSchema(quoteResponseRaw);
  const ticket = normalizeSchema(ticketRaw);

  ajv.addSchema(channelState, channelState.id);
  ajv.addSchema(quoteRequest, quoteRequest.id);
  ajv.addSchema(quoteResponse, quoteResponse.id);
  ajv.addSchema(ticket, ticket.id);

  const issueRequest = normalizeSchema({
    id: "https://x402.org/schemas/scp.issue-request.v1.schema.json",
    type: "object",
    additionalProperties: false,
    required: ["quote", "channelState", "sigA"],
    properties: {
      quote: { $ref: quoteResponse.id },
      channelState: { $ref: channelState.id },
      sigA: { type: "string", pattern: "^0x[a-fA-F0-9]{2,4096}$" }
    }
  });

  const refundRequest = normalizeSchema({
    id: "https://x402.org/schemas/scp.refund-request.v1.schema.json",
    type: "object",
    additionalProperties: false,
    required: ["ticketId", "refundAmount", "reason"],
    properties: {
      ticketId: { type: "string", minLength: 6, maxLength: 128 },
      refundAmount: { type: "string", pattern: "^[0-9]+$" },
      reason: { type: "string", minLength: 1, maxLength: 280 }
    }
  });

  ajv.addSchema(issueRequest, issueRequest.id);
  ajv.addSchema(refundRequest, refundRequest.id);

  const validators = {
    quoteRequest: ajv.getSchema(quoteRequest.id),
    quoteResponse: ajv.getSchema(quoteResponse.id),
    ticket: ajv.getSchema(ticket.id),
    issueRequest: ajv.getSchema(issueRequest.id),
    refundRequest: ajv.getSchema(refundRequest.id)
  };

  return validators;
}

function validationMessage(validateFn) {
  if (!validateFn.errors || validateFn.errors.length === 0) {
    return "invalid payload";
  }
  return validateFn.errors
    .map((e) => `${e.dataPath || "/"} ${e.message}`.trim())
    .join("; ");
}

module.exports = { buildValidators, validationMessage };
