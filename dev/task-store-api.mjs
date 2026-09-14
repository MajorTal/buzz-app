import {
  address,
  changeStore,
  putRecord,
  readStore,
  scopeRecords,
  taskFile,
} from "./task-store.mjs";

export function taskStoreHandler({ viewer, file = taskFile() }) {
  return async (req, res, next) => {
    if (req.url?.split("?")[0] !== "/api/experiment/tasks") return next();
    const reply = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    const origin = `http://${req.headers.host}`;
    if (
      !/^(localhost|127\.0\.0\.1):\d+$/.test(req.headers.host ?? "") ||
      (req.headers.origin && req.headers.origin !== origin) ||
      (req.headers["sec-fetch-site"] &&
        req.headers["sec-fetch-site"] !== "same-origin") ||
      (req.method !== "GET" && req.headers.origin !== origin)
    )
      return reply(403, { error: "Origin rejected" });
    try {
      const scope = new URL(req.url, origin).searchParams.get("scope");
      if (!viewer || !scope?.endsWith(`:${viewer}`))
        return reply(403, { error: "Account scope rejected" });
      if (req.method === "GET")
        return reply(200, scopeRecords((await readStore(file)).records, scope));
      if (req.method !== "POST")
        return reply(405, { error: "Method not allowed" });
      let raw = "";
      for await (const part of req) {
        raw += part;
        if (raw.length > 1_000_000)
          return reply(413, { error: "Request too large" });
      }
      const body = JSON.parse(raw);
      const check = (key) => {
        if (address(key)[0] !== scope) throw new Error("Record scope mismatch");
      };
      const saved = await changeStore((records) => {
        if (body.action === "import") {
          for (const [key, value] of Object.entries(body.records)) {
            check(key);
            // Deleted records retain a tombstone so an old browser cannot resurrect them.
            if (!Object.hasOwn(records, key))
              putRecord(records, key, value, null);
          }
        } else if (body.action === "put") {
          check(body.key);
          putRecord(records, body.key, body.value, body.expected);
        } else throw new Error("Unknown operation");
        return scopeRecords(records, scope);
      }, file);
      return reply(200, saved);
    } catch (error) {
      return reply(error.message.includes("changed elsewhere") ? 409 : 400, {
        error: error.message,
      });
    }
  };
}

export function taskStorePlugin(options) {
  return {
    name: "task-thread-experiment",
    configureServer(server) {
      server.middlewares.use(taskStoreHandler(options));
    },
  };
}
