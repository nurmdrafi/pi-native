# Segment isolation — prove which link is broken

A pipeline that "does not work" usually has exactly one broken link, but the visible symptom appears far from it. Isolate by substituting every segment after the suspected one with a controllable stand-in; if the symptom disappears, the fault is downstream of the substitution point, not in the code you were reading.

## When it pays for itself

- A chain with independent links: app → SDK → transport → network → third-party ingest.
- A failure that only occurs in one environment (container, CI, another host), where you cannot instrument the far end.
- Two candidate causes with the same symptom, e.g. "the event never fires" vs "the event fires and is dropped".

## Pattern

1. **Name the segments** in order and state what each must do, in observable terms.
2. **Substitute the tail.** Stand a local receiver in for the far end (HTTP listener, fake DSN, echo server, stub queue) and drive the real producer at it. A payload arriving at the stand-in proves capture, serialisation and send all work; the only remaining variable is the real endpoint and its reachability.
3. **Read the payload, not just the count.** Confirm the identity of what arrived (event name, route, error message, headers). An envelope that arrives empty proves less than one that carries the expected body.
4. **Probe the far end separately.** From inside the same runtime, resolve the real host and connect to the port. A DNS failure (`ENOTFOUND`) and a refused connection are different findings with different owners.
5. **Compare environments before concluding.** If the local run fails a segment that the deployed run passes, the difference is environment configuration (DNS, VPN, proxy, allowlist), not code.

## Two traps this catches

- **Green check, wrong gate.** A check that ran somewhere other than the target environment proves nothing about it. A local typecheck can pass while the build that ships fails the same file; a dev server can boot while the production bundle dies on load. Run the gate the artifact actually passes through.
- **Silent drop after acceptance.** A receiver that answers `200` may still discard the payload (server-side filters, allowlists, quota). Acceptance is not delivery: verify by reading the stored artifact, not the response code.

## Reporting

State the segment boundaries in the finding: "capture and transport verified against a local stand-in; endpoint reachability unverified from this network" is a precise, actionable status. "It should work" and "it does not work" both hide which link was actually tested.
