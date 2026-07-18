import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";

import { startControlServer } from "../src/control-server.mjs";

const CONTROL_TOKEN = Buffer.alloc(32, 7).toString("base64url");
const APP_ORIGIN = "app://-";
const VALID_BODY = { revision: 3, persistenceEnabled: false };

function jsonText(value) {
  return JSON.stringify(value);
}

function responseJson(response) {
  return JSON.parse(response.text);
}

function request(server, options = {}) {
  const method = options.method ?? "POST";
  const path = options.path ?? "/v1/persistence";
  const origin = Object.hasOwn(options, "origin") ? options.origin : APP_ORIGIN;
  const token = Object.hasOwn(options, "token") ? options.token : CONTROL_TOKEN;
  const host = Object.hasOwn(options, "host")
    ? options.host
    : `${server.host}:${server.port}`;
  const contentType = Object.hasOwn(options, "contentType")
    ? options.contentType
    : "application/json";
  const rawBody = options.rawBody ?? jsonText(options.body ?? VALID_BODY);
  const includeContentLength = options.includeContentLength ?? !options.chunked;
  const headers = { ...(options.headers ?? {}) };

  if (host !== undefined) headers.Host = host;
  if (origin !== undefined) headers.Origin = origin;
  if (token !== undefined) headers["X-HeiGe-Control-Token"] = token;
  if (contentType !== undefined) headers["Content-Type"] = contentType;
  if (includeContentLength) {
    headers["Content-Length"] = options.contentLength ?? Buffer.byteLength(rawBody);
  }
  if (options.chunked) headers["Transfer-Encoding"] = "chunked";

  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        host: server.host,
        port: server.port,
        method,
        path,
        headers,
        agent: false,
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode,
            headers: incoming.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    if (options.writeChunks) {
      for (const chunk of options.writeChunks) outgoing.write(chunk);
      outgoing.end();
    } else {
      outgoing.end(rawBody);
    }
  });
}

function preflight(server, options = {}) {
  const origin = options.origin ?? APP_ORIGIN;
  const host = options.host ?? `${server.host}:${server.port}`;
  const headers = {
    Host: host,
    Origin: origin,
    "Access-Control-Request-Method": options.requestMethod ?? "POST",
    "Access-Control-Request-Headers":
      options.requestHeaders ?? "Content-Type, X-HeiGe-Control-Token",
  };
  return request(server, {
    method: "OPTIONS",
    path: options.path ?? "/v1/persistence",
    origin,
    host,
    rawBody: "",
    includeContentLength: false,
    contentType: undefined,
    token: undefined,
    headers,
  });
}

async function startFixture(t, overrides = {}) {
  let state = overrides.state ?? {
    persistenceEnabled: true,
    revision: 3,
    internalPath: "/Users/private/state.json",
  };
  const calls = [];
  const themeCalls = [];
  const readState = overrides.readState ?? (async () => structuredClone(state));
  const setPersistence = overrides.setPersistence ?? (async (input) => {
    calls.push(input);
    state = {
      persistenceEnabled: input.enabled,
      revision: input.expectedRevision + 1,
      internalPath: "/Users/private/state.json",
    };
    return structuredClone(state);
  });
  const setThemeSelection = overrides.setThemeSelection ?? (async (input) => {
    themeCalls.push(input);
    state = {
      ...state,
      selectedThemeId: input.themeId,
      lastNonNativeThemeId: input.themeId === "__heige_native__"
        ? state.lastNonNativeThemeId
        : input.themeId,
      revision: input.expectedRevision + 1,
    };
    return structuredClone(state);
  });
  const server = await startControlServer({
    token: CONTROL_TOKEN,
    allowedOrigins: new Set([APP_ORIGIN]),
    readState,
    setPersistence,
    setThemeSelection,
    onPersistenceResponseFinished: overrides.onPersistenceResponseFinished,
    host: "127.0.0.1",
    port: 0,
    maxBodyBytes: overrides.maxBodyBytes ?? 1024,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 1500,
    maxConnections: overrides.maxConnections ?? 8,
    maxPendingRequests: overrides.maxPendingRequests ?? 8,
  });
  t.after(() => server.close());
  return { server, calls, themeCalls, getState: () => structuredClone(state) };
}

