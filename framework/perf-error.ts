export type NormalizedPerfError = {
  name?: string;
  message: string;
  stack?: string;
};

export const normalizePerfError = (error: unknown): NormalizedPerfError => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return { message: String(error) };
};

// Axios errors retain request/response/config objects. Re-throwing one through
// Vitest can serialize the entire request body even though the artifact only
// needs its name, message, and stack. Return a plain Error after artifacts have
// been written so large fixture payloads do not flood local or CI logs.
export const toPerfTestFailure = (error: unknown): Error => {
  const normalized = normalizePerfError(error);
  const failure = new Error(normalized.message);
  failure.name = normalized.name ?? "Error";
  if (normalized.stack) failure.stack = normalized.stack;
  return failure;
};
