import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const CONTROL_PATH = "/v1/persistence";
const THEME_CONTROL_PATH = "/v1/theme";
const USER_THEME_PATH = "/v1/user-theme";
const NATIVE_THEME_ID = "__heige_native__";
const LOCAL_CUSTOM_THEME_ID = "custom-upload";
const THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AUDITED_ORIGIN = "app://-";
const PREFLIGHT_METHOD = "POST";
const PREFLIGHT_HEADERS = ["content-type", "x-heige-control-token"];
const RESPONSE_PREFLIGHT_HEADERS = "Content-Type, X-HeiGe-Control-Token";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
// 视频发布没有固定大小或时长上限；实际可用容量由本机内存与磁盘决定。
const DEFAULT_USER_THEME_MAX_BODY_BYTES = null;
const DEFAULT_USER_THEME_REQUEST_TIMEOUT_MS = null;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const DATA_URL_IMAGE = /^data:((?:image\/(?:png|jpeg|webp)|video\/(?:mp4|webm)));base64,([A-Za-z0-9+/=\s]+)$/;

const SAFE_ERRORS = Object.freeze({
  NOT_FOUND: { status: 404, message: "控制接口不存在" },
  METHOD_NOT_ALLOWED: { status: 405, message: "请求方法不受支持" },
  INVALID_HOST: { status: 400, message: "请求主机无效" },
  ORIGIN_FORBIDDEN: { status: 403, message: "请求来源不受信任" },
  INVALID_PREFLIGHT: { status: 400, message: "预检请求无效" },
  UNAUTHORIZED: { status: 401, message: "控制凭证无效" },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    message: "请求必须使用 application/json",
  },
  TRANSFER_ENCODING_FORBIDDEN: { status: 400, message: "不接受分块请求" },
  LENGTH_REQUIRED: { status: 411, message: "请求必须声明 Content-Length" },
  INVALID_CONTENT_LENGTH: { status: 400, message: "Content-Length 无效" },
  PAYLOAD_TOO_LARGE: { status: 413, message: "请求体过大" },
  INVALID_JSON: { status: 400, message: "请求 JSON 无效" },
  INVALID_REQUEST: { status: 400, message: "请求参数无效" },
  REVISION_CONFLICT: { status: 409, message: "状态已发生变化，请重试" },
  REQUEST_TIMEOUT: { status: 408, message: "请求超时，请重试" },
  CONTROL_BUSY: { status: 503, message: "控制服务繁忙，请稍后重试" },
  CONTROL_UNAVAILABLE: { status: 503, message: "控制服务暂时不可用，请重试" },
  PERSISTENCE_UPDATE_FAILED: { status: 503, message: "常驻设置失败，请重试" },
  THEME_UPDATE_FAILED: { status: 503, message: "主题状态同步失败，请重试" },
  USER_THEME_PUBLISH_FAILED: { status: 503, message: "自定义主题写入启动器失败，请重试" },
  USER_THEME_DELETE_FAILED: { status: 503, message: "自定义主题删除失败，请重试" },
  BACKGROUND_START_FAILED: {
    status: 503,
    message: "后台控制器启动失败，常驻仍为关闭",
  },
});

class ProtocolError extends Error {
  constructor(code, state = undefined) {
    super(code);
    this.name = "ProtocolError";
    this.code = code;
    this.state = state;
  }
}

class RequestTimeoutError extends Error {
  constructor() {
    super("request timed out");
    this.name = "RequestTimeoutError";
  }
}

class ClientDisconnectedError extends Error {
  constructor() {
    super("client disconnected");
    this.name = "ClientDisconnectedError";
  }
}

class ControlClosingError extends Error {
  constructor() {
    super("control server is closing");
    this.name = "ControlClosingError";
  }
}

function protocolError(code, state) {
  return new ProtocolError(code, state);
}

function normalizeAllowedOrigins(allowedOrigins) {
  if (
    allowedOrigins === null ||
    allowedOrigins === undefined ||
    typeof allowedOrigins === "string" ||
    typeof allowedOrigins[Symbol.iterator] !== "function"
  ) {
    throw new Error("allowedOrigins 必须是来源集合");
  }
  const origins = new Set(allowedOrigins);
  if ([...origins].some((origin) => typeof origin !== "string")) {
    throw new Error("allowedOrigins 只能包含字符串");
  }
  if (!origins.has(AUDITED_ORIGIN)) {
    throw new Error("allowedOrigins 必须包含 app://-");
  }
  return origins;
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new Error(`${name} 必须是函数`);
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

function requireOptionalPositiveInteger(value, name) {
  return value === null ? null : requirePositiveInteger(value, name);
}

function requirePort(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error("port 必须是 0 到 65535 之间的整数");
  }
  return value;
}

function requireControlToken(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value) ||
    Buffer.from(value, "base64url").length !== 32 ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  ) {
    throw new Error("token 必须是 32 字节无填充 canonical base64url");
  }
  return value;
}

function singleHeader(request, name) {
  const lowerName = name.toLowerCase();
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === lowerName) {
      values.push(request.rawHeaders[index + 1]);
    }
  }
  return {
    count: values.length,
    value: values.length === 1 ? values[0] : undefined,
  };
}

