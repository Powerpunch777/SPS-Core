# Optional process-session input ordering

The sandbox adapter process-session bridge is optional execution plumbing. It
does not require AI, a particular provider, Native connectivity, or an OS sandbox.
Existing adapter and authenticated local-proxy contracts are unchanged.

## Failure addressed

Source CI40833647355, Linux workspaces B job123313302941, returned exit code0
but empty stdout for the existing bidirectional proxy test expecting
`out:hello\n`. Its test collector already waits for process `close`.

The previous bridge launched an independent asynchronous upload for every stdin
message. An EOF upload could finish before an earlier data upload. The remote
reader lists currently visible files and could therefore close stdin first.
Direct final-path uploads could also expose an incomplete JSON frame.

## Implemented boundary

- Snapshot each validated input frame and assign its existing12digit filename
  in receive order. Await publication before beginning the next frame.
- Use the existing queue client's atomic `writeResponseFile` publication,
  including its temporary file, rename, and refusal to overwrite an existing
  frame. A failed or refused publication fails the input operation.
- Propagate an upload failure to subsequent normal input/EOF. Do not report a
  successfully delivered EOF after an undelivered data frame.
- On stop, reject new input and join attempted uploads before publishing one
  cleanup EOF. Cleanup may attempt this EOF after a reported transport failure;
  it does not change failed input into success. Remove the session only after
  this attempt settles, so older uploads cannot recreate it afterwards.
- Keep authenticated buffered-output delivery available after remote exit.

These are local queue ordering and publication guarantees. They do not prove
remote provider/descendant termination, replay safety, or exactly-once execution.
A provider that cannot accept cleanup remains an execution/recovery uncertainty.

## Verification

`pnpm exec vitest run packages/adapter-utils/src/process-session-input-queue.test.ts`
passed6/6 on Windows using controlled promises, without sleeps or platform skips.
It covers delayed data, EOF ordering, failure propagation, payload snapshots,
idempotent cleanup, rejection of late writes, and cleanup after failed input.
`pnpm --filter @paperclipai/adapter-utils typecheck` also passed.

The existing Linux bidirectional, final-output, authentication and streaming
integration tests remain unchanged. Their updated-candidate CI result is still
required; the6unit tests do not replace those tests or deployment qualification.
