import { isDeepStrictEqual } from "node:util";
import pino, {
  type Bindings,
  type ChildLoggerOptions,
  type DestinationStream,
  type LevelWithSilent,
  type Logger,
  type LoggerOptions,
} from "pino";
import type { AwsProfileVersion, AzureProfileVersion, GcpProfileVersion, LoggingPreset } from "./types.js";

const PRESETS = new Set<LoggingPreset>(["default", "gcp", "aws", "azure"]);
const LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);
const LOGGER_OPTION_KEYS = new Set([
  "preset",
  "gcpProfileVersion",
  "awsProfileVersion",
  "azureProfileVersion",
  "level",
  "base",
  "redact",
  "serializers",
  "transport",
  "destination",
]);
const CHILD_OPTION_KEYS = new Set(["level", "serializers"]);
const FASTIFY_UNSET_CHILD_OPTIONS = new Set(["logger", "genReqId"]);
const PINO_IGNORED_BINDINGS = new Set(["serializers", "formatters", "customLevels"]);
const PINO_SERIALIZERS = pino.symbols.serializersSym;
const GCP_SEVERITIES: Readonly<Record<string, string>> = Object.freeze({
  trace: "DEBUG",
  debug: "DEBUG",
  info: "INFO",
  warn: "WARNING",
  error: "ERROR",
  fatal: "CRITICAL",
});

const CANONICAL_MESSAGE_KEY = "message";
const TRUSTED_LOG_FIELDS = Symbol("fastify-observability.trusted-log-fields");
const PROFILE_OWNED_LOG_FIELDS: Readonly<Record<LoggingPreset, ReadonlySet<string>>> = {
  default: new Set(["level"]),
  gcp: new Set(["severity", "httpRequest", "logging.googleapis.com/trace", "logging.googleapis.com/trace_sampled"]),
  aws: new Set(["level", "xray_trace_id"]),
  azure: new Set(["level", "operation_Id", "operation_ParentId"]),
};
const ALL_PROFILE_OWNED_LOG_FIELDS = new Set(Object.values(PROFILE_OWNED_LOG_FIELDS).flatMap((fields) => [...fields]));
const CHILD_RESERVED_BINDINGS = new Set([
  "time",
  "timestamp",
  "level",
  "msg",
  CANONICAL_MESSAGE_KEY,
  "pid",
  "hostname",
  ...PINO_IGNORED_BINDINGS,
]);

export const PROTECTED_LOG_FIELDS = new Set([
  "time",
  "timestamp",
  "level",
  "severity",
  "msg",
  CANONICAL_MESSAGE_KEY,
  "pid",
  "hostname",
  "observability_diagnostic",
  "reqId",
  "request_id",
  "correlation_id",
  "trace_id",
  "parent_id",
  "trace_flags",
  "trace_sampled",
  "trace_id_random",
  "logging.googleapis.com/trace",
  "logging.googleapis.com/trace_sampled",
  "xray_trace_id",
  "operation_Id",
  "operation_ParentId",
  "method",
  "path",
  "path_template",
  "operation_id",
  "status",
  "duration_ms",
  "peer_ip",
  "user_agent",
  "terminal_reason",
  "err",
  "httpRequest",
]);

export interface ObservabilityLoggerOptions {
  preset?: LoggingPreset;
  gcpProfileVersion?: GcpProfileVersion;
  awsProfileVersion?: AwsProfileVersion;
  azureProfileVersion?: AzureProfileVersion;
  level?: LevelWithSilent;
  base?: LoggerOptions["base"];
  redact?: LoggerOptions["redact"];
  serializers?: LoggerOptions["serializers"];
  transport?: LoggerOptions["transport"];
  destination?: DestinationStream;
}

export type ObservabilityLogger = Omit<Logger, "child" | "level" | "onChild" | "setBindings"> & {
  level: LevelWithSilent;
  child(bindings: Bindings, options?: ChildLoggerOptions): ObservabilityLogger;
};

