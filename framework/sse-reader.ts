export const readSseEvents = async <T>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: {
    onEvent?: (event: T) => void | Promise<void>;
    collectEvents?: boolean;
    isTerminal?: (event: T) => boolean;
    onActivity?: () => void;
  } = {},
): Promise<T[]> => {
  const decoder = new TextDecoder();
  const events: T[] = [];
  let buffer = "";

  const processLine = async (line: string): Promise<boolean> => {
    if (!line.startsWith("data:")) return false;
    const json = line.slice(5).trim();
    if (!json || json === "[DONE]") return false;
    const event = JSON.parse(json) as T;
    await options.onEvent?.(event);
    if (options.collectEvents !== false) events.push(event);
    return options.isTerminal?.(event) ?? false;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      options.onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (await processLine(line)) return events;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await processLine(buffer);
    return events;
  } finally {
    // Preserve the original stream/callback failure if cancellation also fails.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};
