import { RESOURCE_LIMITS } from "./resource-limits.mjs";

const MIN_PORT = 1024;
const MAX_PORT = 65535;
const DEFAULT_WAIT_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 100;
const DEFAULT_COMMAND_TIMEOUT_MS = 5000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;
const MAX_DISCOVERY_BODY_BYTES = 1024 * 1024;
const MAX_DISCOVERY_TARGETS = 256;
const MAX_CDP_MESSAGE_BYTES = 1024 * 1024;
// One bounded base64 upload plus the ordinary status/JSON envelope. Opt-in per
// command: discovery, events and all other responses retain their 1 MiB budget.
export const CDP_UPLOAD_RESPONSE_BYTES = 4 * Math.ceil(RESOURCE_LIMITS.assetBytes / 3)
  + MAX_CDP_MESSAGE_BYTES;

function validatePort(port) {
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new TypeError(
      `port must be an integer from ${MIN_PORT} through ${MAX_PORT}`,
    );
  }
  return port;
}

function validateDuration(value, name, { allowZero }) {
  const minimum = allowZero ? 0 : Number.EPSILON;
  if (!Number.isFinite(value) || value < minimum) {
    const qualifier = allowZero ? "non-negative" : "positive";
    throw new TypeError(`${name} must be a finite ${qualifier} number`);
  }
  return value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseLoopbackWebSocketUrl(value, expectedPort = null) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new TypeError("webSocketDebuggerUrl must be a non-empty URL string");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new TypeError(`webSocketDebuggerUrl is invalid: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  if (
    parsed.protocol !== "ws:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search ||
    !parsed.port ||
    !/^\/devtools\/page\/[A-Za-z0-9_-]{1,256}$/.test(parsed.pathname)
  ) {
    throw new TypeError(
      "webSocketDebuggerUrl must use ws://127.0.0.1 with an explicit port and /devtools/page target",
    );
  }

  const port = validatePort(Number(parsed.port));
  if (expectedPort !== null && port !== expectedPort) {
    throw new TypeError("webSocketDebuggerUrl must use the verified CDP discovery port");
  }
  return parsed;
}

function isRendererTarget(target, expectedPort) {
  if (
    target === null ||
    typeof target !== "object" ||
    Array.isArray(target) ||
    target.type !== "page" ||
    typeof target.url !== "string"
  ) {
    return false;
  }

  try {
    parseLoopbackWebSocketUrl(target.webSocketDebuggerUrl, expectedPort);
    return true;
  } catch {
    return false;
  }
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareTargets(left, right) {
  const leftKeys = [
    String(left.id ?? ""),
    left.url,
    left.webSocketDebuggerUrl,
  ];
  const rightKeys = [
    String(right.id ?? ""),
    right.url,
    right.webSocketDebuggerUrl,
  ];

  for (let index = 0; index < leftKeys.length; index += 1) {
    const comparison = compareText(leftKeys[index], rightKeys[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function sleepWithTimer(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function awaitBeforeDeadline(
  promise,
  { deadline, timeoutMs, label, onTimeout },
) {
  const remainingMs = Math.max(0, deadline - Date.now());
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function buildHttpError(response) {
  const status = Number.isInteger(response?.status)
    ? String(response.status)
    : "unknown status";
  const statusText =
    typeof response?.statusText === "string" && response.statusText.length > 0
      ? ` ${response.statusText}`
      : "";
  return new Error(`renderer target discovery failed with HTTP ${status}${statusText}`);
}

function buildCdpError(method, payload) {
  const code = payload && Object.hasOwn(payload, "code") ? payload.code : undefined;
  const message =
    typeof payload?.message === "string" ? payload.message : "unknown CDP error";
  const codeText = code === undefined ? "" : ` (${code})`;
  const error = new Error(`CDP ${method} failed${codeText}: ${message}`);
  error.name = "CdpProtocolError";
  if (code !== undefined) error.code = code;
  if (payload && Object.hasOwn(payload, "data")) error.data = payload.data;
  return error;
}

function buildEvaluationError(exceptionDetails) {
  const description = exceptionDetails?.exception?.description;
  const text = exceptionDetails?.text;
  const detail =
    typeof description === "string" && description.length > 0
      ? description
      : typeof text === "string" && text.length > 0
        ? text
        : "unknown JavaScript exception";
  const error = new Error(`Runtime.evaluate failed: ${detail}`);
  error.name = "CdpEvaluationError";
  error.exceptionDetails = exceptionDetails;
  return error;
}

export function filterRendererTargets(targets, { expectedPort = null } = {}) {
  if (!Array.isArray(targets)) {
    throw new TypeError("renderer targets must be an array");
  }
  if (expectedPort !== null) validatePort(expectedPort);
  if (targets.length > MAX_DISCOVERY_TARGETS) {
    throw new RangeError(`renderer target discovery returned more than ${MAX_DISCOVERY_TARGETS} targets`);
  }
  return targets.filter((target) => isRendererTarget(target, expectedPort)).sort(compareTargets);
}

async function readDiscoveryJson(response) {
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) {
          throw new TypeError("renderer discovery body emitted a non-byte chunk");
        }
        total += value.byteLength;
        if (total > MAX_DISCOVERY_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          throw new RangeError(
            `renderer discovery body is larger than ${MAX_DISCOVERY_BODY_BYTES} bytes`,
          );
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock?.();
    }
    const bytes = Buffer.concat(chunks, total);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  }
  if (typeof response?.json !== "function") {
    throw new Error("malformed renderer target response: missing bounded body or JSON reader");
  }
  const value = await response.json();
  let encoded;
  try { encoded = JSON.stringify(value); } catch (cause) {
    throw new Error("renderer discovery JSON cannot be serialized", { cause });
  }
  if (typeof encoded !== "string" || Buffer.byteLength(encoded) > MAX_DISCOVERY_BODY_BYTES) {
    throw new RangeError(`renderer discovery body is larger than ${MAX_DISCOVERY_BODY_BYTES} bytes`);
  }
  return value;
}

export async function fetchRendererTargets(
  port,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS,
  } = {},
) {
  validatePort(port);
  validateDuration(timeoutMs, "timeoutMs", { allowZero: false });
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let response;
  try {
    response = await awaitBeforeDeadline(
      Promise.resolve(
        fetchImpl(endpoint, { redirect: "error", signal: controller.signal }),
      ),
      {
        deadline,
        timeoutMs,
        label: "renderer target discovery",
        onTimeout: () => controller.abort(),
      },
    );
  } catch (error) {
    throw new Error(
      `failed to fetch renderer targets from ${endpoint}: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  if (response === null || typeof response !== "object" || response.ok !== true) {
    throw buildHttpError(response);
  }
  let targets;
  try {
    targets = await awaitBeforeDeadline(Promise.resolve(readDiscoveryJson(response)), {
      deadline,
      timeoutMs,
      label: "renderer target discovery JSON",
      onTimeout: () => controller.abort(),
    });
  } catch (error) {
    throw new Error(
      `malformed renderer target JSON from ${endpoint}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!Array.isArray(targets)) {
    throw new Error("malformed renderer target JSON: expected an array");
  }

  return filterRendererTargets(targets, { expectedPort: port });
}

export async function waitForRendererTargets(
  port,
  {
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
    fetchImpl = globalThis.fetch,
    sleep = sleepWithTimer,
  } = {},
) {
  validatePort(port);
  validateDuration(timeoutMs, "timeoutMs", { allowZero: true });
  validateDuration(pollMs, "pollMs", { allowZero: false });
  if (typeof sleep !== "function") {
    throw new TypeError("sleep must be a function");
  }

  let elapsedMs = 0;
  const deadline = Date.now() + timeoutMs;
  let lastError = new Error("no renderer discovery attempt completed");

  while (true) {
    try {
      const remainingBudgetMs = Math.max(
        1,
        Math.min(timeoutMs - elapsedMs, deadline - Date.now()),
      );
      const targets = await fetchRendererTargets(port, {
        fetchImpl,
        timeoutMs: remainingBudgetMs,
      });
      if (targets.length > 0) return targets;
      lastError = new Error("no matching app:// page renderer targets");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (elapsedMs >= timeoutMs || Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for renderer targets on 127.0.0.1:${port}: ${lastError.message}`,
        { cause: lastError },
      );
    }

    const delayMs = Math.min(pollMs, timeoutMs - elapsedMs);
    await sleep(delayMs);
    elapsedMs += delayMs;
  }
}