export interface ObservabilityLoggerProfile {
  readonly preset: LoggingPreset;
  readonly gcpProfileVersion?: GcpProfileVersion;
  readonly awsProfileVersion?: AwsProfileVersion;
  readonly azureProfileVersion?: AzureProfileVersion;
}

type NativeChild = (bindings: Bindings, options?: ChildLoggerOptions) => Logger;

const profiles = new WeakMap<object, ObservabilityLoggerProfile>();

export function isProtectedLogField(key: string, preset: LoggingPreset): boolean {
  return (
    PROTECTED_LOG_FIELDS.has(key) &&
    (!ALL_PROFILE_OWNED_LOG_FIELDS.has(key) || PROFILE_OWNED_LOG_FIELDS[preset].has(key))
  );
}

const APPLICATION_EVENT_FIELDS = new Set([
  "method",
  "path",
  "path_template",
  "operation_id",
  "status",
  "duration_ms",
  "peer_ip",
  "user_agent",
  "terminal_reason",
  "httpRequest",
]);

function isProtectedApplicationLogField(key: string, preset: LoggingPreset): boolean {
  return isProtectedLogField(key, preset) && !APPLICATION_EVENT_FIELDS.has(key);
}

export function markTrustedLogFields<T extends Record<string, unknown>>(fields: T): T {
  Object.defineProperty(fields, TRUSTED_LOG_FIELDS, { value: true });
  return fields;
}

function filterApplicationLogFields(value: unknown, hasExplicitMessage: boolean, preset: LoggingPreset): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Error) {
    return value;
  }
  if (Reflect.get(value, TRUSTED_LOG_FIELDS) === true) {
    return value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  const keys = Object.keys(value);
  const isApplicationReserved = (key: string) =>
    key !== "err" &&
    !(key === CANONICAL_MESSAGE_KEY && !hasExplicitMessage) &&
    isProtectedApplicationLogField(key, preset);
  if (!keys.some(isApplicationReserved)) {
    return value;
  }
  const filtered = Object.create(prototype) as Record<string, unknown>;
  for (const key of keys) {
    if (!isApplicationReserved(key)) {
      filtered[key] = Reflect.get(value, key);
    }
  }
  return filtered;
}

export function bindingValuesEqual(left: unknown, right: unknown): boolean {
  return Object.is(left, right) || isDeepStrictEqual(left, right);
}

function validateProfileOption(
  preset: LoggingPreset,
  owner: Exclude<LoggingPreset, "default">,
  name: "gcpProfileVersion" | "awsProfileVersion" | "azureProfileVersion",
  value: string | undefined,
): void {
  if (value !== undefined && preset !== owner) {
    throw new TypeError(`${name} requires preset "${owner}"`);
  }
  if (preset === owner && value !== undefined && value !== "0.1.0") {
    throw new TypeError(`unsupported ${owner.toUpperCase()} profile version; expected 0.1.0`);
  }
}

function resolveLoggerProfile(options: ObservabilityLoggerOptions, preset: LoggingPreset): ObservabilityLoggerProfile {
  validateProfileOption(preset, "gcp", "gcpProfileVersion", options.gcpProfileVersion);
  validateProfileOption(preset, "aws", "awsProfileVersion", options.awsProfileVersion);
  validateProfileOption(preset, "azure", "azureProfileVersion", options.azureProfileVersion);
  switch (preset) {
    case "gcp":
      return Object.freeze({ preset, gcpProfileVersion: options.gcpProfileVersion ?? "0.1.0" });
    case "aws":
      return Object.freeze({ preset, awsProfileVersion: options.awsProfileVersion ?? "0.1.0" });
    case "azure":
      return Object.freeze({ preset, azureProfileVersion: options.azureProfileVersion ?? "0.1.0" });
    default:
      return Object.freeze({ preset });
  }
}

