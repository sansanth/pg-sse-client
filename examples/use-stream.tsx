// A React hook around `connect`: the stream lives as long as the component, and closing it is the cleanup.
import { useEffect, useState } from 'react';
import { connect, type SseEvent } from 'pg-sse-client';

export function useStream(url: string, getToken: () => Promise<string>) {
  const [events, setEvents] = useState<SseEvent[]>([]);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const stream = connect(url, {
      headers: async () => ({ Authorization: `Bearer ${await getToken()}` }),
      onOpen: () => setLive(true),
      onDisconnect: () => setLive(false),
      onEvent: (event) => setEvents((seen) => [...seen, event]),
    });
    return () => stream.close();
  }, [url, getToken]);

  return { events, live };
}
