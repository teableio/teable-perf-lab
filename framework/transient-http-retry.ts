type HttpResponseError = {
  response?: {
    status?: number;
  };
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const isTransientHttp500 = (
  error: unknown,
): error is HttpResponseError =>
  typeof error === "object" &&
  error !== null &&
  "response" in error &&
  (error as HttpResponseError).response?.status === 500;

export const retryTransientHttp500 = async <T>(
  operation: () => Promise<T>,
  options: {
    timeoutMs: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: (retry: { attempt: number; delayMs: number }) => void;
    sleepFn?: (ms: number) => Promise<void>;
  },
): Promise<T> => {
  const {
    timeoutMs,
    initialDelayMs = 250,
    maxDelayMs = 2_000,
    onRetry,
    sleepFn = sleep,
  } = options;
  const startedAt = Date.now();
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientHttp500(error)) {
        throw error;
      }

      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) {
        throw error;
      }

      attempt += 1;
      const delayMs = Math.min(
        initialDelayMs * 2 ** (attempt - 1),
        maxDelayMs,
        remainingMs,
      );
      onRetry?.({ attempt, delayMs });
      await sleepFn(delayMs);
    }
  }
};