function isAllowedOrigin(originHeader, allowedOrigins) {
  return (
    originHeader.count === 1 &&
    originHeader.value === AUDITED_ORIGIN &&
    allowedOrigins.has(originHeader.value)
  );
}

function exactTokenMatches(candidate, expected) {
  if (typeof candidate !== "string") return false;
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function extractState(value) {
  if (value === null || typeof value !== "object") return null;
  let persistenceEnabled;
  let revision;
  try {
    persistenceEnabled = value.persistenceEnabled;
    revision = value.revision;
  } catch {
    return null;
  }
  if (typeof persistenceEnabled !== "boolean" || !isNonNegativeInteger(revision)) {
    return null;
  }
  return {
    persistenceEnabled,
    revision,
  };
}

function extractThemeState(value) {
  const state = extractState(value);
  if (state === null) return null;
  let selectedThemeId;
  let lastNonNativeThemeId;
  try {
    selectedThemeId = value.selectedThemeId;
    lastNonNativeThemeId = value.lastNonNativeThemeId;
  } catch {
    return null;
  }
  if (
    !(
      selectedThemeId === NATIVE_THEME_ID ||
      isFormalThemeId(selectedThemeId)
    ) ||
    !isFormalThemeId(lastNonNativeThemeId)
  ) {
    return null;
  }
  return { ...state, selectedThemeId, lastNonNativeThemeId };
}

function isFormalThemeId(value) {
  return typeof value === "string" &&
    value !== LOCAL_CUSTOM_THEME_ID &&
    THEME_ID.test(value);
}

function extractErrorState(error) {
  if (error === null || typeof error !== "object") return null;
  try {
    return extractState(error.state) ?? extractState(error);
  } catch {
    return null;
  }
}

function isVerifiedBackgroundFailure(current, input, state) {
  if (
    state === null ||
    input.persistenceEnabled !== true ||
    current.persistenceEnabled !== false ||
    state.persistenceEnabled !== false
  ) {
    return false;
  }
  if (state.revision === current.revision) return true;
  return (
    current.revision <= Number.MAX_SAFE_INTEGER - 2 &&
    state.revision === current.revision + 2
  );
}

function exactRequestBody(value) {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "persistenceEnabled" ||
    keys[1] !== "revision" ||
    !isNonNegativeInteger(value.revision) ||
    typeof value.persistenceEnabled !== "boolean"
  ) {
    return null;
  }
  return {
    revision: value.revision,
    persistenceEnabled: value.persistenceEnabled,
  };
}

function exactThemeRequestBody(value) {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort();
  const hasRequestId = keys.includes("requestId");
  if (
    !(
      (keys.length === 2 && keys[0] === "revision" && keys[1] === "themeId") ||
      (
        keys.length === 3 &&
        keys[0] === "requestId" &&
        keys[1] === "revision" &&
        keys[2] === "themeId"
      )
    ) ||
    !isNonNegativeInteger(value.revision) ||
    !(
      value.themeId === NATIVE_THEME_ID ||
      isFormalThemeId(value.themeId)
    ) ||
    (
      hasRequestId &&
      (
        typeof value.requestId !== "string" ||
        !/^[a-f0-9]{32}$/.test(value.requestId)
      )
    )
  ) {
    return null;
  }
  return {
    revision: value.revision,
    themeId: value.themeId,
    ...(hasRequestId ? { requestId: value.requestId } : {}),
  };
}

function safeBody(code, state = undefined) {
  const definition = SAFE_ERRORS[code] ?? SAFE_ERRORS.CONTROL_UNAVAILABLE;
  const body = {
    ok: false,
    code: SAFE_ERRORS[code] === undefined ? "CONTROL_UNAVAILABLE" : code,
    message: definition.message,
  };
  const safeState = extractState(state);
  if (safeState !== null) {
    body.persistenceEnabled = safeState.persistenceEnabled;
    body.revision = safeState.revision;
  }
  return { status: definition.status, body };
}

function okBody(state) {
  return {
    status: 200,
    body: {
      ok: true,
      persistenceEnabled: state.persistenceEnabled,
      revision: state.revision,
    },
  };
}

function okThemeBody(state) {
  return {
    status: 200,
    body: {
      ok: true,
      persistenceEnabled: state.persistenceEnabled,
      revision: state.revision,
      themeId: state.selectedThemeId,
    },
  };
}

function okUserThemeBody(state, themeId) {
  return {
    status: 200,
    body: {
      ok: true,
      persistenceEnabled: state.persistenceEnabled,
      revision: state.revision,
      themeId,
    },
  };
}

function exactUserThemeColors(value) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "accent" ||
    keys[1] !== "secondary" ||
    keys[2] !== "surface" ||
    keys[3] !== "text"
  ) {
    return null;
  }
  for (const key of keys) {
    if (typeof value[key] !== "string" || !HEX_COLOR.test(value[key])) return null;
  }
  return {
    accent: value.accent,
    secondary: value.secondary,
    surface: value.surface,
    text: value.text,
  };
}

