import * as validators from "./validators.js";
export class WireError extends Error {
  readonly code = "INVALID_WIRE";
}
export function validateWire<T>(schemaName: string, value: unknown): T {
  const validate = (validators as Record<string, (v: unknown) => boolean>)[
    schemaName
  ];
  if (typeof validate !== "function")
    throw new WireError("Unknown schema " + schemaName);
  if (!validate(value)) throw new WireError("Invalid " + schemaName);
  return value as T;
}
