export function parseRequest(value) {
  if (!value || !Array.isArray(value.coefficients) || !value.coefficients.length ||
      value.coefficients.some(c => typeof c !== 'string' || !/^-?[0-9]+$/.test(c)) ||
      !Number.isSafeInteger(value.precisionBits) || value.precisionBits < 1) {
    throw Object.assign(new Error('Invalid request'), {code:'INVALID_REQUEST'});
  }
  const coefficients = value.coefficients.map(BigInt);
  while (coefficients.length && coefficients[0] === 0n) coefficients.shift();
  if (!coefficients.length) throw Object.assign(new Error('Zero polynomial'), {code:'ZERO_POLYNOMIAL'});
  return {coefficients,precisionBits:value.precisionBits};
}
export function failure(error) { return {error:{code:error.code ?? 'INVALID_REQUEST'}}; }