function parseUserThemeImage(image) {
  if (typeof image !== "string" || image.length < 32) return null;
  const match = DATA_URL_IMAGE.exec(image);
  if (match === null) return null;
  const mime = match[1];
  let bytes;
  try {
    bytes = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  } catch {
    return null;
  }
  if (bytes.byteLength < 1) return null;
  const extension = mime === "image/png"
    ? ".png"
    : mime === "image/webp"
      ? ".webp"
      : mime === "video/mp4"
        ? ".mp4"
        : mime === "video/webm"
          ? ".webm"
          : ".jpg";
  return { bytes, extension, mime };
}

function exactUserThemePublishBody(value) {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort();
  const allowed = new Set(["action", "colors", "image", "name", "requestId", "revision"]);
  if (keys.some((key) => !allowed.has(key))) return null;
  if (!keys.includes("revision") || !keys.includes("requestId") || !keys.includes("name") || !keys.includes("image")) {
    return null;
  }
  if (keys.includes("action") && value.action !== "publish") return null;
  if (!isNonNegativeInteger(value.revision)) return null;
  if (typeof value.requestId !== "string" || !/^[a-f0-9]{32}$/.test(value.requestId)) return null;
  if (typeof value.name !== "string" || value.name.trim().length < 1 || value.name.trim().length > 80) {
    return null;
  }
  if (/[\0\r\n]/.test(value.name)) return null;
  const parsedImage = parseUserThemeImage(value.image);
  if (parsedImage === null) return null;
  const colors = exactUserThemeColors(value.colors);
  if (value.colors !== undefined && colors === null) return null;
  return {
    action: "publish",
    revision: value.revision,
    requestId: value.requestId,
    name: value.name.trim(),
    imageBytes: parsedImage.bytes,
    extension: parsedImage.extension,
    ...(colors === undefined ? {} : { colors }),
  };
}

function exactUserThemeDeleteBody(value) {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "action" ||
    keys[1] !== "requestId" ||
    keys[2] !== "revision" ||
    keys[3] !== "themeId"
  ) {
    return null;
  }
  if (value.action !== "delete") return null;
  if (!isNonNegativeInteger(value.revision)) return null;
  if (typeof value.requestId !== "string" || !/^[a-f0-9]{32}$/.test(value.requestId)) return null;
  if (
    typeof value.themeId !== "string" ||
    value.themeId === LOCAL_CUSTOM_THEME_ID ||
    value.themeId === NATIVE_THEME_ID ||
    !THEME_ID.test(value.themeId)
  ) {
    return null;
  }
  return {
    action: "delete",
    revision: value.revision,
    requestId: value.requestId,
    themeId: value.themeId,
  };
}

function exactUserThemeRequestBody(value) {
  if (!isPlainObject(value)) return null;
  if (value.action === "delete") return exactUserThemeDeleteBody(value);
  return exactUserThemePublishBody(value);
}