function validateOptions(options: ObservabilityLoggerOptions): ObservabilityLoggerProfile {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("logger options must be a record");
  }
  for (const key of Object.keys(options)) {
    if (!LOGGER_OPTION_KEYS.has(key)) {
      throw new TypeError(`unsupported observability logger option "${key}"`);
    }
  }
  const preset = options.preset ?? "default";
  if (!PRESETS.has(preset)) {
    throw new TypeError("logger preset must be default, gcp, aws, or azure");
  }
  if (options.level !== undefined && (typeof options.level !== "string" || !LEVELS.has(options.level))) {
    throw new TypeError("logger level must be a standard Pino level");
  }
  if (
    options.base !== undefined &&
    options.base !== null &&
    (typeof options.base !== "object" || Array.isArray(options.base))
  ) {
    throw new TypeError("logger base must be a record or null");
  }
  if (options.destination !== undefined && options.transport !== undefined) {
    throw new TypeError("logger destination and transport are mutually exclusive");
  }
  if (
    options.destination !== undefined &&
    (options.destination === null || typeof options.destination.write !== "function")
  ) {
    throw new TypeError("logger destination must provide write(message)");
  }
  return resolveLoggerProfile(options, preset);
}

function validateTransport(profile: ObservabilityLoggerProfile, transport: LoggerOptions["transport"]): void {
  if (profile.preset !== "gcp" || transport === undefined) {
    return;
  }
  // Pino's multi-target mode routes on its numeric `level` field, while the
  // canonical GCP envelope intentionally replaces that field with `severity`.
  // Reject this package-level incompatibility before leaking a Pino-internal
  // startup error. Single targets and pipelines remain supported.
  if (transport !== null && typeof transport === "object" && Array.isArray(Reflect.get(transport, "targets"))) {
    throw new TypeError("logger transport.targets is incompatible with the gcp preset; use transport.target instead");
  }
}

function validateBaseBindings(
  bindings: Readonly<Record<string, unknown>> | null | undefined,
  preset: LoggingPreset,
): void {
  if (bindings === null || bindings === undefined) {
    return;
  }
  for (const key of Object.keys(bindings)) {
    if (key === "level" || isProtectedLogField(key, preset) || PINO_IGNORED_BINDINGS.has(key)) {
      throw new Error(`fastify-observability reserves Pino base binding "${key}"`);
    }
  }
}

interface RedactionTarget {
  readonly root: string;
  readonly nested: boolean;
}

const DIRECTLY_REDACTABLE_PACKAGE_FIELDS = new Set(["path", "peer_ip", "user_agent"]);
const NESTED_REDACTABLE_PACKAGE_FIELDS = new Set(["err", "httpRequest"]);
const REDACTION_PATH_SEGMENT = /[^.[\]]+|\[([^[]\]]*?)\]/;

function redactionTarget(path: string): RedactionTarget {
  // Match the first namespace the same way Pino 10's redaction machinery
  // does. In particular, Pino accepts a leading dot and backtick-quoted
  // bracket notation, so a simple string split would allow protected paths to
  // bypass this policy.
  const first = REDACTION_PATH_SEGMENT.exec(path);
  if (first === null) {
    return { root: path, nested: false };
  }
  let root = (first[1] ?? first[0]).trim();
  const quote = root[0];
  if ((quote === '"' || quote === "'" || quote === "`") && root.at(-1) === quote) {
    root = root.slice(1, -1);
  }
  const remainder = path.slice(first.index + first[0].length);
  return { root, nested: REDACTION_PATH_SEGMENT.test(remainder) };
}

function protectedRedactionPath(path: string, preset: LoggingPreset): boolean {
  const { root, nested } = redactionTarget(path);
  if (root === "*") {
    return true;
  }
  if (!isProtectedLogField(root, preset)) {
    return false;
  }
  if (DIRECTLY_REDACTABLE_PACKAGE_FIELDS.has(root)) {
    return false;
  }
  return !(nested && NESTED_REDACTABLE_PACKAGE_FIELDS.has(root));
}