export class CdpSession {
  constructor(
    webSocketDebuggerUrl,
    {
      WebSocketImpl = globalThis.WebSocket,
      commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
      connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    } = {},
  ) {
    parseLoopbackWebSocketUrl(webSocketDebuggerUrl);
    if (typeof WebSocketImpl !== "function") {
      throw new TypeError("WebSocketImpl must be a WebSocket constructor");
    }
    validateDuration(commandTimeoutMs, "commandTimeoutMs", { allowZero: false });
    validateDuration(connectTimeoutMs, "connectTimeoutMs", { allowZero: false });

    this.webSocketDebuggerUrl = webSocketDebuggerUrl;
    this.WebSocketImpl = WebSocketImpl;
    this.commandTimeoutMs = commandTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.socket = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.socketOpen = false;
    this.opened = false;
    this.closed = false;
    this.closeStarted = false;
    this.terminalError = null;
    this.openPromise = null;
    this.resolveOpen = null;
    this.rejectOpen = null;
    this.connectTimer = null;
  }

  open() {
    if (this.closed) {
      return Promise.reject(this.terminalError ?? new Error("CDP session is closed"));
    }
    if (this.opened) return Promise.resolve(this);
    if (this.openPromise) return this.openPromise;

    this.openPromise = new Promise((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });
    this.connectTimer = setTimeout(() => {
      this.terminate(
        new Error(
          `CDP WebSocket connect timed out after ${this.connectTimeoutMs}ms`,
        ),
      );
      this.closeSocket();
    }, this.connectTimeoutMs);

    try {
      this.socket = new this.WebSocketImpl(this.webSocketDebuggerUrl);
    } catch (error) {
      this.terminate(
        new Error(`failed to open CDP WebSocket: ${errorMessage(error)}`, {
          cause: error,
        }),
      );
      return this.openPromise;
    }

    this.socket.onopen = () => {
      if (this.closed || this.socketOpen) return;
      this.clearConnectTimer();
      this.socketOpen = true;
      Promise.all([this.send("Runtime.enable"), this.send("Page.enable")])
        .then(() => {
          if (this.closed) return;
          this.opened = true;
          const resolve = this.resolveOpen;
          this.resolveOpen = null;
          this.rejectOpen = null;
          resolve?.(this);
        })
        .catch((error) => {
          this.terminate(error);
          this.closeSocket();
        });
    };
    this.socket.onmessage = (event) => this.handleMessage(event);
    this.socket.onerror = (event) => {
      const source = event?.error;
      const detail =
        source instanceof Error
          ? source.message
          : typeof event?.message === "string" && event.message.length > 0
            ? event.message
            : "unknown socket error";
      this.terminate(
        new Error(`CDP WebSocket error: ${detail}`, {
          cause: source instanceof Error ? source : undefined,
        }),
      );
      this.closeSocket();
    };
    this.socket.onclose = (event) => {
      this.closeStarted = true;
      const code = Number.isInteger(event?.code) ? event.code : "unknown";
      const reason =
        typeof event?.reason === "string" && event.reason.length > 0
          ? `, reason: ${event.reason}`
          : "";
      this.terminate(new Error(`CDP WebSocket closed (code: ${code}${reason})`));
    };

    return this.openPromise;
  }