test("accepts an exact theme selection request and returns an authoritative revision", async (t) => {
  const fx = await startFixture(t, {
    state: {
      persistenceEnabled: false,
      selectedThemeId: "miku-488137",
      lastNonNativeThemeId: "miku-488137",
      revision: 3,
    },
  });

  const response = await request(fx.server, {
    path: "/v1/theme",
    body: { revision: 3, themeId: "genshin-night" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(responseJson(response), {
    ok: true,
    persistenceEnabled: false,
    revision: 4,
    themeId: "genshin-night",
  });
  assert.equal(fx.themeCalls.length, 1);
  assert.equal(fx.themeCalls[0].expectedRevision, 3);
  assert.equal(fx.themeCalls[0].themeId, "genshin-night");
  assert.ok(fx.themeCalls[0].signal instanceof AbortSignal);
});

test("forwards an exact theme requestId into the durable selection commit", async (t) => {
  const fx = await startFixture(t, {
    state: {
      persistenceEnabled: false,
      selectedThemeId: "miku-488137",
      lastNonNativeThemeId: "miku-488137",
      revision: 3,
    },
  });
  const requestId = "c".repeat(32);

  const response = await request(fx.server, {
    path: "/v1/theme",
    body: { revision: 3, themeId: "genshin-night", requestId },
  });

  assert.equal(response.status, 200);
  assert.equal(fx.themeCalls.length, 1);
  assert.equal(fx.themeCalls[0].requestId, requestId);
  assert.equal(fx.themeCalls[0].themeId, "genshin-night");
});

test("accepts native theme exactly and preserves the last formal launcher theme", async (t) => {
  const fx = await startFixture(t, {
    state: {
      persistenceEnabled: true,
      selectedThemeId: "genshin-night",
      lastNonNativeThemeId: "genshin-night",
      revision: 6,
    },
  });

  const response = await request(fx.server, {
    path: "/v1/theme",
    body: { revision: 6, themeId: "__heige_native__" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(responseJson(response), {
    ok: true,
    persistenceEnabled: true,
    revision: 7,
    themeId: "__heige_native__",
  });
  assert.equal(fx.getState().lastNonNativeThemeId, "genshin-night");
});

test("rejects custom quick images and malformed theme protocol bodies", async (t) => {
  const fx = await startFixture(t, {
    state: {
      persistenceEnabled: false,
      selectedThemeId: "miku-488137",
      lastNonNativeThemeId: "miku-488137",
      revision: 3,
    },
  });
  const invalidBodies = [
    { revision: 3, themeId: "custom-upload" },
    { revision: 3, themeId: "../miku" },
    { revision: 3, themeId: "Miku" },
    { revision: 3, themeId: "" },
    { revision: 3, themeId: null },
    { revision: 3, themeId: "miku-488137", extra: true },
    { revision: 3, themeId: "miku-488137", requestId: "not-hex" },
    { revision: 3, themeId: "miku-488137", requestId: "c".repeat(31) },
    { themeId: "miku-488137" },
  ];

  for (const body of invalidBodies) {
    const response = await request(fx.server, { path: "/v1/theme", body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(responseJson(response).code, "INVALID_REQUEST");
  }
  assert.equal(fx.themeCalls.length, 0);
});

test("returns a safe conflict for a stale different theme selection", async (t) => {
  const fx = await startFixture(t, {
    state: {
      persistenceEnabled: false,
      selectedThemeId: "miku-488137",
      lastNonNativeThemeId: "miku-488137",
      revision: 9,
    },
  });

  const response = await request(fx.server, {
    path: "/v1/theme",
    body: { revision: 3, themeId: "genshin-night" },
  });

  assert.equal(response.status, 409);
  assert.deepEqual(responseJson(response), {
    ok: false,
    code: "REVISION_CONFLICT",
    message: "状态已发生变化，请重试",
    persistenceEnabled: false,
    revision: 9,
  });
  assert.equal(fx.themeCalls.length, 0);
});

test("returns the authoritative revision for a stale same-theme retry", async (t) => {
  const fx = await startFixture(t, {
    state: {
      persistenceEnabled: false,
      selectedThemeId: "genshin-night",
      lastNonNativeThemeId: "genshin-night",
      revision: 9,
    },
  });

  const response = await request(fx.server, {
    path: "/v1/theme",
    body: { revision: 3, themeId: "genshin-night" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(responseJson(response), {
    ok: true,
    persistenceEnabled: false,
    revision: 9,
    themeId: "genshin-night",
  });
  assert.equal(fx.themeCalls.length, 0);
});

test("rejects a theme backend result that is not the exact next authoritative state", async (t) => {
  const baseState = {
    persistenceEnabled: false,
    selectedThemeId: "miku-488137",
    lastNonNativeThemeId: "miku-488137",
    revision: 3,
  };
  const invalidResults = [
    { ...baseState, selectedThemeId: "genshin-night", lastNonNativeThemeId: "genshin-night", revision: 5 },
    { ...baseState, persistenceEnabled: true, selectedThemeId: "genshin-night", lastNonNativeThemeId: "genshin-night", revision: 4 },
    { ...baseState, selectedThemeId: "genshin-night", lastNonNativeThemeId: "miku-488137", revision: 4 },
  ];

  for (const result of invalidResults) {
    const fx = await startFixture(t, {
      state: baseState,
      setThemeSelection: async () => result,
    });
    const response = await request(fx.server, {
      path: "/v1/theme",
      body: { revision: 3, themeId: "genshin-night" },
    });
    assert.equal(response.status, 503, JSON.stringify(result));
    assert.equal(responseJson(response).code, "THEME_UPDATE_FAILED");
    await fx.server.close();
  }
});

test("successful persistence callback runs only after the complete HTTP response finishes", async (t) => {
  const finished = [];
  const fx = await startFixture(t, {
    state: { persistenceEnabled: false, revision: 3 },
    onPersistenceResponseFinished: async (state) => finished.push(state),
  });
  const response = await request(fx.server, {
    body: { revision: 3, persistenceEnabled: true },
  });
  assert.equal(response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(finished, [{ persistenceEnabled: true, revision: 4 }]);
});

function backendError({ code, persistenceEnabled, revision }) {
  const error = new Error(
    `sensitive ${CONTROL_TOKEN} /Users/private/controller.mjs stack-marker`,
  );
  error.code = code;
  error.persistenceEnabled = persistenceEnabled;
  error.revision = revision;
  error.headers = { authorization: "header-secret" };
  error.env = { PRIVATE_VALUE: "environment-secret" };
  error.stack = `${error.stack}\nstack-marker`;
  return error;
}

function rawPartialRequest(server, { declaredLength, partialBody = "" }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: server.host, port: server.port });
    const chunks = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => resolve(chunks.join("")));
    socket.on("connect", () => {
      const lines = [
        "POST /v1/persistence HTTP/1.1",
        `Host: ${server.host}:${server.port}`,
        `Origin: ${APP_ORIGIN}`,
        "Content-Type: application/json",
        `X-HeiGe-Control-Token: ${CONTROL_TOKEN}`,
        "Connection: close",
      ];
      if (declaredLength !== undefined) {
        lines.splice(4, 0, `Content-Length: ${declaredLength}`);
      }
      socket.write([...lines, "", partialBody].join("\r\n"));
    });
  });
}

function rawSlowHeaderRequest(server) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: server.host, port: server.port });
    const chunks = [];
    const safetyTimeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("HEADER_TIMEOUT_NOT_ENFORCED"));
    }, 250);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", (error) => {
      clearTimeout(safetyTimeout);
      reject(error);
    });
    socket.on("end", () => {
      clearTimeout(safetyTimeout);
      resolve(chunks.join(""));
    });
    socket.on("connect", () => {
      socket.write("POST /v1/persistence HTTP/1.1\r\nHost:");
    });
  });
}