function validateRedaction(redact: LoggerOptions["redact"], preset: LoggingPreset): void {
  if (redact === undefined) {
    return;
  }
  if (redact === null || (typeof redact !== "object" && !Array.isArray(redact))) {
    throw new TypeError("logger redact must be an array or record");
  }
  const paths = Array.isArray(redact) ? redact : Reflect.get(redact, "paths");
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
    throw new TypeError("logger redact paths must be strings");
  }
  for (const path of paths) {
    if (protectedRedactionPath(path, preset)) {
      throw new Error(`fastify-observability does not allow redaction of protected field "${path}"`);
    }
  }
}

function validateSerializers(
  serializers: unknown,
  preset: LoggingPreset,
  allowStandardError = false,
  allowReplaceableError = false,
): void {
  if (serializers === undefined) {
    return;
  }
  if (serializers === null || typeof serializers !== "object" || Array.isArray(serializers)) {
    throw new TypeError("logger serializers must be a record");
  }
  for (const key of Object.keys(serializers)) {
    const serializer = Reflect.get(serializers, key);
    if (typeof serializer !== "function") {
      throw new TypeError(`logger serializer "${key}" must be a function`);
    }
    // Fastify installs Pino's standard error serializer on its logger child. Internal
    // validation permits only that exact implementation; root options never opt in.
    if (key === "err" && ((allowStandardError && serializer === pino.stdSerializers.err) || allowReplaceableError)) {
      continue;
    }
    if (isProtectedLogField(key, preset)) {
      throw new Error(`fastify-observability does not allow a serializer for protected field "${key}"`);
    }
  }
}

function snapshotBindings(logger: Logger): Record<string, unknown> {
  const bindings: unknown = logger.bindings();
  if (bindings === null || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new TypeError("logger bindings must be a record");
  }
  return bindings as Record<string, unknown>;
}

function validatePublicChildBindings(logger: Logger, bindings: unknown): asserts bindings is Bindings {
  if (bindings === null || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new TypeError("logger child bindings must be a record");
  }
  const parent = snapshotBindings(logger);
  for (const key of Object.keys(bindings)) {
    if (CHILD_RESERVED_BINDINGS.has(key)) {
      throw new Error(`fastify-observability reserves Pino child binding "${key}"`);
    }
    if (Object.hasOwn(parent, key)) {
      throw new Error(`canonical Pino child would duplicate binding "${key}"`);
    }
  }
}

function isFastifyInitializationOptions(options: object): boolean {
  return [...FASTIFY_UNSET_CHILD_OPTIONS].every(
    (key) => Object.hasOwn(options, key) && Reflect.get(options, key) === undefined,
  );
}

function normalizeChildOptions(options: unknown, preset: LoggingPreset): ChildLoggerOptions | undefined {
  if (options === undefined) {
    return undefined;
  }
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("logger child options must be a record");
  }
  for (const key of Object.keys(options)) {
    if (
      !CHILD_OPTION_KEYS.has(key) &&
      !(FASTIFY_UNSET_CHILD_OPTIONS.has(key) && Reflect.get(options, key) === undefined)
    ) {
      throw new Error(`fastify-observability canonical loggers do not allow child option "${key}"`);
    }
  }
  const fastifyInitialization = isFastifyInitializationOptions(options);
  const serializers = Reflect.get(options, "serializers");
  if (Object.hasOwn(options, "serializers")) {
    validateSerializers(serializers, preset, true, fastifyInitialization);
  }
  const level = Reflect.get(options, "level");
  if (level !== undefined && level !== null && level !== "" && (typeof level !== "string" || !LEVELS.has(level))) {
    throw new TypeError("logger child level must be a standard Pino level");
  }
  // Fastify supports Pino 9 or 10 and may resolve a different module copy. Its
  // standard err serializer is therefore not reliably comparable by identity;
  // replace it on Fastify's internal initialization child instead of trusting it.
  if (
    fastifyInitialization &&
    serializers !== null &&
    typeof serializers === "object" &&
    Object.hasOwn(serializers, "err")
  ) {
    return {
      ...(options as ChildLoggerOptions),
      serializers: { ...(serializers as LoggerOptions["serializers"]), err: pino.stdSerializers.err },
    };
  }
  return options as ChildLoggerOptions;
}