  send(method, params = {}, { timeoutMs = this.commandTimeoutMs, maxResponseBytes = MAX_CDP_MESSAGE_BYTES } = {}) {
    if (this.closed) {
      return Promise.reject(this.terminalError ?? new Error("CDP session is closed"));
    }
    if (!this.socketOpen || !this.socket) {
      return Promise.reject(new Error("CDP session is not open"));
    }
    if (typeof method !== "string" || method.length === 0) {
      return Promise.reject(new TypeError("CDP method must be a non-empty string"));
    }

    try {
      validateDuration(timeoutMs, "timeoutMs", { allowZero: false });
      if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1
        || maxResponseBytes > CDP_UPLOAD_RESPONSE_BYTES) {
        throw new RangeError("maxResponseBytes exceeds the bounded CDP response budget");
      }
    } catch (error) {
      return Promise.reject(error);
    }

    const id = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer, maxResponseBytes });

      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(
          new Error(`failed to send CDP ${method}: ${errorMessage(error)}`, {
            cause: error,
          }),
        );
      }
    });
  }

  async evaluate(expression, { timeoutMs = this.commandTimeoutMs, maxResponseBytes = MAX_CDP_MESSAGE_BYTES } = {}) {
    if (typeof expression !== "string") {
      throw new TypeError("Runtime.evaluate expression must be a string");
    }

    const response = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      { timeoutMs, maxResponseBytes },
    );

    if (response?.exceptionDetails) {
      throw buildEvaluationError(response.exceptionDetails);
    }
    if (response?.result?.type === "undefined") return undefined;
    return response?.result?.value;
  }

  close() {
    if (this.closeStarted) return;
    this.terminate(new Error("CDP session closed by client"));
    this.closeSocket();
  }

  handleMessage(event) {
    if (typeof event?.data !== "string") {
      this.terminate(new Error("received a non-text CDP WebSocket message"));
      this.closeSocket();
      return;
    }
    const messageBytes = Buffer.byteLength(event.data);
    let receiveBudget = MAX_CDP_MESSAGE_BYTES;
    for (const entry of this.pending.values()) {
      receiveBudget = Math.max(receiveBudget, entry.maxResponseBytes ?? MAX_CDP_MESSAGE_BYTES);
    }
    if (event.data.length > receiveBudget || messageBytes > receiveBudget) {
      this.terminate(new RangeError(`received CDP message larger than ${receiveBudget} bytes`));
      this.closeSocket();
      return;
    }

    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      this.terminate(
        new Error(`received malformed CDP JSON: ${errorMessage(error)}`, {
          cause: error,
        }),
      );
      this.closeSocket();
      return;
    }

    const pending = Number.isInteger(message?.id) ? this.pending.get(message.id) : undefined;
    if (!pending) {
      if (messageBytes > MAX_CDP_MESSAGE_BYTES) {
        this.terminate(new RangeError("unsolicited CDP message exceeds its budget"));
        this.closeSocket();
      }
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (messageBytes > (pending.maxResponseBytes ?? MAX_CDP_MESSAGE_BYTES)) {
      pending.reject(new RangeError("CDP response exceeds its command budget"));
      return;
    }
    if (message.error) {
      pending.reject(buildCdpError(pending.method, message.error));
      return;
    }
    pending.resolve(message.result);
  }

  terminate(error) {
    if (this.terminalError) return;
    this.clearConnectTimer();
    this.terminalError = error;
    this.closed = true;
    this.socketOpen = false;

    const rejectOpen = this.rejectOpen;
    this.resolveOpen = null;
    this.rejectOpen = null;
    rejectOpen?.(error);

    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }

  clearConnectTimer() {
    if (this.connectTimer === null) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  closeSocket() {
    if (this.closeStarted) return;
    this.closeStarted = true;
    if (!this.socket || typeof this.socket.close !== "function") return;

    const closing = this.WebSocketImpl.CLOSING ?? 2;
    const closed = this.WebSocketImpl.CLOSED ?? 3;
    if (this.socket.readyState === closing || this.socket.readyState === closed) return;
    this.socket.close();
  }
}
