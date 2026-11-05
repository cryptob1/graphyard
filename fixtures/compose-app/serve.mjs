// The fixture Compose application's page: one heading on every path.
import http from 'node:http';
http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end('<!doctype html><title>Fixture compose app</title><h1>Fixture compose app</h1>');
}).listen(8080, '0.0.0.0');
