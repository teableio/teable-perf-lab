import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { readSseEvents } from "./sse-reader.ts";

const frame = (event) => `data: ${JSON.stringify(event)}\n`;
const terminal = (event) => event.id === "done" || event.id === "error";
const progress = {
  id: "progress",
  deletedCount: 2,
  lastCommittedBatchIndex: 0,
  recordIds: ["rec-1", "rec-2"],
};

const fetchReader = async (t, send) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    send(response);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}`);
  return response.body.getReader();
};

test("awaits callbacks without retaining history", async (t) => {
  const reader = await fetchReader(t, (response) => {
    response.end(frame(progress) + frame({ id: "done", deletedCount: 2 }));
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const seen = [];
  const pending = readSseEvents(reader, {
    collectEvents: false,
    isTerminal: terminal,
    onEvent: async (event) => {
      seen.push(event.id);
      if (event.id === "progress") {
        entered();
        await gate;
        seen.push("consumed");
      }
    },
  });
  await started;
  await new Promise(setImmediate);
  assert.deepEqual(seen, ["progress"]);
  release();
  assert.deepEqual(await pending, []);
  assert.deepEqual(seen, ["progress", "consumed", "done"]);
});

for (const id of ["done", "error"]) {
  test(`${id} stops before EOF`, { timeout: 2000 }, async (t) => {
    const reader = await fetchReader(t, (response) => {
      // Deliberately leave HTTP open: completion must not wait for EOF.
      response.write(frame({ id }) + frame(progress));
    });
    const seen = [];
    const events = await readSseEvents(reader, {
      isTerminal: terminal,
      onEvent: (event) => seen.push(event.id),
    });
    assert.deepEqual(seen, [id]);
    assert.deepEqual(events, [{ id }]);
  });
}

test("default reader continues after error and done", async (t) => {
  const events = [{ id: "error" }, { id: "done" }, progress];
  const reader = await fetchReader(t, (response) => {
    response.end(events.map(frame).join(""));
  });
  assert.deepEqual(await readSseEvents(reader), events);
});

test("fragmented EOF preserves the observed prefix", async (t) => {
  const payload = frame(progress).trimEnd();
  const reader = await fetchReader(t, (response) => {
    response.write(payload.slice(0, 13));
    setImmediate(() => response.end(payload.slice(13)));
  });
  const seen = [];
  const events = await readSseEvents(reader, {
    collectEvents: false,
    isTerminal: terminal,
    onEvent: (event) => seen.push(event),
  });
  assert.deepEqual(events, []);
  assert.deepEqual(seen, [progress]);
  assert.equal(seen[0].deletedCount, 2);
  assert.equal(seen[0].lastCommittedBatchIndex, 0);
  assert.equal(seen.some(terminal), false);
});

test("callback failure preserves the original error", async (t) => {
  const reader = await fetchReader(t, (response) => {
    response.write(frame(progress) + frame({ id: "done" }));
  });
  const failure = new Error("consumer stopped");
  const seen = [];
  await assert.rejects(
    readSseEvents(reader, {
      onEvent: (event) => {
        seen.push(event.id);
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(seen, ["progress"]);
});