function rawKeepAliveRequest(server) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: server.host, port: server.port });
    const chunks = [];
    const safetyTimeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("IDLE_CONNECTION_TIMEOUT_NOT_ENFORCED"));
    }, 250);
    let unexpectedError;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", (error) => {
      if (error.code !== "ECONNRESET") unexpectedError = error;
    });
    socket.on("close", () => {
      clearTimeout(safetyTimeout);
      if (unexpectedError) reject(unexpectedError);
      else resolve(chunks.join(""));
    });
    socket.on("connect", () => {
      const body = jsonText(VALID_BODY);
      socket.write(
        [
          "POST /v1/persistence HTTP/1.1",
          `Host: ${server.host}:${server.port}`,
          `Origin: ${APP_ORIGIN}`,
          "Content-Type: application/json",
          `Content-Length: ${Buffer.byteLength(body)}`,
          `X-HeiGe-Control-Token: ${CONTROL_TOKEN}`,
          "Connection: keep-alive",
          "",
          body,
        ].join("\r\n"),
      );
    });
  });
}

test("refuses any bind host other than IPv4 loopback", async () => {
  await assert.rejects(
    startControlServer({
      token: CONTROL_TOKEN,
      allowedOrigins: new Set([APP_ORIGIN]),
      readState: async () => ({ persistenceEnabled: true, revision: 3 }),
      setPersistence: async () => ({ persistenceEnabled: false, revision: 4 }),
      host: "0.0.0.0",
      port: 0,
    }),
    /只能绑定 127\.0\.0\.1/,
  );
});

test("requires a canonical 32-byte base64url control token", async () => {
  const invalidTokens = [
    "short",
    Buffer.alloc(31, 1).toString("base64url"),
    `${CONTROL_TOKEN}=`,
    `${CONTROL_TOKEN.slice(0, -1)}+`,
  ];

  for (const token of invalidTokens) {
    let started;
    try {
      started = await startControlServer({
        token,
        allowedOrigins: new Set([APP_ORIGIN]),
        readState: async () => ({ persistenceEnabled: true, revision: 3 }),
        setPersistence: async () => ({ persistenceEnabled: false, revision: 4 }),
        host: "127.0.0.1",
        port: 0,
      });
    } catch (error) {
      assert.match(error.message, /32 字节.*base64url/);
      continue;
    }
    await started.close();
    assert.fail("accepted a noncanonical control token");
  }
});

