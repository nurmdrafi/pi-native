#!/usr/bin/env node
// Reference shim for the native piwrite binary, implementing the frozen v2
// contract:
//   piwrite-shim --path <p>   content = raw bytes on stdin; on success exit 0
//                             and one NDJSON line {"ok":true,"path":...,"bytes":N};
//                             on failure exit !=0 and {"ok":false,"error":...}
//   piwrite-shim --serve      length-prefixed framing on stdin: one header line
//                             {"path":"...","bytes":<u64>}\n followed immediately
//                             by exactly `bytes` raw body bytes (binary-safe, no
//                             trailing newline). One NDJSON response line
//                             {"ok":true,"path":...,"bytes":N} per request.
//                             Malformed header -> {"ok":false,...} + exit 1.
//                             EOF mid-body -> {"ok":false,"error":"truncated body"} + exit 0.
//                             EOF at a request boundary -> exit 0.
// Plain Node, no deps. Used by `bench.mjs --selftest` and as a PI_WRITE_BIN
// stand-in for smoke runs. Exit codes are best-effort parity with the binary.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const writeOne = async (p, data) => {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, data);
};

if (argv[0] === "--path" && argv[1] !== undefined) {
  const chunks = [];
  process.stdin.on("error", () => {});
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    const body = Buffer.concat(chunks);
    writeOne(argv[1], body).then(
      () => {
        emit({ ok: true, path: argv[1], bytes: body.length });
        process.exit(0);
      },
      (e) => {
        emit({ ok: false, error: String((e && e.message) || e) });
        process.exit(1);
      },
    );
  });
} else if (argv[0] === "--serve") {
  let chain = Promise.resolve(); // responses for valid requests stay in request order
  const completeRequest = (req, body) => {
    chain = chain
      .then(() => writeOne(req.path, body))
      .then(
        () => emit({ ok: true, path: req.path, bytes: body.length }),
        (e) => emit({ ok: false, error: String((e && e.message) || e) }),
      );
  };
  // Malformed header: report, then exit 1 once earlier queued responses flushed.
  const malformed = (why) => {
    emit({ ok: false, error: why });
    chain.then(
      () => process.exit(1),
      () => process.exit(1),
    );
  };
  // State machine over Buffer chunks: headers are short lines, bodies are raw
  // byte runs that may span many chunks; chunks are parked by reference and a
  // body is materialized only once fully received.
  let state = "header";
  let headerParts = [];
  let headerLen = 0;
  let cur = null; // { path, bytes } of the request whose body is being read
  let bodyParts = [];
  let bodyLen = 0;
  let bodyNeeded = 0;
  process.stdin.on("error", () => {});
  process.stdin.on("data", (c) => {
    let start = 0;
    for (;;) {
      if (state === "header") {
        const i = c.indexOf(10, start); // "\n"
        if (i === -1) {
          if (start < c.length) {
            headerParts.push(c.subarray(start));
            headerLen += c.length - start;
          }
          return;
        }
        const tail = c.subarray(start, i);
        const line = headerLen ? Buffer.concat([...headerParts, tail], headerLen + tail.length) : tail;
        headerParts = [];
        headerLen = 0;
        start = i + 1;
        let h = null;
        try {
          h = JSON.parse(line.toString("utf8"));
        } catch {}
        if (!h || typeof h.path !== "string" || typeof h.bytes !== "number" || !Number.isInteger(h.bytes) || h.bytes < 0) {
          return malformed("malformed header: expected {\"path\":string,\"bytes\":uint}");
        }
        cur = h;
        if (h.bytes === 0) {
          completeRequest(cur, Buffer.alloc(0)); // zero-length body: nothing to read
          continue;
        }
        state = "body";
        bodyNeeded = h.bytes;
        bodyParts = [];
        bodyLen = 0;
      } else {
        const avail = c.length - start;
        if (avail === 0) return; // body continues in the next chunk
        const take = Math.min(bodyNeeded, avail);
        bodyParts.push(c.subarray(start, start + take));
        bodyLen += take;
        bodyNeeded -= take;
        start += take;
        if (bodyNeeded === 0) {
          completeRequest(cur, bodyParts.length === 1 ? bodyParts[0] : Buffer.concat(bodyParts, bodyLen));
          bodyParts = [];
          bodyLen = 0;
          state = "header";
        }
      }
    }
  });
  process.stdin.on("end", () => {
    if (state === "body" && bodyNeeded > 0) {
      emit({ ok: false, error: "truncated body" });
    }
    // A partial header line at EOF never started a complete request: treat as a
    // clean boundary and exit 0.
    chain.then(
      () => process.exit(0),
      () => process.exit(0),
    );
  });
} else {
  process.stderr.write("usage: piwrite-shim --path <p> | --serve\n");
  process.exit(2);
}
