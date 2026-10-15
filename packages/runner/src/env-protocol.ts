/** JSON codec for the workspace execution process. Bytes travel as base64 so one connection can carry file and shell calls. */

export function encode(value: unknown): unknown {
  if (value instanceof Uint8Array)
    return { __bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map((item) => encode(item));
  if (!value || typeof value !== "object") return value;
  const record: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) record[key] = encode(item);
  return record;
}

export function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => decode(item));
  if (!value || typeof value !== "object") return value ?? undefined;
  if (typeof (value as { __bytes?: unknown }).__bytes === "string")
    return Buffer.from((value as { __bytes: string }).__bytes, "base64");
  const record: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) record[key] = decode(item);
  return record;
}