test("binds only IPv4 loopback and accepts the exact persistence request", async (t) => {
  const { server, calls } = await startFixture(t);
  assert.equal(server.host, "127.0.0.1");
  assert.ok(Number.isInteger(server.port) && server.port > 0);

  const response = await request(server, { body: VALID_BODY });

  assert.equal(response.status, 200);
  assert.equal(response.headers["access-control-allow-origin"], APP_ORIGIN);
  assert.deepEqual(responseJson(response), {
    ok: true,
    persistenceEnabled: false,
    revision: 4,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    { expectedRevision: calls[0].expectedRevision, enabled: calls[0].enabled },
    { expectedRevision: 3, enabled: false },
  );
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test("answers only the exact CORS persistence preflight", async (t) => {
  const { server } = await startFixture(t);

  const accepted = await preflight(server);
  assert.equal(accepted.status, 204);
  assert.equal(accepted.text, "");
  assert.equal(accepted.headers["access-control-allow-origin"], APP_ORIGIN);
  assert.equal(accepted.headers["access-control-allow-methods"], "POST");
  assert.equal(
    accepted.headers["access-control-allow-headers"],
    "Content-Type, X-HeiGe-Control-Token",
  );

  assert.equal((await preflight(server, { requestMethod: "PUT" })).status, 400);
  assert.equal(
    (await preflight(server, {
      requestHeaders: "Content-Type, X-HeiGe-Control-Token, X-Extra",
    })).status,
    400,
  );
  const hostile = await preflight(server, { origin: "https://evil.example" });
  assert.equal(hostile.status, 403);
  assert.equal(hostile.headers["access-control-allow-origin"], undefined);
});

test("rejects hostile and opaque origins without reflecting them", async (t) => {
  const { server } = await startFixture(t);

  for (const origin of ["https://evil.example", "null"]) {
    const response = await request(server, { origin });
    assert.equal(response.status, 403);
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.deepEqual(Object.keys(responseJson(response)).sort(), ["code", "message", "ok"]);
  }
});

test("rejects the wrong control token without echoing it", async (t) => {
  const { server } = await startFixture(t);
  const wrongToken = "wrong-token-secret";

  const response = await request(server, { token: wrongToken });

  assert.equal(response.status, 401);
  assert.equal(response.headers["access-control-allow-origin"], APP_ORIGIN);
  assert.equal(response.text.includes(wrongToken), false);
  assert.deepEqual(Object.keys(responseJson(response)).sort(), ["code", "message", "ok"]);
});

test("requires the exact loopback Host header", async (t) => {
  const { server } = await startFixture(t);

  const response = await request(server, { host: "evil.example" });

  assert.equal(response.status, 400);
  assert.equal(response.text.includes("evil.example"), false);
});

test("rejects every method and path outside the two-route surface", async (t) => {
  const { server } = await startFixture(t);

  assert.equal((await request(server, { method: "GET" })).status, 405);
  assert.equal((await request(server, { method: "PUT" })).status, 405);
  assert.equal((await request(server, { path: "/v1/persistence?secret=path-secret" })).status, 404);
  assert.equal((await preflight(server, { path: "/v1/other" })).status, 404);
});

test("requires exact JSON content type and a declared nonempty length", async (t) => {
  const { server } = await startFixture(t);

  assert.equal(
    (await request(server, { contentType: "application/json; charset=utf-8" })).status,
    415,
  );
  const noLength = await rawPartialRequest(server, {});
  assert.match(noLength, /^HTTP\/1\.1 411 /);
  assert.equal(
    (await request(server, {
      rawBody: "",
      includeContentLength: true,
      contentLength: 0,
    })).status,
    400,
  );
  assert.equal(
    (await request(server, {
      chunked: true,
      writeChunks: [jsonText(VALID_BODY)],
    })).status,
    400,
  );
});

test("rejects a declared request body above the byte cap", async (t) => {
  const { server } = await startFixture(t);

  const response = await request(server, { rawBody: "x".repeat(1025) });

  assert.equal(response.status, 413);
  assert.equal(response.text.includes("x".repeat(32)), false);
});

test("accepts only a plain JSON object with exactly the two protocol keys", async (t) => {
  const { server } = await startFixture(t);

  assert.equal(
    (await request(server, {
      body: { revision: 3, persistenceEnabled: false, command: "open" },
    })).status,
    400,
  );
  assert.equal((await request(server, { rawBody: "[3,false]" })).status, 400);
  assert.equal((await request(server, { rawBody: "null" })).status, 400);
  assert.equal((await request(server, { rawBody: "{not-json" })).status, 400);
});

test("rejects noninteger and negative revisions and nonboolean values", async (t) => {
  const { server } = await startFixture(t);

  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3"]) {
    assert.equal(
      (await request(server, { body: { revision, persistenceEnabled: false } })).status,
      400,
    );
  }
  for (const persistenceEnabled of [0, "false", null]) {
    assert.equal(
      (await request(server, { body: { revision: 3, persistenceEnabled } })).status,
      400,
    );
  }
});

test("snapshots state accessors exactly once before validating them", async (t) => {
  let persistenceReads = 0;
  let revisionReads = 0;
  let writes = 0;
  const deceptiveState = {};
  Object.defineProperties(deceptiveState, {
    persistenceEnabled: {
      enumerable: true,
      get() {
        persistenceReads += 1;
        return persistenceReads === 1;
      },
    },
    revision: {
      enumerable: true,
      get() {
        revisionReads += 1;
        return revisionReads === 1 ? 3 : 4;
      },
    },
  });
  const { server } = await startFixture(t, {
    readState: async () => deceptiveState,
    setPersistence: async ({ expectedRevision, enabled }) => {
      writes += 1;
      return { persistenceEnabled: enabled, revision: expectedRevision + 1 };
    },
  });

  const response = await request(server);

  assert.equal(response.status, 200);
  assert.equal(persistenceReads, 1);
  assert.equal(revisionReads, 1);
  assert.equal(writes, 1);
  assert.deepEqual(responseJson(response), {
    ok: true,
    persistenceEnabled: false,
    revision: 4,
  });
});

test("fails closed when a backend state Proxy throws from a getter", async (t) => {
  const secret = "proxy-secret-path-/Users/private/state.json";
  const hostileState = new Proxy({}, {
    get() {
      throw new Error(secret);
    },
  });
  const { server } = await startFixture(t, {
    readState: async () => hostileState,
  });

  const response = await request(server);

  assert.equal(response.status, 503);
  assert.deepEqual(responseJson(response), {
    ok: false,
    code: "CONTROL_UNAVAILABLE",
    message: "控制服务暂时不可用，请重试",
  });
  assert.equal(response.text.includes(secret), false);
});

test("returns the authoritative state for a stale same-value retry", async (t) => {
  let calls = 0;
  const { server } = await startFixture(t, {
    state: { persistenceEnabled: false, revision: 9 },
    setPersistence: async () => {
      calls += 1;
      throw new Error("must not be called");
    },
  });

  const response = await request(server, {
    body: { revision: 3, persistenceEnabled: false },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(responseJson(response), {
    ok: true,
    persistenceEnabled: false,
    revision: 9,
  });
  assert.equal(calls, 0);
});

test("serializes same-value retries behind an in-flight opposite transition", async (t) => {
  let state = { persistenceEnabled: true, revision: 3 };
  let readCalls = 0;
  let markSecondRead;
  const secondRead = new Promise((resolve) => {
    markSecondRead = resolve;
  });
  let releaseFirstCommit;
  let markFirstCommitStarted;
  const firstCommitStarted = new Promise((resolve) => {
    markFirstCommitStarted = resolve;
  });
  const firstCommitGate = new Promise((resolve) => {
    releaseFirstCommit = resolve;
  });
  t.after(() => releaseFirstCommit());
  const { server } = await startFixture(t, {
    readState: async () => {
      readCalls += 1;
      if (readCalls === 2) markSecondRead();
      return { ...state };
    },
    setPersistence: async ({ expectedRevision, enabled }) => {
      markFirstCommitStarted();
      await firstCommitGate;
      state = { persistenceEnabled: enabled, revision: expectedRevision + 1 };
      return { ...state };
    },
  });

  const disable = request(server, {
    body: { revision: 3, persistenceEnabled: false },
  });
  await firstCommitStarted;

  let retrySettled = false;
  const enableRetry = request(server, {
    body: { revision: 3, persistenceEnabled: true },
  }).finally(() => {
    retrySettled = true;
  });
  const readBeforeCommitSettled = await Promise.race([
    secondRead.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  assert.equal(
    readBeforeCommitSettled,
    false,
    "a queued retry must not read state before the first transaction settles",
  );
  assert.equal(retrySettled, false, "the retry must wait for the first linearization point");

  releaseFirstCommit();
  const [disableResponse, retryResponse] = await Promise.all([disable, enableRetry]);
  assert.equal(disableResponse.status, 200);
  assert.equal(retryResponse.status, 409);
  assert.deepEqual(responseJson(retryResponse), {
    ok: false,
    code: "REVISION_CONFLICT",
    message: "状态已发生变化，请重试",
    persistenceEnabled: false,
    revision: 4,
  });
  assert.deepEqual(state, { persistenceEnabled: false, revision: 4 });
});

test("rejects a backend success that skips the next revision", async (t) => {
  const { server } = await startFixture(t, {
    setPersistence: async () => ({ persistenceEnabled: false, revision: 5 }),
  });

  const response = await request(server);

  assert.equal(response.status, 503);
  assert.deepEqual(responseJson(response), {
    ok: false,
    code: "PERSISTENCE_UPDATE_FAILED",
    message: "常驻设置失败，请重试",
  });
});

test("returns a safe conflict for a stale different-value request", async (t) => {
  let calls = 0;
  const { server } = await startFixture(t, {
    state: { persistenceEnabled: true, revision: 9 },
    setPersistence: async () => {
      calls += 1;
      throw new Error("must not be called");
    },
  });

  const response = await request(server, {
    body: { revision: 3, persistenceEnabled: false },
  });

  assert.equal(response.status, 409);
  assert.deepEqual(responseJson(response), {
    ok: false,
    code: "REVISION_CONFLICT",
    message: "状态已发生变化，请重试",
    persistenceEnabled: true,
    revision: 9,
  });
  assert.equal(calls, 0);
});

test("a compensated backend failure returns safe authoritative state", async (t) => {
  const { server } = await startFixture(t, {
    state: { persistenceEnabled: false, revision: 3 },
    setPersistence: async () => {
      throw backendError({
        code: "BACKGROUND_START_FAILED",
        persistenceEnabled: false,
        revision: 5,
      });
    },
  });

  const response = await request(server, {
    body: { revision: 3, persistenceEnabled: true },
  });

  assert.equal(response.status, 503);
  assert.deepEqual(responseJson(response), {
    ok: false,
    code: "BACKGROUND_START_FAILED",
    message: "后台控制器启动失败，常驻仍为关闭",
    persistenceEnabled: false,
    revision: 5,
  });
});

test("does not claim persistence stayed off when compensation state is missing", async (t) => {
  const missingStateError = new Error("compensation outcome unavailable");
  missingStateError.code = "BACKGROUND_START_FAILED";
  const { server } = await startFixture(t, {
    state: { persistenceEnabled: false, revision: 3 },
    setPersistence: async () => {
      throw missingStateError;
    },
  });

  const response = await request(server, {
    body: { revision: 3, persistenceEnabled: true },
  });

  assert.equal(response.status, 503);
  assert.deepEqual(responseJson(response), {
    ok: false,
    code: "PERSISTENCE_UPDATE_FAILED",
    message: "常驻设置失败，请重试",
  });
});

test("returns contradictory compensation state without a false closed claim", async (t) => {
  const contradictoryError = backendError({
    code: "BACKGROUND_START_FAILED",
    persistenceEnabled: true,
    revision: 4,
  });
  const { server } = await startFixture(t, {
    state: { persistenceEnabled: false, revision: 3 },
    setPersistence: async () => {
      throw contradictoryError;
    },
  });

  const response = await request(server, {
    body: { revision: 3, persistenceEnabled: true },
  });

  assert.equal(response.status, 503);
  assert.deepEqual(responseJson(response), {
    ok: false,
    code: "PERSISTENCE_UPDATE_FAILED",
    message: "常驻设置失败，请重试",
    persistenceEnabled: true,
    revision: 4,
  });
});

test("rejects an impossible compensation revision without claiming safe off", async (t) => {
  const impossibleRevisionError = backendError({
    code: "BACKGROUND_START_FAILED",
    persistenceEnabled: false,
    revision: 4,
  });
  const { server } = await startFixture(t, {
    state: { persistenceEnabled: false, revision: 3 },
    setPersistence: async () => {
      throw impossibleRevisionError;
    },
  });

  const response = await request(server, {
    body: { revision: 3, persistenceEnabled: true },
  });

  assert.equal(response.status, 503);
  assert.deepEqual(responseJson(response), {
    ok: false,
    code: "PERSISTENCE_UPDATE_FAILED",
    message: "常驻设置失败，请重试",
    persistenceEnabled: false,
    revision: 4,
  });
});

test("omits a regressive backend error state that cannot be authoritative", async (t) => {
  const regressiveError = backendError({
    code: "BACKGROUND_START_FAILED",
    persistenceEnabled: false,
    revision: 2,
  });
  const { server } = await startFixture(t, {
    state: { persistenceEnabled: false, revision: 3 },
    setPersistence: async () => {
      throw regressiveError;
    },
  });

  const response = await request(server, {
    body: { revision: 3, persistenceEnabled: true },
  });

  assert.equal(response.status, 503);
  assert.deepEqual(responseJson(response), {
    ok: false,
    code: "PERSISTENCE_UPDATE_FAILED",
    message: "常驻设置失败，请重试",
  });
});

test("redacts token path headers environment and stack from backend errors", async (t) => {
  const { server } = await startFixture(t, {
    setPersistence: async () => {
      throw backendError({
        code: `LEAK_${CONTROL_TOKEN}`,
        persistenceEnabled: undefined,
        revision: undefined,
      });
    },
  });

  const response = await request(server);
  const body = responseJson(response);

  assert.equal(response.status, 503);
  assert.deepEqual(body, {
    ok: false,
    code: "PERSISTENCE_UPDATE_FAILED",
    message: "常驻设置失败，请重试",
  });
  for (const secret of [
    CONTROL_TOKEN,
    "/Users/private/controller.mjs",
    "header-secret",
    "environment-secret",
    "stack-marker",
  ]) {
    assert.equal(response.text.includes(secret), false);
  }
});

test("times out an incomplete request body", async (t) => {
  const { server } = await startFixture(t, { requestTimeoutMs: 50 });

  const rawResponse = await rawPartialRequest(server, {
    declaredLength: 64,
    partialBody: '{"revision":3',
  });

  assert.match(rawResponse, /^HTTP\/1\.1 408 /);
  assert.equal(rawResponse.includes(CONTROL_TOKEN), false);
  assert.match(rawResponse, /"code":"REQUEST_TIMEOUT"/);
});

test("times out a connection that never completes request headers", async (t) => {
  const { server } = await startFixture(t, { requestTimeoutMs: 50 });

  const rawResponse = await rawSlowHeaderRequest(server);

  assert.match(rawResponse, /^HTTP\/1\.1 408 /);
  assert.match(rawResponse, /"code":"REQUEST_TIMEOUT"/);
  assert.equal(rawResponse.includes(CONTROL_TOKEN), false);
});

test("closes an idle keep-alive socket without an unsolicited response", async (t) => {
  const { server } = await startFixture(t, { requestTimeoutMs: 50 });

  const rawResponse = await rawKeepAliveRequest(server);

  assert.equal(rawResponse.match(/HTTP\/1\.1/g)?.length, 1);
  assert.match(rawResponse, /^HTTP\/1\.1 200 /);
  assert.equal(rawResponse.includes("REQUEST_TIMEOUT"), false);
});

test("a request deadline cannot acknowledge failure after commit begins", async (t) => {
  let releaseCommit;
  let markCommitStarted;
  let receivedSignal;
  const commitStarted = new Promise((resolve) => {
    markCommitStarted = resolve;
  });
  const commitGate = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  const { server } = await startFixture(t, {
    requestTimeoutMs: 50,
    setPersistence: async (input) => {
      receivedSignal = input.signal;
      markCommitStarted();
      await commitGate;
      return { persistenceEnabled: false, revision: 4 };
    },
  });

  let responseSettled = false;
  const responsePromise = request(server).finally(() => {
    responseSettled = true;
  });
  await commitStarted;
  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(responseSettled, false, "the server must drain an entered commit");
  assert.ok(receivedSignal instanceof AbortSignal);
  assert.equal(receivedSignal.aborted, false, "HTTP deadlines must not abort commit work");

  releaseCommit();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.deepEqual(responseJson(response), {
    ok: true,
    persistenceEnabled: false,
    revision: 4,
  });
});

test("a queued request times out without reading state after the active commit", async (t) => {
  let releaseCommit;
  let markCommitStarted;
  let readCalls = 0;
  const commitStarted = new Promise((resolve) => {
    markCommitStarted = resolve;
  });
  const commitGate = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  t.after(() => releaseCommit());
  const { server } = await startFixture(t, {
    requestTimeoutMs: 50,
    readState: async () => {
      readCalls += 1;
      return { persistenceEnabled: true, revision: 3 };
    },
    setPersistence: async ({ expectedRevision, enabled }) => {
      markCommitStarted();
      await commitGate;
      return { persistenceEnabled: enabled, revision: expectedRevision + 1 };
    },
  });

  const activeResponse = request(server);
  await commitStarted;
  const queuedResponse = await request(server);

  assert.equal(queuedResponse.status, 408);
  assert.deepEqual(responseJson(queuedResponse), {
    ok: false,
    code: "REQUEST_TIMEOUT",
    message: "请求超时，请重试",
  });
  assert.equal(readCalls, 1);

  releaseCommit();
  assert.equal((await activeResponse).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readCalls, 1, "a timed-out queue node must never run later");
});

test("does not start a persistence write after the request deadline", async (t) => {
  let releaseReadState;
  let writes = 0;
  const { server } = await startFixture(t, {
    requestTimeoutMs: 50,
    readState: async () => new Promise((resolve) => {
      releaseReadState = resolve;
    }),
    setPersistence: async () => {
      writes += 1;
      return { persistenceEnabled: false, revision: 4 };
    },
  });

  const response = await request(server);
  assert.equal(response.status, 408);
  assert.equal(typeof releaseReadState, "function");

  releaseReadState({ persistenceEnabled: true, revision: 3 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
});

test("client disconnect cancels a precommit request before any write", async (t) => {
  let releaseReadState;
  let markReadStarted;
  let writes = 0;
  const readStarted = new Promise((resolve) => {
    markReadStarted = resolve;
  });
  const readGate = new Promise((resolve) => {
    releaseReadState = resolve;
  });
  t.after(() => releaseReadState());
  const { server } = await startFixture(t, {
    requestTimeoutMs: 500,
    readState: async () => {
      markReadStarted();
      await readGate;
      return { persistenceEnabled: true, revision: 3 };
    },
    setPersistence: async () => {
      writes += 1;
      return { persistenceEnabled: false, revision: 4 };
    },
  });
  const body = jsonText(VALID_BODY);
  const socket = net.createConnection({ host: server.host, port: server.port });
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  await once(socket, "connect");
  socket.write([
    "POST /v1/persistence HTTP/1.1",
    `Host: ${server.host}:${server.port}`,
    `Origin: ${APP_ORIGIN}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    `X-HeiGe-Control-Token: ${CONTROL_TOKEN}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n"));

  await readStarted;
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseReadState();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(writes, 0);
});

test("client disconnect drains a commit that already entered setPersistence", async (t) => {
  let state = { persistenceEnabled: true, revision: 3 };
  let releaseCommit;
  let markCommitStarted;
  let markCommitFinished;
  let commitSignal;
  const commitStarted = new Promise((resolve) => {
    markCommitStarted = resolve;
  });
  const commitFinished = new Promise((resolve) => {
    markCommitFinished = resolve;
  });
  const commitGate = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  t.after(() => releaseCommit());
  const { server } = await startFixture(t, {
    requestTimeoutMs: 500,
    readState: async () => ({ ...state }),
    setPersistence: async ({ expectedRevision, enabled, signal }) => {
      commitSignal = signal;
      markCommitStarted();
      await commitGate;
      state = { persistenceEnabled: enabled, revision: expectedRevision + 1 };
      markCommitFinished();
      return { ...state };
    },
  });
  const body = jsonText(VALID_BODY);
  const socket = net.createConnection({ host: server.host, port: server.port });
  socket.on("error", () => {});
  t.after(() => socket.destroy());
  await once(socket, "connect");
  socket.write([
    "POST /v1/persistence HTTP/1.1",
    `Host: ${server.host}:${server.port}`,
    `Origin: ${APP_ORIGIN}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    `X-HeiGe-Control-Token: ${CONTROL_TOKEN}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n"));

  await commitStarted;
  socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(commitSignal.aborted, false);
  releaseCommit();
  await commitFinished;

  assert.deepEqual(state, { persistenceEnabled: false, revision: 4 });
});

test("caps simultaneous connections", async (t) => {
  const { server } = await startFixture(t, { maxConnections: 1 });
  const held = net.createConnection({ host: server.host, port: server.port });
  t.after(() => held.destroy());
  await once(held, "connect");

  let timeoutId;
  try {
    await assert.rejects(Promise.race([
      request(server),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("MAX_CONNECTIONS_NOT_ENFORCED")),
          500,
        );
      }),
    ]), (error) => error.message !== "MAX_CONNECTIONS_NOT_ENFORCED");
  } finally {
    clearTimeout(timeoutId);
  }
});

test("rejects work above the global active and queued request cap", async (t) => {
  let releaseCommit;
  let markCommitStarted;
  const commitStarted = new Promise((resolve) => {
    markCommitStarted = resolve;
  });
  const commitGate = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  t.after(() => releaseCommit());
  const { server } = await startFixture(t, {
    maxPendingRequests: 1,
    setPersistence: async ({ expectedRevision, enabled }) => {
      markCommitStarted();
      await commitGate;
      return { persistenceEnabled: enabled, revision: expectedRevision + 1 };
    },
  });

  const firstResponse = request(server);
  await commitStarted;
  let limitTimer;
  let overloadedResponse;
  try {
    overloadedResponse = await Promise.race([
      request(server),
      new Promise((_, reject) => {
        limitTimer = setTimeout(
          () => reject(new Error("GLOBAL_REQUEST_CAP_NOT_ENFORCED")),
          100,
        );
      }),
    ]);
  } finally {
    clearTimeout(limitTimer);
    releaseCommit();
  }

  assert.equal(overloadedResponse.status, 503);
  assert.deepEqual(responseJson(overloadedResponse), {
    ok: false,
    code: "CONTROL_BUSY",
    message: "控制服务繁忙，请稍后重试",
  });
  assert.equal((await firstResponse).status, 200);
});

test("serializes authenticated requests pipelined on one raw TCP socket", async (t) => {
  let state = { persistenceEnabled: true, revision: 3 };
  let activeWrites = 0;
  let maxActiveWrites = 0;
  let writes = 0;
  const { server } = await startFixture(t, {
    maxPendingRequests: 4,
    readState: async () => ({ ...state }),
    setPersistence: async ({ expectedRevision, enabled }) => {
      writes += 1;
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = { persistenceEnabled: enabled, revision: expectedRevision + 1 };
      activeWrites -= 1;
      return { ...state };
    },
  });
  const body = jsonText(VALID_BODY);
  const rawRequest = (connection) => [
    "POST /v1/persistence HTTP/1.1",
    `Host: ${server.host}:${server.port}`,
    `Origin: ${APP_ORIGIN}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    `X-HeiGe-Control-Token: ${CONTROL_TOKEN}`,
    `Connection: ${connection}`,
    "",
    body,
  ].join("\r\n");
  const rawResponse = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: server.host, port: server.port });
    const chunks = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(chunks.join("")));
    socket.on("connect", () => {
      socket.write([
        rawRequest("keep-alive"),
        rawRequest("keep-alive"),
        rawRequest("keep-alive"),
        rawRequest("close"),
      ].join(""));
    });
  });

  assert.equal(rawResponse.match(/HTTP\/1\.1 200/g)?.length, 4);
  assert.equal(maxActiveWrites, 1);
  assert.equal(writes, 1, "later same-value requests must observe the first commit");
  assert.deepEqual(state, { persistenceEnabled: false, revision: 4 });
});

test("shutdown is idempotent and stops accepting connections", async (t) => {
  const { server } = await startFixture(t);

  await Promise.all([server.close(), server.close()]);
  await server.close();

  await assert.rejects(request(server));
});

test("shutdown waits for an active persistence commit before closing sockets", async (t) => {
  let releaseCommit;
  let markCommitStarted;
  const commitStarted = new Promise((resolve) => {
    markCommitStarted = resolve;
  });
  const commitGate = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  t.after(() => releaseCommit());
  const { server } = await startFixture(t, {
    setPersistence: async ({ expectedRevision, enabled }) => {
      markCommitStarted();
      await commitGate;
      return { persistenceEnabled: enabled, revision: expectedRevision + 1 };
    },
  });

  const responsePromise = request(server);
  await commitStarted;
  let closeSettled = false;
  const closePromise = server.close().then(() => {
    closeSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(closeSettled, false, "close must drain the commit before resolving");
  await assert.rejects(request(server), "close must reject newly arriving work immediately");
  releaseCommit();

  const [response] = await Promise.all([responsePromise, closePromise]);
  assert.equal(response.status, 200);
  assert.deepEqual(responseJson(response), {
    ok: true,
    persistenceEnabled: false,
    revision: 4,
  });
  await assert.rejects(request(server));
});

test("shutdown cancels queued persistence work without cancelling the active commit", async (t) => {
  let releaseCommit;
  let markCommitStarted;
  let readCalls = 0;
  const commitStarted = new Promise((resolve) => {
    markCommitStarted = resolve;
  });
  const commitGate = new Promise((resolve) => {
    releaseCommit = resolve;
  });
  t.after(() => releaseCommit());
  const { server } = await startFixture(t, {
    maxPendingRequests: 2,
    readState: async () => {
      readCalls += 1;
      return { persistenceEnabled: true, revision: 3 };
    },
    setPersistence: async ({ expectedRevision, enabled }) => {
      markCommitStarted();
      await commitGate;
      return { persistenceEnabled: enabled, revision: expectedRevision + 1 };
    },
  });

  const activeResponse = request(server);
  await commitStarted;
  const queuedResponse = request(server);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(readCalls, 1, "the second request must be queued behind the active commit");

  let closeSettled = false;
  const closePromise = server.close().then(() => {
    closeSettled = true;
  });
  let queueTimer;
  let cancelledResponse;
  try {
    cancelledResponse = await Promise.race([
      queuedResponse,
      new Promise((_, reject) => {
        queueTimer = setTimeout(
          () => reject(new Error("QUEUED_REQUEST_NOT_CANCELLED_BY_CLOSE")),
          100,
        );
      }),
    ]);
  } finally {
    clearTimeout(queueTimer);
  }

  assert.equal(cancelledResponse.status, 503);
  assert.deepEqual(responseJson(cancelledResponse), {
    ok: false,
    code: "CONTROL_UNAVAILABLE",
    message: "控制服务暂时不可用，请重试",
  });
  assert.equal(closeSettled, false);
  assert.equal(readCalls, 1, "cancelled queued work must never read state");

  releaseCommit();
  const [active] = await Promise.all([activeResponse, closePromise]);
  assert.equal(active.status, 200);
});

test("shutdown cancels an active precommit read without waiting for its promise", async (t) => {
  let markReadStarted;
  let writes = 0;
  const readStarted = new Promise((resolve) => {
    markReadStarted = resolve;
  });
  const { server } = await startFixture(t, {
    readState: async () => {
      markReadStarted();
      return new Promise(() => {});
    },
    setPersistence: async () => {
      writes += 1;
      return { persistenceEnabled: false, revision: 4 };
    },
  });

  const responsePromise = request(server);
  await readStarted;
  let drainTimer;
  let result;
  try {
    result = await Promise.race([
      Promise.all([responsePromise, server.close()]),
      new Promise((_, reject) => {
        drainTimer = setTimeout(
          () => reject(new Error("PRECOMMIT_READ_NOT_CANCELLED_BY_CLOSE")),
          200,
        );
      }),
    ]);
  } finally {
    clearTimeout(drainTimer);
  }

  assert.equal(result[0].status, 503);
  assert.deepEqual(responseJson(result[0]), {
    ok: false,
    code: "CONTROL_UNAVAILABLE",
    message: "控制服务暂时不可用，请重试",
  });
  assert.equal(writes, 0);
});
