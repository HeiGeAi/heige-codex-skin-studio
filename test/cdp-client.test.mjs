import assert from "node:assert/strict";
import test from "node:test";

import {
  CdpSession,
  fetchRendererTargets,
  filterRendererTargets,
  waitForRendererTargets,
} from "../src/cdp-client.mjs";

const LOOPBACK_SOCKET_URL = "ws://127.0.0.1:9341/devtools/page/target-a";

function rendererTarget(overrides = {}) {
  return {
    id: "target-a",
    title: "Codex",
    type: "page",
    url: "app://codex/index.html",
    webSocketDebuggerUrl: LOOPBACK_SOCKET_URL,
    ...overrides,
  };
}

function okResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  };
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  static reset() {
    FakeWebSocket.instances = [];
  }

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closeCalls = 0;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({ type: "open" });
  }

  send(payload) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("socket is not open");
    }
    this.sent.push(JSON.parse(payload));
  }

  respond(id, result) {
    this.onmessage?.({ data: JSON.stringify({ id, result }) });
  }

  respondWithError(id, error) {
    this.onmessage?.({ data: JSON.stringify({ id, error }) });
  }

  respondRaw(data) {
    this.onmessage?.({ data });
  }

  emitError(error) {
    this.onerror?.({ error, message: error.message, type: "error" });
  }

  remoteClose(code = 1006, reason = "abnormal closure") {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: false, type: "close" });
  }

  close() {
    this.closeCalls += 1;
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "", wasClean: true, type: "close" });
  }
}

async function openFakeSession({ commandTimeoutMs = 100 } = {}) {
  FakeWebSocket.reset();
  const session = new CdpSession(LOOPBACK_SOCKET_URL, {
    WebSocketImpl: FakeWebSocket,
    commandTimeoutMs,
  });
  const opening = session.open();
  const socket = FakeWebSocket.instances[0];

  assert.ok(socket, "open() should construct a WebSocket");
  assert.equal(socket.url, LOOPBACK_SOCKET_URL);
  socket.open();
  assert.deepEqual(
    socket.sent.map(({ method }) => method),
    ["Runtime.enable", "Page.enable"],
  );
  for (const { id } of socket.sent) socket.respond(id, {});
  await opening;

  return { session, socket };
}

test("keeps all loopback-debuggable page candidates for strict product classification", () => {
  const targetB = rendererTarget({
    id: "target-b",
    webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/target-b",
  });
  const targetA = rendererTarget();
  const inputs = [
    targetB,
    null,
    "not a target",
    rendererTarget({ id: "worker", type: "worker" }),
    rendererTarget({ id: "web", url: "https://example.com" }),
    rendererTarget({ id: "missing-socket", webSocketDebuggerUrl: "" }),
    rendererTarget({
      id: "remote-socket",
      webSocketDebuggerUrl: "ws://192.0.2.10:9341/devtools/page/remote",
    }),
    targetA,
  ];

  const forward = filterRendererTargets(inputs);
  const reversed = filterRendererTargets([...inputs].reverse());

  assert.deepEqual(forward.map(({ id }) => id), ["target-a", "target-b", "web"]);
  assert.deepEqual(reversed.map(({ id }) => id), ["target-a", "target-b", "web"]);
  assert.deepEqual(inputs[0], targetB, "filtering should not mutate target objects");
});

test("fetches renderer targets only from the fixed IPv4 loopback endpoint", async () => {
  const calls = [];
  const targets = await fetchRendererTargets(9341, {
    fetchImpl: async (...args) => {
      calls.push(args);
      return okResponse([rendererTarget()]);
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "http://127.0.0.1:9341/json/list");
  assert.equal(calls[0][1].redirect, "error");
  assert.ok(calls[0][1].signal instanceof AbortSignal);
  assert.deepEqual(targets.map(({ id }) => id), ["target-a"]);
});

test("discovery accepts only page sockets on the same verified CDP port", async () => {
  const targets = await fetchRendererTargets(9341, {
    fetchImpl: async () => okResponse([
      rendererTarget(),
      rendererTarget({
        id: "other-port",
        webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/page/other-port",
      }),
      rendererTarget({
        id: "browser-socket",
        webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/browser/browser-a",
      }),
      rendererTarget({
        id: "query-socket",
        webSocketDebuggerUrl: "ws://127.0.0.1:9341/devtools/page/query?redirect=1",
      }),
    ]),
  });
  assert.deepEqual(targets.map(({ id }) => id), ["target-a"]);
});

test("discovery rejects oversized streamed bodies and target floods", async () => {
  const oversized = new Uint8Array(1024 * 1024 + 1);
  oversized.fill(0x20);
  await assert.rejects(fetchRendererTargets(9341, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(oversized);
          controller.close();
        },
      }),
    }),
  }), /discovery.*body.*large|1048576/i);

  await assert.rejects(fetchRendererTargets(9341, {
    fetchImpl: async () => okResponse(Array.from({ length: 257 }, (_, index) => rendererTarget({
      id: `target-${index}`,
      webSocketDebuggerUrl: `ws://127.0.0.1:9341/devtools/page/target-${index}`,
    }))),
  }), /target.*256|too many/i);
});

