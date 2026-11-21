// Typed errors for the consult tool. A failure must stop the run, never silently fall back to another model.
export const CODES = [
  'INVALID_INPUT',
  'NEEDS_SIGN_IN',
  'MODEL_UNAVAILABLE',
  'USAGE_LIMIT',
  'CONSENT_REQUIRED',
  'CHALLENGE_REQUIRED',
  'UI_CHANGED',
  'GENERATION_TIMEOUT',
  'GENERATION_PENDING', // not a failure: the prompt was sent once and the answer can be collected
  'UNSTRUCTURED_RESPONSE',
  'BROWSER_UNAVAILABLE',
  'BUSY',
];

export class ConsultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConsultError';
    this.code = CODES.includes(code) ? code : 'UI_CHANGED';
  }
}