function readBody(request, maxBodyBytes, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.length;
      if (maxBodyBytes !== null && totalBytes > maxBodyBytes) {
        settle(reject, protocolError("PAYLOAD_TOO_LARGE"));
        request.resume();
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => settle(resolve, Buffer.concat(chunks, totalBytes));
    const onAborted = () => settle(reject, protocolError("INVALID_REQUEST"));
    const onError = () => settle(reject, protocolError("INVALID_REQUEST"));
    const onAbort = () => settle(
      reject,
      signal.reason instanceof Error ? signal.reason : new RequestTimeoutError(),
    );

    if (signal.aborted) {
      onAbort();
      return;
    }
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("aborted", onAborted);
    request.on("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validatePreflight(request) {
  const method = singleHeader(request, "access-control-request-method");
  const requestedHeaders = singleHeader(request, "access-control-request-headers");
  if (method.count !== 1 || method.value !== PREFLIGHT_METHOD) {
    throw protocolError("INVALID_PREFLIGHT");
  }
  if (requestedHeaders.count !== 1) throw protocolError("INVALID_PREFLIGHT");
  const normalized = requestedHeaders.value
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .sort();
  if (
    normalized.length !== PREFLIGHT_HEADERS.length ||
    normalized.some((header, index) => header !== PREFLIGHT_HEADERS[index])
  ) {
    throw protocolError("INVALID_PREFLIGHT");
  }
}

function parseContentLength(request, maxBodyBytes) {
  const transferEncoding = singleHeader(request, "transfer-encoding");
  if (transferEncoding.count !== 0) {
    throw protocolError("TRANSFER_ENCODING_FORBIDDEN");
  }

  const contentLength = singleHeader(request, "content-length");
  if (contentLength.count === 0) throw protocolError("LENGTH_REQUIRED");
  if (contentLength.count !== 1 || !/^[0-9]+$/.test(contentLength.value)) {
    throw protocolError("INVALID_CONTENT_LENGTH");
  }
  const length = Number(contentLength.value);
  if (!Number.isSafeInteger(length) || length === 0) {
    throw protocolError("INVALID_CONTENT_LENGTH");
  }
  if (maxBodyBytes !== null && length > maxBodyBytes) throw protocolError("PAYLOAD_TOO_LARGE");
  return length;
}

function throwIfAborted(signal) {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new RequestTimeoutError();
}

function waitForPrecommit(value, signal) {
  if (signal.aborted) return Promise.reject(
    signal.reason instanceof Error ? signal.reason : new RequestTimeoutError(),
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const settle = (callback, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(result);
    };
    const onAbort = () => settle(
      reject,
      signal.reason instanceof Error ? signal.reason : new RequestTimeoutError(),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => settle(resolve, result),
      (error) => settle(reject, error),
    );
  });
}

function createPersistenceCoordinator(maxTransactions) {
  const queue = [];
  let activeTransaction;
  let pendingTransactions = 0;
  let closing = false;
  let closePromise;
  let resolveClose;

  const notifyDrained = () => {
    if (
      closing &&
      activeTransaction === undefined &&
      queue.length === 0 &&
      resolveClose !== undefined
    ) {
      resolveClose();
      resolveClose = undefined;
    }
  };

  const settleTransaction = (transaction, outcome, value) => {
    if (transaction.phase === "settled") return;
    transaction.phase = "settled";
    transaction.precommitSignal.removeEventListener("abort", transaction.onAbort);
    pendingTransactions -= 1;
    if (outcome === "resolve") transaction.resolve(value);
    else transaction.reject(value);
    notifyDrained();
  };

  const removeQueuedTransaction = (transaction) => {
    const index = queue.indexOf(transaction);
    if (index !== -1) queue.splice(index, 1);
  };

  const runNext = () => {
    if (activeTransaction !== undefined) return;
    const transaction = queue.shift();
    if (transaction === undefined) {
      notifyDrained();
      return;
    }
    if (transaction.phase === "settled") {
      runNext();
      return;
    }
    activeTransaction = transaction;
    transaction.phase = "precommit";
    const assertPrecommit = () => {
      if (transaction.phase !== "precommit") throw new ControlClosingError();
      throwIfAborted(transaction.precommitSignal);
    };
    const api = {
      assertPrecommit,
      waitPrecommit(value) {
        assertPrecommit();
        return waitForPrecommit(value, transaction.precommitSignal);
      },
      enterCommit() {
        assertPrecommit();
        transaction.phase = "committing";
        transaction.markCommitStarted();
        return transaction.commitController.signal;
      },
    };
    void (async () => {
      let outcome = "resolve";
      let value;
      try {
        value = await transaction.operation(api);
      } catch (error) {
        outcome = "reject";
        value = error;
      }
      activeTransaction = undefined;
      settleTransaction(transaction, outcome, value);
      runNext();
    })();
  };

  const cancelTransaction = (transaction, reason) => {
    if (transaction.phase === "committing" || transaction.phase === "settled") {
      return false;
    }
    if (!transaction.cancelController.signal.aborted) {
      transaction.cancelController.abort(reason);
    }
    return true;
  };

  return {
    run(signal, markCommitStarted, operation) {
      if (closing) return Promise.reject(new ControlClosingError());
      if (pendingTransactions >= maxTransactions) {
        return Promise.reject(protocolError("CONTROL_BUSY"));
      }
      return new Promise((resolve, reject) => {
        const cancelController = new AbortController();
        const precommitSignal = AbortSignal.any([
          signal,
          cancelController.signal,
        ]);
        const transaction = {
          phase: "queued",
          operation,
          markCommitStarted,
          resolve,
          reject,
          cancelController,
          commitController: new AbortController(),
          precommitSignal,
          onAbort: undefined,
        };
        transaction.onAbort = () => {
          if (transaction.phase !== "queued") return;
          removeQueuedTransaction(transaction);
          const reason = precommitSignal.reason instanceof Error
            ? precommitSignal.reason
            : new RequestTimeoutError();
          settleTransaction(transaction, "reject", reason);
          runNext();
        };
        pendingTransactions += 1;
        precommitSignal.addEventListener("abort", transaction.onAbort, { once: true });
        if (precommitSignal.aborted) {
          transaction.onAbort();
          return;
        }
        queue.push(transaction);
        runNext();
      });
    },
    close(reason = new ControlClosingError()) {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      closePromise = new Promise((resolve) => {
        resolveClose = resolve;
      });
      for (const transaction of [...queue]) cancelTransaction(transaction, reason);
      if (activeTransaction !== undefined) cancelTransaction(activeTransaction, reason);
      notifyDrained();
      return closePromise;
    },
  };
}

async function applyPersistenceRequest(input, context, transaction) {
  let current;
  try {
    current = extractState(await transaction.waitPrecommit(context.readState()));
  } catch {
    transaction.assertPrecommit();
    throw protocolError("CONTROL_UNAVAILABLE");
  }
  if (current === null) throw protocolError("CONTROL_UNAVAILABLE");

  if (current.persistenceEnabled === input.persistenceEnabled) {
    return okBody(current);
  }
  if (current.revision !== input.revision) {
    throw protocolError("REVISION_CONFLICT", current);
  }

  let updated;
  try {
    const commitSignal = transaction.enterCommit();
    updated = extractState(await context.setPersistence({
      expectedRevision: input.revision,
      enabled: input.persistenceEnabled,
      signal: commitSignal,
    }));
  } catch (error) {
    const authoritativeState = extractErrorState(error);
    const safeAuthoritativeState = (
      authoritativeState !== null &&
      authoritativeState.revision >= current.revision
    )
      ? authoritativeState
      : null;
    let code;
    try {
      code = error?.code;
    } catch {
      code = undefined;
    }
    if (code === "REVISION_CONFLICT") {
      throw protocolError("REVISION_CONFLICT", safeAuthoritativeState ?? undefined);
    }
    if (
      code === "BACKGROUND_START_FAILED" &&
      isVerifiedBackgroundFailure(current, input, safeAuthoritativeState)
    ) {
      throw protocolError("BACKGROUND_START_FAILED", safeAuthoritativeState ?? undefined);
    }
    throw protocolError("PERSISTENCE_UPDATE_FAILED", safeAuthoritativeState ?? undefined);
  }
  if (
    updated === null ||
    updated.persistenceEnabled !== input.persistenceEnabled ||
    updated.revision !== current.revision + 1
  ) {
    throw protocolError("PERSISTENCE_UPDATE_FAILED");
  }
  return {
    ...okBody(updated),
    persistenceUpdate: updated,
  };
}

async function applyThemeRequest(input, context, transaction) {
  let current;
  try {
    current = extractThemeState(await transaction.waitPrecommit(context.readState()));
  } catch {
    transaction.assertPrecommit();
    throw protocolError("CONTROL_UNAVAILABLE");
  }
  if (current === null) throw protocolError("CONTROL_UNAVAILABLE");
  if (current.selectedThemeId === input.themeId) return okThemeBody(current);
  if (current.revision !== input.revision) {
    throw protocolError("REVISION_CONFLICT", current);
  }

  let updated;
  try {
    const commitSignal = transaction.enterCommit();
    updated = extractThemeState(await context.setThemeSelection({
      expectedRevision: input.revision,
      themeId: input.themeId,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      signal: commitSignal,
    }));
  } catch (error) {
    let code;
    try { code = error?.code; } catch { code = undefined; }
    const authoritative = extractErrorState(error);
    if (code === "REVISION_CONFLICT") {
      throw protocolError("REVISION_CONFLICT", authoritative ?? undefined);
    }
    throw protocolError("THEME_UPDATE_FAILED", authoritative ?? undefined);
  }
  if (
    updated === null ||
    updated.persistenceEnabled !== current.persistenceEnabled ||
    updated.selectedThemeId !== input.themeId ||
    updated.revision !== current.revision + 1 ||
    (
      input.themeId === NATIVE_THEME_ID
        ? updated.lastNonNativeThemeId !== current.lastNonNativeThemeId
        : updated.lastNonNativeThemeId !== input.themeId
    )
  ) {
    throw protocolError("THEME_UPDATE_FAILED");
  }
  return okThemeBody(updated);
}

async function applyUserThemeRequest(input, context, transaction) {
  let current;
  try {
    current = extractThemeState(await transaction.waitPrecommit(context.readState()));
  } catch {
    transaction.assertPrecommit();
    throw protocolError("CONTROL_UNAVAILABLE");
  }
  if (current === null) throw protocolError("CONTROL_UNAVAILABLE");
  if (current.revision !== input.revision) {
    throw protocolError("REVISION_CONFLICT", current);
  }

  let updated;
  try {
    const commitSignal = transaction.enterCommit();
    if (input.action === "delete") {
      updated = extractThemeState(await context.deleteUserTheme({
        expectedRevision: input.revision,
        themeId: input.themeId,
        requestId: input.requestId,
        signal: commitSignal,
      }));
    } else {
      updated = extractThemeState(await context.publishUserTheme({
        expectedRevision: input.revision,
        name: input.name,
        imageBytes: input.imageBytes,
        extension: input.extension,
        ...(input.colors === undefined ? {} : { colors: input.colors }),
        requestId: input.requestId,
        signal: commitSignal,
      }));
    }
  } catch (error) {
    let code;
    try { code = error?.code; } catch { code = undefined; }
    const authoritative = extractErrorState(error);
    if (code === "REVISION_CONFLICT") {
      throw protocolError("REVISION_CONFLICT", authoritative ?? undefined);
    }
    throw protocolError(
      input.action === "delete" ? "USER_THEME_DELETE_FAILED" : "USER_THEME_PUBLISH_FAILED",
      authoritative ?? undefined,
    );
  }
  if (updated === null || updated.persistenceEnabled !== current.persistenceEnabled) {
    throw protocolError(
      input.action === "delete" ? "USER_THEME_DELETE_FAILED" : "USER_THEME_PUBLISH_FAILED",
    );
  }
  if (input.action === "delete") {
    if (updated.selectedThemeId === input.themeId) {
      throw protocolError("USER_THEME_DELETE_FAILED");
    }
    return okUserThemeBody(updated, updated.selectedThemeId);
  }
  if (
    typeof updated.selectedThemeId !== "string" ||
    !isFormalThemeId(updated.selectedThemeId) ||
    updated.revision < input.revision ||
    updated.revision > input.revision + 1
  ) {
    throw protocolError("USER_THEME_PUBLISH_FAILED");
  }
  return okUserThemeBody(updated, updated.selectedThemeId);
}

async function routePersistenceRequest(request, context, signal, markCommitStarted) {
  const userThemeRequest = request.url === USER_THEME_PATH;
  if (
    request.url !== CONTROL_PATH &&
    request.url !== THEME_CONTROL_PATH &&
    !userThemeRequest
  ) {
    throw protocolError("NOT_FOUND");
  }
  if (request.method !== "POST" && request.method !== "OPTIONS") {
    throw protocolError("METHOD_NOT_ALLOWED");
  }

  const host = singleHeader(request, "host");
  if (host.count !== 1 || host.value !== context.expectedHost) {
    throw protocolError("INVALID_HOST");
  }

  const origin = singleHeader(request, "origin");
  if (!isAllowedOrigin(origin, context.allowedOrigins)) {
    throw protocolError("ORIGIN_FORBIDDEN");
  }

  if (request.method === "OPTIONS") {
    validatePreflight(request);
    return { status: 204, body: null, preflight: true };
  }

  const suppliedToken = singleHeader(request, "x-heige-control-token");
  if (
    suppliedToken.count !== 1 ||
    !exactTokenMatches(suppliedToken.value, context.token)
  ) {
    throw protocolError("UNAUTHORIZED");
  }

  const contentType = singleHeader(request, "content-type");
  if (contentType.count !== 1 || contentType.value !== "application/json") {
    throw protocolError("UNSUPPORTED_MEDIA_TYPE");
  }

  const bodyLimit = userThemeRequest ? context.userThemeMaxBodyBytes : context.maxBodyBytes;
  const declaredLength = parseContentLength(request, bodyLimit);
  const bytes = await readBody(request, bodyLimit, signal);
  throwIfAborted(signal);
  if (bytes.length !== declaredLength) throw protocolError("INVALID_CONTENT_LENGTH");

  let parsed;
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch {
    throw protocolError("INVALID_JSON");
  }
  if (userThemeRequest) {
    const input = exactUserThemeRequestBody(parsed);
    if (input === null) throw protocolError("INVALID_REQUEST");
    return context.persistenceCoordinator.run(
      signal,
      markCommitStarted,
      (transaction) => applyUserThemeRequest(input, context, transaction),
    );
  }
  const themeRequest = request.url === THEME_CONTROL_PATH;
  const input = themeRequest ? exactThemeRequestBody(parsed) : exactRequestBody(parsed);
  if (input === null) throw protocolError("INVALID_REQUEST");

  return context.persistenceCoordinator.run(
    signal,
    markCommitStarted,
    (transaction) => themeRequest
      ? applyThemeRequest(input, context, transaction)
      : applyPersistenceRequest(input, context, transaction),
  );
}

function sendResponse(response, descriptor, corsOrigin, request, onFinished = undefined) {
  if (response.destroyed || response.writableEnded) return;
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (corsOrigin !== undefined) {
    headers["Access-Control-Allow-Origin"] = corsOrigin;
    headers.Vary = "Origin";
    // Codex renderer 是 app://-，访问 127.0.0.1 控制口会触发 Private Network Access 预检；
    // 缺此头时 Chromium/Electron 会直接 Failed to fetch，主题切换只能靠 CDP。
    headers["Access-Control-Allow-Private-Network"] = "true";
  }
  if (descriptor.preflight) {
    headers["Access-Control-Allow-Methods"] = PREFLIGHT_METHOD;
    headers["Access-Control-Allow-Headers"] = RESPONSE_PREFLIGHT_HEADERS;
    response.writeHead(204, headers);
    response.end();
    return;
  }

  const payload = JSON.stringify(descriptor.body);
  headers["Content-Type"] = "application/json; charset=utf-8";
  headers["Content-Length"] = Buffer.byteLength(payload);
  if (descriptor.closeConnection) headers.Connection = "close";
  response.writeHead(descriptor.status, headers);
  if (onFinished !== undefined) {
    response.once("finish", () => {
      void Promise.resolve().then(onFinished).catch(() => {});
    });
  }
  response.end(payload);
  if (descriptor.closeConnection) {
    response.once("finish", () => request.destroy());
  }
}

function requestHandler(context) {
  return async (request, response) => {
    const origin = singleHeader(request, "origin");
    const corsOrigin = isAllowedOrigin(origin, context.allowedOrigins)
      ? origin.value
      : undefined;
    let timeoutId;
    let commitStarted = false;
    const abortController = new AbortController();
    const abortPrecommit = (reason) => {
      if (commitStarted || abortController.signal.aborted) return;
      abortController.abort(reason);
    };
    const onDisconnect = () => {
      if (!response.writableFinished) abortPrecommit(new ClientDisconnectedError());
    };
    const requestEntry = {
      abortPrecommit,
    };
    context.activeRequestEntries.add(requestEntry);
    request.once("aborted", onDisconnect);
    response.once("close", onDisconnect);
    const timeoutMs = request.url === USER_THEME_PATH
      ? context.userThemeRequestTimeoutMs
      : context.requestTimeoutMs;
    const timeout = timeoutMs === null
      ? new Promise(() => {})
      : new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          if (commitStarted) return;
          const error = new RequestTimeoutError();
          reject(error);
          abortPrecommit(error);
        }, timeoutMs);
        timeoutId.unref?.();
      });

    try {
      const descriptor = await Promise.race([
        routePersistenceRequest(
          request,
          context,
          abortController.signal,
          () => {
            commitStarted = true;
          },
        ),
        timeout,
      ]);
      const onFinished = descriptor.persistenceUpdate === undefined ||
        context.onPersistenceResponseFinished === null
        ? undefined
        : () => context.onPersistenceResponseFinished(descriptor.persistenceUpdate);
      sendResponse(response, descriptor, corsOrigin, request, onFinished);
    } catch (error) {
      if (error instanceof RequestTimeoutError) {
        sendResponse(
          response,
          { ...safeBody("REQUEST_TIMEOUT"), closeConnection: true },
          corsOrigin,
          request,
        );
      } else if (error instanceof ClientDisconnectedError) {
        // The peer is gone and no commit started, so there is nothing to acknowledge.
      } else if (error instanceof ControlClosingError) {
        sendResponse(
          response,
          { ...safeBody("CONTROL_UNAVAILABLE"), closeConnection: true },
          corsOrigin,
          request,
        );
      } else if (error instanceof ProtocolError) {
        sendResponse(response, safeBody(error.code, error.state), corsOrigin, request);
      } else {
        sendResponse(response, safeBody("CONTROL_UNAVAILABLE"), corsOrigin, request);
      }
    } finally {
      clearTimeout(timeoutId);
      request.off("aborted", onDisconnect);
      response.off("close", onDisconnect);
      context.activeRequestEntries.delete(requestEntry);
    }
  };
}