test("renderer discovery times out a fetch that never settles", async () => {
  await assert.rejects(
    fetchRendererTargets(9341, {
      timeoutMs: 10,
      fetchImpl: async () => new Promise(() => {}),
    }),
    /discovery.*timed out.*10ms/i,
  );
});

test("renderer discovery times out a JSON body that never settles", async () => {
  await assert.rejects(
    fetchRendererTargets(9341, {
      timeoutMs: 10,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => new Promise(() => {}),
      }),
    }),
    /discovery.*timed out.*10ms/i,
  );
});

test("rejects invalid renderer discovery ports before fetching", async () => {
  const invalidPorts = [1023, 65536, 9341.5, "9341", Number.NaN, null];

  for (const port of invalidPorts) {
    let called = false;
    await assert.rejects(
      fetchRendererTargets(port, {
        fetchImpl: async () => {
          called = true;
          return okResponse([]);
        },
      }),
      /port.*integer.*1024.*65535/i,
    );
    assert.equal(called, false);
  }
});

test("rejects non-ok renderer discovery responses", async () => {
  await assert.rejects(
    fetchRendererTargets(9341, {
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: async () => [],
      }),
    }),
    /503.*Service Unavailable/,
  );
});

test("rejects malformed renderer discovery JSON", async () => {
  await assert.rejects(
    fetchRendererTargets(9341, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }),
    }),
    /malformed.*Unexpected token/i,
  );

  await assert.rejects(
    fetchRendererTargets(9341, {
      fetchImpl: async () => okResponse({ targets: [] }),
    }),
    /malformed.*array/i,
  );
});

test("polling recovers from discovery errors and empty target lists", async () => {
  let attempt = 0;
  const sleeps = [];
  const targets = await waitForRendererTargets(9341, {
    timeoutMs: 50,
    pollMs: 10,
    fetchImpl: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("connection refused");
      if (attempt === 2) return okResponse([]);
      return okResponse([rendererTarget()]);
    },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });

  assert.equal(attempt, 3);
  assert.deepEqual(sleeps, [10, 10]);
  assert.deepEqual(targets.map(({ id }) => id), ["target-a"]);
});

test("polling timeout reports the last discovery error", async () => {
  let attempt = 0;

  await assert.rejects(
    waitForRendererTargets(9341, {
      timeoutMs: 20,
      pollMs: 10,
      fetchImpl: async () => {
        attempt += 1;
        throw new Error("connection refused");
      },
      sleep: async () => {},
    }),
    (error) => {
      assert.match(error.message, /timed out.*20ms.*connection refused/i);
      assert.match(error.cause?.message ?? "", /connection refused/i);
      return true;
    },
  );

  assert.equal(attempt, 3);
});

test("CdpSession refuses non-loopback debugger sockets", () => {
  assert.throws(
    () => new CdpSession("ws://192.0.2.10:9341/devtools/page/remote"),
    /127\.0\.0\.1/,
  );
  assert.throws(
    () => new CdpSession("ws://127.0.0.1:9341/devtools/browser/browser-a"),
    /devtools.*page/i,
  );
});

test("open enables the Runtime and Page domains", async () => {
  const { session } = await openFakeSession();
  session.close();
});

test("open times out a stalled WebSocket connection and closes it", async () => {
  FakeWebSocket.reset();
  const session = new CdpSession(LOOPBACK_SOCKET_URL, {
    WebSocketImpl: FakeWebSocket,
    connectTimeoutMs: 10,
  });
  const opening = session.open();
  const socket = FakeWebSocket.instances[0];

  await assert.rejects(opening, /WebSocket.*connect.*timed out.*10ms/i);
  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
});

test("correlates out-of-order command responses with numeric IDs", async () => {
  const { session, socket } = await openFakeSession();
  const first = session.send("Test.first", { value: 1 });
  const second = session.send("Test.second", { value: 2 });
  const [firstRequest, secondRequest] = socket.sent.slice(-2);

  assert.equal(typeof firstRequest.id, "number");
  assert.equal(typeof secondRequest.id, "number");
  assert.notEqual(firstRequest.id, secondRequest.id);
  socket.respond(secondRequest.id, { value: "second" });
  socket.respond(firstRequest.id, { value: "first" });

  assert.deepEqual(await first, { value: "first" });
  assert.deepEqual(await second, { value: "second" });
  session.close();
});

test("times out an individual command", async () => {
  const { session } = await openFakeSession({ commandTimeoutMs: 100 });

  await assert.rejects(
    session.send("Slow.command", {}, { timeoutMs: 10 }),
    /Slow\.command.*timed out.*10ms/i,
  );
  session.close();
});

test("propagates CDP command errors with their code and data", async () => {
  const { session, socket } = await openFakeSession();
  const command = session.send("Page.navigate", { url: "app://codex/settings" });
  const request = socket.sent.at(-1);
  socket.respondWithError(request.id, {
    code: -32000,
    message: "Navigation failed",
    data: "renderer unavailable",
  });

  await assert.rejects(command, (error) => {
    assert.match(error.message, /Page\.navigate.*Navigation failed/);
    assert.equal(error.code, -32000);
    assert.equal(error.data, "renderer unavailable");
    return true;
  });
  session.close();
});

