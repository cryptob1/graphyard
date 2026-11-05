import {parseRequest} from './contract.mjs';
// Deliberately incorrect starter. The external verifier must reject it.
export function solve(value) { parseRequest(value); return {roots:[]}; }