function freezeEffectiveSerializers(logger: Logger, preset: LoggingPreset): void {
  const serializers: unknown = Reflect.get(logger, PINO_SERIALIZERS);
  validateSerializers(serializers, preset, true);
  if (serializers !== null && typeof serializers === "object") {
    Object.freeze(serializers);
  }
}

function registerLogger(
  logger: Logger,
  profile: ObservabilityLoggerProfile,
  nativeChild: NativeChild,
  onChild: (child: Logger) => void,
): void {
  if (profiles.has(logger)) {
    return;
  }
  freezeEffectiveSerializers(logger, profile.preset);
  profiles.set(logger, profile);
  Object.defineProperties(logger, {
    child: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: (bindings: unknown, options?: unknown) => {
        const childOptions = normalizeChildOptions(options, profile.preset);
        validatePublicChildBindings(logger, bindings);
        return Reflect.apply(nativeChild, logger, [bindings, childOptions]);
      },
    },
    onChild: {
      configurable: false,
      enumerable: true,
      writable: false,
      value: onChild,
    },
    setBindings: {
      configurable: false,
      enumerable: false,
      writable: false,
      value: () => {
        throw new Error("fastify-observability canonical loggers do not allow setBindings()");
      },
    },
  });
}

export function canonicalLoggerProfile(logger: object): ObservabilityLoggerProfile | undefined {
  return profiles.get(logger);
}

export function getObservabilityLoggerProfile(logger: object): ObservabilityLoggerProfile {
  const profile = profiles.get(logger);
  if (profile === undefined) {
    throw new TypeError("logger is not a fastify-observability canonical logger");
  }
  return profile;
}

export function createCanonicalChild(logger: Logger, bindings: Bindings): Logger {
  const profile = profiles.get(logger);
  if (profile === undefined) {
    throw new TypeError("logger is not a fastify-observability canonical logger");
  }
  const child = logger.child(bindings);
  if (profiles.get(child) !== profile) {
    throw new TypeError("Pino child logger contract was not preserved");
  }
  return child;
}

/** Creates a Pino logger that writes one compact JSON object plus LF per event. */
export function createObservabilityLogger(options: ObservabilityLoggerOptions = {}): ObservabilityLogger {
  const profile = validateOptions(options);
  validateTransport(profile, options.transport);
  validateBaseBindings(options.base, profile.preset);
  validateRedaction(options.redact, profile.preset);
  validateSerializers(options.serializers, profile.preset);

  let nativeChild: NativeChild | undefined;
  const onChild = (child: Logger) => {
    if (nativeChild === undefined) {
      throw new Error("Pino created a child before canonical logger initialization completed");
    }
    registerLogger(child, profile, nativeChild, onChild);
  };
  const loggerOptions: LoggerOptions = {
    messageKey: CANONICAL_MESSAGE_KEY,
    onChild,
    hooks: {
      logMethod(inputArgs, method) {
        const first = filterApplicationLogFields(inputArgs[0], typeof inputArgs[1] === "string", profile.preset);
        if (first === inputArgs[0]) {
          method.apply(this, inputArgs);
          return;
        }
        inputArgs[0] = first;
        method.apply(this, inputArgs);
      },
    },
  };
  if (profile.preset === "gcp") {
    loggerOptions.formatters = { level: (label) => ({ severity: GCP_SEVERITIES[label] ?? "INFO" }) };
  }
  if (options.level !== undefined) {
    loggerOptions.level = options.level;
  }
  if (options.base !== undefined) {
    loggerOptions.base = options.base;
  }
  if (options.redact !== undefined) {
    loggerOptions.redact = options.redact;
  }
  if (options.serializers !== undefined) {
    loggerOptions.serializers = options.serializers;
  }
  if (options.transport !== undefined) {
    loggerOptions.transport = options.transport;
  }

  const logger = pino(loggerOptions, options.destination);
  nativeChild = logger.child as unknown as NativeChild;
  registerLogger(logger, profile, nativeChild, onChild);
  return logger as ObservabilityLogger;
}
