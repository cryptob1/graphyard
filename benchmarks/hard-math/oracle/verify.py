"""Producer-owned exact verifier; never copied into an implementation repository.
JSON-lines: {request, output} -> {pass, reason}; reference is calibration/fixtures only.
"""
import json, sys, math
import sympy as s
import mpmath
if s.__version__ != '1.14.0' or mpmath.__version__ != '1.3.0':
    raise RuntimeError('Pinned SymPy 1.14.0 / mpmath 1.3.0 required')
x = s.Symbol('x')
def polynomial(request):
    cs = request['coefficients']
    if not isinstance(cs, list) or not cs or any(not isinstance(c,str) or not c.lstrip('-').isdigit() or c.startswith('--') for c in cs):
        raise ValueError('INVALID_REQUEST')
    bits=request['precisionBits']
    if type(bits) is not int or bits < 1: raise ValueError('INVALID_REQUEST')
    p=s.Poly.from_list([int(c) for c in cs],x,domain=s.ZZ)
    if p.is_zero: raise ValueError('ZERO_POLYNOMIAL')
    return p, bits

def rational(v):
    if set(v)!= {'n','d'}: raise ValueError('rational fields')
    n,d=v['n'],v['d']
    if not isinstance(n,str) or not isinstance(d,str) or not n.lstrip('-').isdigit() or not d.isdigit(): raise ValueError('rational decimal strings')
    a,b=int(n),int(d)
    if b<=0 or math.gcd(a,b)!=1: raise ValueError('rational not reduced/positive')
    return s.Rational(a,b)

def reference(request):
    p,bits=polynomial(request)
    encode=lambda q:{'n':str(q.p),'d':str(q.q)}
    return {'roots':[{'lo':encode(a),'hi':encode(b),'multiplicity':int(m)} for (a,b),m in p.intervals(eps=s.Rational(1,2**bits))]}

def verify(request, output):
    p,bits=polynomial(request)
    if set(output)!= {'roots'} or not isinstance(output['roots'],list): raise ValueError('roots shape')
    factors=p.sqf_list()[1]
    total=int(p.sqf_part().count_roots(-s.oo,s.oo)) if p.degree()>0 else 0
    roots=output['roots']
    if len(roots)!=total: raise ValueError('incomplete distinct real roots')
    previous=None
    for r in roots:
        if set(r)!= {'lo','hi','multiplicity'}: raise ValueError('root fields')
        lo,hi=rational(r['lo']),rational(r['hi'])
        if lo>hi or hi-lo>s.Rational(1,2**bits): raise ValueError('interval precision/order')
        if previous is not None and previous>=lo: raise ValueError('intervals overlap or unsorted')
        previous=hi
        m=r['multiplicity']
        if type(m) is not int or m<1: raise ValueError('multiplicity shape')
        if lo==hi:
            if p.eval(lo)!=0: raise ValueError('singleton is not root')
            matched=[power for factor,power in factors if factor.eval(lo)==0]
        else:
            if p.eval(lo)==0 or p.eval(hi)==0: raise ValueError('root endpoint requires singleton')
            if p.sqf_part().count_roots(lo,hi)!=1: raise ValueError('not an isolating interval')
            matched=[power for factor,power in factors if factor.count_roots(lo,hi)==1]
        if matched!=[m]: raise ValueError('wrong multiplicity')
    return {'pass':True,'distinctRoots':total}

for line in sys.stdin:
    try:
        v=json.loads(line)
        result=reference(v['request']) if v.get('reference') else verify(v['request'],v['output'])
        print(json.dumps(result),flush=True)
    except Exception as e:
        print(json.dumps({'pass':False,'reason':str(e)}),flush=True)
