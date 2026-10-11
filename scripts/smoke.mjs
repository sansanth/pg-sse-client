// Loads the built package the way a consumer on plain Node ESM does, by name, through its `exports` map, and makes one real
// request with it. A relative import without a file extension passes the type check and every bundler but fails here, and
// a call the oldest supported Node lacks fails only when it runs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { gzipSync } from 'node:zlib';

const main = await import('pg-sse-client');
const parser = await import('pg-sse-client/parser');

assert.deepEqual(Object.keys(main).sort(), ['SseEventTooLarge', 'StreamEndedEarly', 'StreamRefused', 'StreamTimeout', 'connect', 'createSseParser', 'readSse']);
assert.deepEqual(Object.keys(parser).sort(), ['SseEventTooLarge', 'createSseParser', 'readSse']);
assert.deepEqual(parser.createSseParser().push('data: ok\n\n'), [{ event: 'message', data: 'ok', id: '' }]);

const requests = [];
const server = http.createServer((request, response) => {
  requests.push(request.headers);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write('id: 1\nevent: change\ndata: {"n":1}\n\n');
  response.end('retry: 10\nevent: end\ndata: {"reason":"max_age"}\n\n');
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const events = [];
const ends = [];
await new Promise((done, fail) => {
  const timer = setTimeout(() => fail(new Error('the built client got no goodbye in 5 s')), 5000);
  const connection = main.connect(`http://127.0.0.1:${server.address().port}/`, {
    onEvent: (event) => events.push(event),
    onEnd: (reason) => {
      ends.push(reason);
      clearTimeout(timer);
      connection.close();
      done();
    },
  });
});
server.closeAllConnections();
await new Promise((done) => server.close(done));

assert.deepEqual(events, [{ event: 'change', data: '{"n":1}', id: '1' }]);
assert.deepEqual(ends, ['max_age']);
assert.equal(requests[0].accept, 'text/event-stream');
// A guard on the size of the built files, gzipped and unminified, which a consumer's bundler shrinks to about a third.
const dist = new URL('../dist/', import.meta.url);
const gzipped = readdirSync(dist)
  .filter((name) => name.endsWith('.js'))
  .reduce((total, name) => total + gzipSync(readFileSync(new URL(name, dist))).length, 0);
assert.ok(gzipped < 12_000, `the built package is ${gzipped} bytes gzipped, over the 12 kB this guard allows`);

console.log('the built package loads and reads a stream');
