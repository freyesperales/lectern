#!/usr/bin/env node
/*
 * A 40-line static server, for the cases where file:// is not enough.
 *
 * lectern is built to work by double-clicking index.html, and it does. But
 * Safari refuses some local subresource loads, and a few corporate browser
 * policies disable file:// script loading entirely. If index.html opens blank,
 * run this and use the printed URL instead.
 *
 *   node tools/serve.js [port]
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const port = Number(process.argv[2] || 8173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.c': 'text/plain; charset=utf-8',
  '.h': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const target = path.resolve(root, rel);

  /* Never serve anything outside the project directory. */
  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(target, (err, body) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store'
    }).end(body);
  });
}).listen(port, '127.0.0.1', () => {
  console.log('lectern is at http://127.0.0.1:' + port + '/  (ctrl-c to stop)');
});