function sendSocketError(socket, { status, statusText, code, message }) {
  if (!socket.writable) return;
  const payload = JSON.stringify({ ok: false, code, message });
  socket.end(
    [
      `HTTP/1.1 ${status} ${statusText}`,
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(payload)}`,
      "Cache-Control: no-store",
      "X-Content-Type-Options: nosniff",
      "Connection: close",
      "",
      payload,
    ].join("\r\n"),
    () => socket.destroy(),
  );
}

function sendParserError(socket) {
  sendSocketError(socket, {
    status: 400,
    statusText: "Bad Request",
    code: "INVALID_REQUEST",
    message: SAFE_ERRORS.INVALID_REQUEST.message,
  });
}

function sendHeaderTimeout(socket) {
  sendSocketError(socket, {
    status: 408,
    statusText: "Request Timeout",
    code: "REQUEST_TIMEOUT",
    message: SAFE_ERRORS.REQUEST_TIMEOUT.message,
  });
}

function listen(server, { host, port }) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });
}

function createIdempotentClose(server, sockets, activeHandlers, activeResponses, context) {
  let closePromise;
  return () => {
    if (closePromise !== undefined) return closePromise;
    context.closing = true;
    const closingError = new ControlClosingError();
    for (const entry of context.activeRequestEntries) {
      entry.abortPrecommit(closingError);
    }
    const transactionsDrained = context.persistenceCoordinator.close(closingError);
    for (const socket of sockets) socket.pause();
    const wasListening = server.listening;
    const serverClose = wasListening
      ? new Promise((resolve, reject) => {
        server.close((error) => {
          if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
          else resolve();
        });
      })
      : Promise.resolve();
    void serverClose.catch(() => {});
    closePromise = (async () => {
      await transactionsDrained;
      while (activeHandlers.size > 0) {
        await Promise.allSettled([...activeHandlers]);
      }
      while (activeResponses.size > 0) {
        await Promise.allSettled([...activeResponses]);
      }
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
      await serverClose;
    })();
    return closePromise;
  };
}

function installConnectionDeadlines(server, requestTimeoutMs, sockets) {
  const connectionState = new Map();

  const clearDeadline = (state) => {
    clearTimeout(state.headerDeadline);
    state.headerDeadline = undefined;
  };
  const armDeadline = (socket, state) => {
    clearDeadline(state);
    state.headerBytesSeen = false;
    state.headerDeadline = setTimeout(() => {
      state.headerDeadline = undefined;
      if (state.headerBytesSeen) sendHeaderTimeout(socket);
      else socket.destroy();
    }, requestTimeoutMs);
    state.headerDeadline.unref?.();
  };

  server.on("connection", (socket) => {
    const state = {
      activeRequests: 0,
      headerBytesSeen: false,
      headerDeadline: undefined,
    };
    connectionState.set(socket, state);
    sockets.add(socket);
    armDeadline(socket, state);
    socket.on("data", () => {
      if (state.activeRequests === 0) state.headerBytesSeen = true;
    });
    socket.once("close", () => {
      clearDeadline(state);
      connectionState.delete(socket);
      sockets.delete(socket);
    });
  });

  return (request, response) => {
    const state = connectionState.get(request.socket);
    if (state === undefined) return;
    clearDeadline(state);
    state.activeRequests += 1;
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      state.activeRequests -= 1;
      if (state.activeRequests === 0 && !request.socket.destroyed) {
        armDeadline(request.socket, state);
      }
    };
    response.once("finish", complete);
    response.once("close", complete);
  };
}

export async function startControlServer({
  token,
  allowedOrigins,
  readState,
  setPersistence,
  setThemeSelection,
  publishUserTheme = null,
  deleteUserTheme = null,
  onPersistenceResponseFinished,
  host = "127.0.0.1",
  port = 0,
  maxBodyBytes = 1024,
  userThemeMaxBodyBytes = DEFAULT_USER_THEME_MAX_BODY_BYTES,
  requestTimeoutMs = 1500,
  userThemeRequestTimeoutMs = DEFAULT_USER_THEME_REQUEST_TIMEOUT_MS,
  maxConnections = 8,
  maxPendingRequests = maxConnections,
}) {
  if (host !== "127.0.0.1") throw new Error("控制通道只能绑定 127.0.0.1");
  const safeToken = requireControlToken(token);
  const origins = normalizeAllowedOrigins(allowedOrigins);
  const safeReadState = requireFunction(readState, "readState");
  const safeSetPersistence = requireFunction(setPersistence, "setPersistence");
  const safeSetThemeSelection = requireFunction(setThemeSelection, "setThemeSelection");
  const safePublishUserTheme = publishUserTheme === null
    ? null
    : requireFunction(publishUserTheme, "publishUserTheme");
  const safeDeleteUserTheme = deleteUserTheme === null
    ? null
    : requireFunction(deleteUserTheme, "deleteUserTheme");
  const safeResponseFinished = onPersistenceResponseFinished === undefined
    ? null
    : requireFunction(onPersistenceResponseFinished, "onPersistenceResponseFinished");
  const safePort = requirePort(port);
  const bodyLimit = requirePositiveInteger(maxBodyBytes, "maxBodyBytes");
  const userThemeBodyLimit = requireOptionalPositiveInteger(userThemeMaxBodyBytes, "userThemeMaxBodyBytes");
  const timeoutMs = requirePositiveInteger(requestTimeoutMs, "requestTimeoutMs");
  const userThemeTimeoutMs = requireOptionalPositiveInteger(
    userThemeRequestTimeoutMs,
    "userThemeRequestTimeoutMs",
  );
  const connectionLimit = requirePositiveInteger(maxConnections, "maxConnections");
  const requestLimit = requirePositiveInteger(maxPendingRequests, "maxPendingRequests");

  const context = {
    token: safeToken,
    allowedOrigins: origins,
    readState: safeReadState,
    setPersistence: safeSetPersistence,
    setThemeSelection: safeSetThemeSelection,
    publishUserTheme: safePublishUserTheme ?? (async () => {
      throw protocolError("CONTROL_UNAVAILABLE");
    }),
    deleteUserTheme: safeDeleteUserTheme ?? (async () => {
      throw protocolError("CONTROL_UNAVAILABLE");
    }),
    onPersistenceResponseFinished: safeResponseFinished,
    maxBodyBytes: bodyLimit,
    userThemeMaxBodyBytes: userThemeBodyLimit,
    requestTimeoutMs: timeoutMs,
    userThemeRequestTimeoutMs: userThemeTimeoutMs,
    expectedHost: undefined,
    persistenceCoordinator: createPersistenceCoordinator(requestLimit),
    activeRequestEntries: new Set(),
    closing: false,
  };
  const sockets = new Set();
  const activeHandlers = new Set();
  const activeResponses = new Set();
  let pendingRequests = 0;
  const handleRequest = requestHandler(context);
  let markRequestStarted = () => {};
  const server = createServer((request, response) => {
    markRequestStarted(request, response);
    let markResponseDone;
    const responseDone = new Promise((resolve) => {
      markResponseDone = resolve;
    });
    let responseCompleted = false;
    const completeResponse = () => {
      if (responseCompleted) return;
      responseCompleted = true;
      activeResponses.delete(responseDone);
      markResponseDone();
    };
    activeResponses.add(responseDone);
    response.once("finish", completeResponse);
    response.once("close", completeResponse);
    if (context.closing) {
      const origin = singleHeader(request, "origin");
      const corsOrigin = isAllowedOrigin(origin, context.allowedOrigins)
        ? origin.value
        : undefined;
      request.resume();
      sendResponse(
        response,
        { ...safeBody("CONTROL_UNAVAILABLE"), closeConnection: true },
        corsOrigin,
        request,
      );
      return;
    }
    if (pendingRequests >= requestLimit) {
      const origin = singleHeader(request, "origin");
      const corsOrigin = isAllowedOrigin(origin, context.allowedOrigins)
        ? origin.value
        : undefined;
      request.resume();
      sendResponse(
        response,
        { ...safeBody("CONTROL_BUSY"), closeConnection: true },
        corsOrigin,
        request,
      );
      return;
    }
    pendingRequests += 1;
    const handling = handleRequest(request, response);
    activeHandlers.add(handling);
    void handling.then(
      () => {
        pendingRequests -= 1;
        activeHandlers.delete(handling);
      },
      () => {
        pendingRequests -= 1;
        activeHandlers.delete(handling);
      },
    );
  });
  server.maxConnections = connectionLimit;
  server.keepAliveTimeout = timeoutMs;
  markRequestStarted = installConnectionDeadlines(server, timeoutMs, sockets);
  server.on("clientError", (_error, socket) => sendParserError(socket));

  try {
    await listen(server, { host, port: safePort });
  } catch (error) {
    server.closeAllConnections?.();
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("控制通道监听地址无效");
  }
  context.expectedHost = `${host}:${address.port}`;

  return {
    host,
    port: address.port,
    close: createIdempotentClose(
      server,
      sockets,
      activeHandlers,
      activeResponses,
      context,
    ),
  };
}
