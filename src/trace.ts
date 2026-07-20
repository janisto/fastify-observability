import type { TraceContext, TraceContextLevel } from "./types.js";

const BASE_TRACEPARENT_LENGTH = 55;
const MAX_TRACEPARENT_LENGTH = 512;
const MAX_TRACESTATE_LENGTH = 512;
const MAX_TRACESTATE_MEMBERS = 32;
const KEY_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_-*/";
const LEVEL_2_KEY_CHARS = `${KEY_CHARS}@`;

function isLowerHex(value: string): boolean {
  return value.length > 0 && /^[0-9a-f]+$/.test(value);
}

export function resolveTraceContextLevel(value: unknown = 1): TraceContextLevel {
  if (value !== 1 && value !== 2) {
    throw new TypeError("traceContextLevel must be 1 or 2");
  }
  return value;
}

export function parseTraceparent(value: unknown, traceContextLevel: TraceContextLevel = 1): TraceContext | null {
  const resolvedLevel = resolveTraceContextLevel(traceContextLevel);
  if (
    typeof value !== "string" ||
    value.length < BASE_TRACEPARENT_LENGTH ||
    Buffer.byteLength(value, "utf8") > MAX_TRACEPARENT_LENGTH
  ) {
    return null;
  }
  if (value[2] !== "-" || value[35] !== "-" || value[52] !== "-") {
    return null;
  }
  const version = value.slice(0, 2);
  if (!isLowerHex(version) || version === "ff") {
    return null;
  }
  if (version === "00" && value.length !== BASE_TRACEPARENT_LENGTH) {
    return null;
  }
  if (value.length > BASE_TRACEPARENT_LENGTH && value[BASE_TRACEPARENT_LENGTH] !== "-") {
    return null;
  }
  const traceId = value.slice(3, 35);
  const parentId = value.slice(36, 52);
  const flags = value.slice(53, 55);
  if (![traceId, parentId, flags].every(isLowerHex) || /^0+$/.test(traceId) || /^0+$/.test(parentId)) {
    return null;
  }
  return Object.freeze({
    traceId,
    parentId,
    flags,
    sampled: (Number.parseInt(flags, 16) & 1) === 1,
    traceparent: value,
    traceContextLevel: resolvedLevel,
    ...(resolvedLevel === 2 && version === "00" ? { traceIdRandom: (Number.parseInt(flags, 16) & 2) === 2 } : {}),
  });
}

function validTracestateKey(key: string, level: TraceContextLevel): boolean {
  if (level === 2) {
    return (
      key.length >= 1 &&
      key.length <= 256 &&
      "abcdefghijklmnopqrstuvwxyz0123456789".includes(key[0] ?? "") &&
      [...key].every((character) => LEVEL_2_KEY_CHARS.includes(character))
    );
  }
  if (!key.includes("@")) {
    return (
      key.length >= 1 &&
      key.length <= 256 &&
      "abcdefghijklmnopqrstuvwxyz".includes(key[0] ?? "") &&
      [...key].every((character) => KEY_CHARS.includes(character))
    );
  }
  if ((key.match(/@/g) ?? []).length !== 1) {
    return false;
  }
  const [tenant = "", system = ""] = key.split("@");
  return (
    tenant.length >= 1 &&
    tenant.length <= 241 &&
    "abcdefghijklmnopqrstuvwxyz0123456789".includes(tenant[0] ?? "") &&
    [...tenant].every((character) => KEY_CHARS.includes(character)) &&
    system.length >= 1 &&
    system.length <= 14 &&
    "abcdefghijklmnopqrstuvwxyz".includes(system[0] ?? "") &&
    [...system].every((character) => KEY_CHARS.includes(character))
  );
}

function validTracestateValue(value: string): boolean {
  if (value.length < 1 || value.length > 256 || value.endsWith(" ")) {
    return false;
  }
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return (
      code === 0x20 ||
      (code >= 0x21 && code <= 0x2b) ||
      (code >= 0x2d && code <= 0x3c) ||
      (code >= 0x3e && code <= 0x7e)
    );
  });
}

function canonicalTracestate(value: string, level: TraceContextLevel): string | null {
  const members = value.split(",");
  if (members.length > MAX_TRACESTATE_MEMBERS) {
    return null;
  }
  const keys = new Set<string>();
  const canonicalMembers: string[] = [];
  for (const rawMember of members) {
    const member = rawMember.replace(/^[\t ]+|[\t ]+$/g, "");
    if (member.length === 0) {
      canonicalMembers.push("");
      continue;
    }
    if ((member.match(/=/g) ?? []).length !== 1) {
      return null;
    }
    const equals = member.indexOf("=");
    const key = member.slice(0, equals);
    const valuePart = member.slice(equals + 1);
    if (keys.has(key) || !validTracestateKey(key, level) || !validTracestateValue(valuePart)) {
      return null;
    }
    keys.add(key);
    canonicalMembers.push(`${key}=${valuePart}`);
  }
  return canonicalMembers.join(",");
}

export function attachTracestate(trace: TraceContext, values: readonly string[]): TraceContext {
  if (values.length === 0) {
    return trace;
  }
  const tracestate = values.join(",");
  if (
    tracestate.length > MAX_TRACESTATE_LENGTH ||
    ![...tracestate].every((character) => {
      const code = character.charCodeAt(0);
      return code === 0x09 || (code >= 0x20 && code <= 0x7e);
    })
  ) {
    return trace;
  }
  if (trace.traceContextLevel === undefined) {
    throw new TypeError("traceContextLevel must be 1 or 2");
  }
  const canonical = canonicalTracestate(tracestate, resolveTraceContextLevel(trace.traceContextLevel));
  return canonical === null ? trace : Object.freeze({ ...trace, tracestate: canonical });
}
