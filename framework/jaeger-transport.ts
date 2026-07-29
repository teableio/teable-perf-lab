// The seam in front of Jaeger.
//
// trace-collector.ts reaches Jaeger through exactly one `fetch` call, and it was
// a bare global one. That single un-injectable line is why verifying the
// collector's outage, budget, and breaker behaviour needs a 947-line script that
// reassigns `globalThis.fetch` twelve times — patching a process global to
// exercise one module.
//
// Two adapters make this a real seam rather than a hypothetical one: the default
// delegates to global `fetch` in production, and the outage check installs a
// scripted one. The default resolves `fetch` at call time rather than capturing
// it, so anything that still swaps the global (or a polyfill installed after
// this module loads) keeps working.

export type JaegerTransport = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

const defaultTransport: JaegerTransport = (url, init) => fetch(url, init);

let transport: JaegerTransport = defaultTransport;

/** Install a transport. Passing nothing restores the default. */
export const setJaegerTransport = (next?: JaegerTransport) => {
  transport = next ?? defaultTransport;
};

export const resetJaegerTransport = () => {
  transport = defaultTransport;
};

export const jaegerFetch: JaegerTransport = (url, init) => transport(url, init);
