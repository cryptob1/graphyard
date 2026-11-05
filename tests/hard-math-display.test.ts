import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { displayedRootValues, verifyDisplayedRoots } from '../benchmarks/hard-math/display.js';

// Narrow browser diagnostics share the actual certification helper. No scratch
// plane, solver, API or oracle is replaced in the ordinary nine-case smoke run.
const roots=[
  {lo:{n:'-23',d:'11'},hi:{n:'-25',d:'12'},multiplicity:2},
  {lo:{n:'31',d:'13'},hi:{n:'43',d:'18'},multiplicity:3},
];
const row=(root:typeof roots[number])=>`${root.lo.n}/${root.lo.d} .. ${root.hi.n}/${root.hi.d} multiplicity ${root.multiplicity}`;
const records=(values=roots)=>values.map(row).join('\n');

test('root display tokenization keeps exact fractions separate from multiplicities',()=>{
  assert.deepEqual(displayedRootValues(records()),['-23/11','-25/12','2','31/13','43/18','3']);
  assert.deepEqual(displayedRootValues('Root 1: -23 / 11 .. -25 / 12 multiplicity 2'),['-23/11','-25/12','2']);
  assert.deepEqual(displayedRootValues('No real roots'),[]);
  assert.deepEqual(displayedRootValues('0 real roots'),[]);
  assert.notDeepEqual(displayedRootValues(records().replace(/ multiplicity [23]/g,'')),displayedRootValues(records()));
});

test('integration:hard-math-smoke — Chromium rejects incomplete or mismatched displayed root records',async()=>{
  const browser=await chromium.launch({headless:true,timeout:10_000});
  try {
    const page=await browser.newPage();
    const results=page.locator('#results');
    // All layouts obey the same frozen text contract; none requires new tags.
    for(const html of [
      `<pre id="results">${records()}</pre>`,
      `<div id="results">${roots.map(r=>`<p>${row(r)}</p>`).join('')}</div>`,
      `<table id="results"><thead><tr><th>lo</th><th>hi</th><th>multiplicity</th></tr></thead><tbody>${roots.map(r=>`<tr><td>${r.lo.n}/${r.lo.d}</td><td>${r.hi.n}/${r.hi.d}</td><td>${r.multiplicity}</td></tr>`).join('')}</tbody></table>`,
      `<div id="results">${roots.map((r,i)=>`Root ${i+1}: ${row(r)}`).join('<br>')}</div>`,
    ]) {
      await page.setContent(html);
      await verifyDisplayedRoots(results,roots,200);
    }
    const negatives:[string,string][]=[
      ['swapped upper endpoints',records(roots.map((r,i)=>({...r,hi:roots[1-i].hi})))],
      ['swapped multiplicities',records(roots.map((r,i)=>({...r,multiplicity:roots[1-i].multiplicity})))],
      ['extra wrong root',records()+'\n99/1 .. 99/1 multiplicity 1'],
      ['duplicate root',records()+'\n'+row(roots[0])],
      ['missing root',row(roots[0])],
      ['wrong order',records([...roots].reverse())],
      ['fraction digits masquerading as multiplicity',records().replace(/ multiplicity [23]/g,'')],
      ['unreduced endpoint',records().replace('-23/11','-46/22')],
    ];
    for(const [label,text] of negatives) {
      await page.setContent('<pre id="results"></pre>');
      await results.evaluate((element,value)=>{element.textContent=value;},text);
      await assert.rejects(verifyDisplayedRoots(results,roots,100),/UI complete root records/,label);
    }
    for(const text of ['', 'No real roots', '0 real roots']) {
      await results.evaluate((element,value)=>{element.textContent=value;},text);
      await verifyDisplayedRoots(results,[],200);
    }
    for(const text of [records(),'No real roots\n'+row(roots[0])]) {
      await results.evaluate((element,value)=>{element.textContent=value;},text);
      await assert.rejects(verifyDisplayedRoots(results,[],100),/UI complete root records/,'stale/extra roots on empty answer');
    }
  } finally {await browser.close();}
});
