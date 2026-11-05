import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {solve} from './solver.mjs';
import {failure} from './contract.mjs';
const server=createServer(async(req,res)=>{
  if(req.method==='POST' && req.url==='/roots') {
    res.setHeader('Content-Type','application/json');
    let envelope;
    try { let body=''; for await(const part of req) body+=part; envelope=JSON.parse(body); }
    catch { res.writeHead(400); res.end(JSON.stringify({error:{code:'INVALID_JSON'}})); return; }
    if(!envelope || !Array.isArray(envelope.jobs)) { res.writeHead(400); res.end(JSON.stringify({error:{code:'INVALID_REQUEST'}})); return; }
    const results=envelope.jobs.map(job=>{try{return solve(job);}catch(error){return failure(error);}});
    res.end(JSON.stringify({results})); return;
  }
  const name=req.url==='/'?'index.html':req.url==='/app.mjs'?'app.mjs':null;
  if(!name) {res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',name.endsWith('.html')?'text/html':'text/javascript');
  res.end(await readFile(new URL('../public/'+name,import.meta.url)));
});
server.listen(Number(process.env.PORT??8080),process.env.HOST??'127.0.0.1');