test("evaluate awaits promises, returns values, and requests by-value results", async () => {
  const { session, socket } = await openFakeSession();
  const evaluated = session.evaluate("Promise.resolve(42)");
  const request = socket.sent.at(-1);

  assert.equal(request.method, "Runtime.evaluate");
  assert.deepEqual(request.params, {
    expression: "Promise.resolve(42)",
    awaitPromise: true,
    returnByValue: true,
  });
  socket.respond(request.id, {
    result: { type: "number", value: 42 },
  });

  assert.equal(await evaluated, 42);
  session.close();
});

test("evaluate propagates Runtime exception details", async () => {
  const { session, socket } = await openFakeSession();
  const evaluated = session.evaluate("Promise.reject(new Error(\"boom\"))");
  const request = socket.sent.at(-1);
  const exceptionDetails = {
    text: "Uncaught (in promise)",
    exception: {
      type: "object",
      subtype: "error",
      description: "Error: boom",
    },
  };
  socket.respond(request.id, {
    result: {
      type: "object",
      subtype: "error",
      description: "Error: boom",
    },
    exceptionDetails,
  });

  await assert.rejects(evaluated, (error) => {
    assert.match(error.message, /Runtime\.evaluate.*Error: boom/);
    assert.deepEqual(error.exceptionDetails, exceptionDetails);
    return true;
  });
  session.close();
});

test("socket close rejects every pending command", async () => {
  const { session, socket } = await openFakeSession();
  const first = session.send("Page.reload");
  const second = session.send("Runtime.getIsolateId");

  socket.remoteClose(1006, "renderer gone");

  await assert.rejects(first, /closed.*1006.*renderer gone/i);
  await assert.rejects(second, /closed.*1006.*renderer gone/i);
  await assert.rejects(session.send("Page.reload"), /closed/i);
});

test("socket errors reject every pending command", async () => {
  const { session, socket } = await openFakeSession();
  const command = session.send("Page.reload");

  socket.emitError(new Error("socket exploded"));

  await assert.rejects(command, /socket exploded/i);
});

test("an oversized CDP message closes the session before JSON parsing", async () => {
  const { session, socket } = await openFakeSession();
  const command = session.send("Runtime.getIsolateId");
  socket.respondRaw(" ".repeat(1024 * 1024 + 1));
  await assert.rejects(command, /message.*1048576|message.*large/i);
  assert.equal(socket.closeCalls, 1);
});

test("close is idempotent", async () => {
  const { session, socket } = await openFakeSession();

  session.close();
  session.close();

  assert.equal(socket.closeCalls, 1);
});

test("upload response budget admits supported base64 images without widening ordinary commands", async () => {
  const { CDP_UPLOAD_RESPONSE_BYTES } = await import("../src/cdp-client.mjs");
  for (const size of [768 * 1024 - 1, 768 * 1024 + 1, 1024 * 1024, 8 * 1024 * 1024]) {
    const { session, socket } = await openFakeSession({ commandTimeoutMs: 5000 });
    const promise = session.evaluate("upload status", { maxResponseBytes: CDP_UPLOAD_RESPONSE_BYTES });
    const request = socket.sent.at(-1);
    const value = { controlRequest: { action: "publish-user-theme", image: "data:image/png;base64," + Buffer.alloc(size).toString("base64") } };
    socket.respond(request.id, { result: { type: "object", value } });
    assert.deepEqual(await promise, value);
    assert.equal(session.closed, false);
    const ordinary = session.evaluate("ordinary");
    socket.respond(socket.sent.at(-1).id, { result: { type: "number", value: 42 } });
    assert.equal(await ordinary, 42);
    session.close();
  }
});

test("ordinary responses cannot borrow a pending upload command's larger budget", async () => {
  const { CDP_UPLOAD_RESPONSE_BYTES } = await import("../src/cdp-client.mjs");
  const { session, socket } = await openFakeSession({ commandTimeoutMs: 5000 });
  const upload = session.evaluate("upload", { maxResponseBytes: CDP_UPLOAD_RESPONSE_BYTES });
  const uploadId = socket.sent.at(-1).id;
  const ordinary = session.evaluate("ordinary");
  socket.respond(socket.sent.at(-1).id, { result: { type: "string", value: "x".repeat(1024 * 1024) } });
  await assert.rejects(ordinary, /command budget/);
  socket.respond(uploadId, { result: { type: "boolean", value: true } });
  assert.equal(await upload, true);
  assert.equal(session.closed, false);
  await assert.rejects(session.evaluate("unbounded", { maxResponseBytes: Infinity }), /bounded CDP/);
  await assert.rejects(session.evaluate("oversized", { maxResponseBytes: CDP_UPLOAD_RESPONSE_BYTES + 1 }), /bounded CDP/);
  session.close();
});
