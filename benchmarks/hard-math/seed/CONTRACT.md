# Exact roots workbench v1

Implement an original certified real-root solver; do not wrap a CAS root solver.
Use native BigInt or ordinary rational arithmetic libraries. No authentication or billing.

`node src/cli.mjs` reads one JSON object per stdin line. Request:
`{"coefficients":["1","0","-2"],"precisionBits":64}`.
Coefficients are decimal integer strings in descending power order. Trim leading
zeros. Reject zero polynomials and malformed requests. A nonzero constant has no roots.
Return `{"roots":[{"lo":{"n":"1","d":"1"},"hi":{"n":"3","d":"2"},"multiplicity":1}]}`
(the example shape does not meet the example request's precision).
All rationals are reduced with positive denominators. Closed intervals are sorted,
pairwise disjoint, each contains exactly one distinct real root. Endpoints must
not be roots unless the interval is a singleton. Width is at most 2^-precisionBits.
Return every real root exactly once with its exact positive integer multiplicity.
Invalid input returns `{"error":{"code":"INVALID_JSON"|"INVALID_REQUEST"|"ZERO_POLYNOMIAL"}}`;
the CLI continues reading subsequent lines but exits nonzero if any line failed.

`node src/server.mjs` listens on HOST (default 127.0.0.1), PORT (default 8080).
POST /roots accepts `{"jobs":[<CLI requests>]}` and returns
`{"results":[<CLI responses>]}` in order, including per-job errors. Invalid JSON
or a malformed jobs envelope returns HTTP 400 and a stable JSON error.
GET / serves public/index.html and its same-origin public/app.mjs. Browser form:
#coefficients (space separated integers), #precisionBits, #solve button,
#results text contains each reduced lo and hi as n/d and multiplicity, #error
contains error code/text. The UI submits POST /roots and displays the returned
verified interval values without rounding them to floating point.

## Frozen module interfaces (ES modules)

* src/contract.mjs: `parseRequest(value)` returns {coefficients:BigInt[],precisionBits};
  `failure(error)` returns JSON error. Errors have a `code` field.
* src/arithmetic.mjs: rationals {n:BigInt,d:BigInt}, `rational(n,d)`, `add(a,b)`,
  `sub(a,b)`, `mul(a,b)`, `div(a,b)`, `compare(a,b)`; polynomials are rational
  coefficients in descending order, `trim(p)`, `derivative(p)`, `evaluate(p,x)`,
  `divide(p,q)` returns {quotient,remainder}, `gcd(p,q)` monic.
* src/square-free.mjs: `squareFree(coefficients:BigInt[])` returns
  [{polynomial: rational[], multiplicity:number}], nonconstant square-free factors.
* src/isolate.mjs: `isolate(polynomial,precisionBits)` returns sorted
  [{lo:rational,hi:rational}] containing every distinct real root of a square-free
  rational polynomial. Implement exact Sturm/subresultant counting and isolation.
* src/solver.mjs: `solve(value)` composes the above, outputs the JSON response.
* src/cli.mjs: JSON-lines adapter; src/server.mjs: HTTP adapter;
  public/app.mjs: browser adapter. No adapter implements its own solver.

The independent oracle and evaluated tests are outside this repository and are
not writable by implementation sessions. No producer credentials belong here.
The finite profile, generator and independent verifier are frozen before evaluation.
