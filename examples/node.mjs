// Logs a stream until it is over, or until Ctrl-C.
//
//     npm run build
//     TOKEN=secret node examples/node.mjs https://api.example/rooms/lobby/stream
//
// Run it from a project that has installed pg-sse-client, and the import below is the same.
import { connect } from 'pg-sse-client';

const url = process.argv[2];
if (!url) {
  console.error('usage: node examples/node.mjs <stream url>');
  process.exit(1);
}

const stream = connect(url, {
  headers: () => (process.env.TOKEN ? { Authorization: `Bearer ${process.env.TOKEN}` } : {}),
  onOpen: () => console.log('open'),
  onEvent: (event) => console.log(event.id, event.event, event.data),
  onEnd: (reason) => console.log('the server said goodbye:', reason),
  onError: (error, { failures }) => console.log(`attempt failed (${failures} in a row):`, error.message),
  onClose: (error) => {
    console.log('closed', error ? `because: ${error.message}` : '');
    process.exit(error ? 1 : 0);
  },
});

process.on('SIGINT', () => stream.close());
