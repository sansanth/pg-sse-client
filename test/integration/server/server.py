"""
A pg-sse chat server for the client's integration tests. It binds a free local port, prints `listening <port>` and
serves until it gets SIGTERM, which ends every stream with the `shutdown` goodbye and drops its schema.

    PG_SSE_TEST_DSN=postgresql://sse:sse@127.0.0.1:55432/pg_sse_test uv run --project test/integration/server python test/integration/server/server.py

Settings: MAX_STREAM_SECONDS (default 900), MAX_SUBSCRIBERS (default 500), PING_SECONDS (default 15),
TOKEN (when set, /private/... needs it as a bearer token).
"""

import asyncio
import contextlib
import os
import socket
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import partial
from typing import Annotated

import psycopg
import uvicorn
from fastapi import FastAPI, Header, HTTPException
from psycopg.conninfo import make_conninfo
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel

from pg_sse import Event, Hub, trigger_sql

SCHEMA = f"t_{uuid.uuid4().hex[:12]}"
BASE_DSN = os.environ["PG_SSE_TEST_DSN"]
DSN = make_conninfo(BASE_DSN, options=f"-csearch_path={SCHEMA}")
TOKEN = os.environ.get("TOKEN")
PING = float(os.environ.get("PING_SECONDS", "15"))

hub = Hub(
    DSN,
    channel=SCHEMA,
    end_event="end",
    max_stream_seconds=float(os.environ.get("MAX_STREAM_SECONDS", "900")),
    max_subscribers=int(os.environ.get("MAX_SUBSCRIBERS", "500")),
    ping_seconds=(PING, PING),
)
pool = AsyncConnectionPool(DSN, open=False)


def setup() -> None:
    with psycopg.connect(BASE_DSN, autocommit=True) as conn:
        conn.execute(f'CREATE SCHEMA "{SCHEMA}"')
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute("CREATE TABLE messages (id bigserial PRIMARY KEY, room text NOT NULL, body text NOT NULL)")
        conn.execute(trigger_sql("messages", key_column="room", channel=SCHEMA, order_column="id"))


def teardown() -> None:
    with psycopg.connect(BASE_DSN, autocommit=True) as conn:
        conn.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    try:
        await pool.open()
        async with hub.lifespan():
            yield
    finally:
        await pool.close()
        # Here and not after the server returns: uvicorn re-raises the SIGTERM it caught once it has shut down, which
        # ends the process before anything below `serve` runs.
        await asyncio.to_thread(teardown)


app = FastAPI(lifespan=lifespan)


async def read_after(room: str, after: int) -> list[Event]:
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT id, body FROM messages WHERE room = %s AND id > %s ORDER BY id LIMIT 500", (room, after)
        )
        rows = await cur.fetchall()
    return [Event({"id": message_id, "body": body}, id=message_id) for message_id, body in rows]


async def latest_id(room: str) -> int:
    async with pool.connection() as conn:
        cur = await conn.execute("SELECT coalesce(max(id), 0) FROM messages WHERE room = %s", (room,))
        row = await cur.fetchone()
    return row[0] if row else 0


def stream_for(room: str, last_event_id: str | None):
    cursor = int(last_event_id) if last_event_id and last_event_id.isascii() and last_event_id.isdigit() and len(last_event_id) < 16 else None
    return hub.sse(room, read=partial(read_after, room), cursor=cursor, start=partial(latest_id, room))


@app.get("/rooms/{room}/stream")
async def stream(room: str, last_event_id: Annotated[str | None, Header()] = None):
    return stream_for(room, last_event_id)


@app.get("/private/{room}/stream")
async def private_stream(
    room: str,
    last_event_id: Annotated[str | None, Header()] = None,
    authorization: Annotated[str | None, Header()] = None,
):
    if TOKEN is None or authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401)
    return stream_for(room, last_event_id)


@app.get("/stats")
async def stats() -> dict[str, int]:
    return {"open_streams": hub.stats().open_streams}


class NewMessage(BaseModel):
    body: str


@app.post("/rooms/{room}/messages")
async def post_message(room: str, message: NewMessage) -> dict[str, int | None]:
    async with pool.connection() as conn:
        cur = await conn.execute("INSERT INTO messages (room, body) VALUES (%s, %s) RETURNING id", (room, message.body))
        row = await cur.fetchone()
    return {"id": row[0] if row else None}


async def main() -> None:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    # Listening, not just bound: a request that comes before uvicorn has started queues instead of being refused.
    sock.listen()
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
    print(f"listening {sock.getsockname()[1]}", flush=True)  # noqa: T201 -- the test harness reads this line
    await server.serve(sockets=[sock])


if __name__ == "__main__":
    try:
        setup()
        asyncio.run(main())
    finally:
        # A start that fails before the lifespan runs has nothing else to drop the schema; after a SIGTERM this is not reached.
        with contextlib.suppress(Exception):
            teardown()
