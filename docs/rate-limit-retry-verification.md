# Subscription retry verification

Tested on 26 October 2026, against Pi 1.1.0 (the development dependency) and installed Pi 1.4.0. These results cover the implementation in this commit.

## Automated checks

- `npm run check` passes.
- `npm test` passes, including the existing HUD tests, subscription readers, shared collector and retry lifecycle tests.
- The retry lifecycle tests also pass when run against installed Pi 1.4.0.
- `npm pack --dry-run --json` includes both extension entry points and their shared modules.

Lifecycle tests use Pi's SDK with its scripted provider. They cover native retries, subscription errors excluded by native retries, cancellation through Escape and SDK abort, model switching, disabling waiting, disabled/exhausted retry budgets, mixed native and settlement retries, preservation of earlier boundary entries, context-overflow recovery, unavailable usage and independently exhausted windows.

Collector tests verify that separate extension event-bus wrappers share one collector, simultaneous reads share a request, a post-failure refresh does not reuse an earlier reading, and waits pause background probes. Existing tests still cover provider payload/header parsing and the CodexBar workaround.

## Real model and actual tool execution

Provider: `openai-codex`. Model: `gpt-6.1-sol`. Thinking: `medium`. The extension was loaded from its file through Pi's normal resource loader, with an isolated agent directory and in-memory session. Existing credentials were resolved by Pi's model runtime.

Prompt, with the generated scratch directory represented by `<scratch>`:

```text
Use the write tool to create <scratch>/proof.txt containing exactly RATE_LIMIT_RETRY_VERIFIED followed by one newline. Do not use bash. Then reply with one short sentence.
```

The first actual model response was converted to a controlled `429 rate_limit_error` by a verification-only extension. Only the subscription usage endpoint was replaced with a short exhausted window followed by available capacity. The subsequent model requests used the real service.

Observed and independently checked:

- The retry started after the supplied reset time.
- Exactly two usage reads occurred: after failure and after reset.
- The resumed model called the actual `write` tool successfully.
- The generated file contained exactly the requested text and newline.
- The session contained one user message, with no synthetic continuation prompt.
- No extension errors occurred, and scratch data was removed.

The rate-limit response and reset were simulated. This does not prove that a live Anthropic or OpenAI account will reset at a particular instant. Live exhaustion was not induced, and a real multi-hour or weekly wait was not performed.

## Interactive verification and resource use

Ran the actual Pi 1.4.0 TUI in an isolated background tmux session with the HUD and retry extension loaded separately. A scripted provider and short quota fixture supplied the failure. Inspected terminal captures rendered to PNG at 112 and 52 columns.

The notice appeared above the editor, included a local reset time and cancellation instruction, wrapped without clipping, and left the editor available. Escape removed the notice without another provider request. The working spinner was absent during waiting.

During a five-second sample between countdown changes, the terminal capture was unchanged, CPU time remained `0:00.54`, reported CPU was `0.0%`, and RSS remained 114,640 KiB. This is a short observation, not a sustained benchmark. Pi retains its process and memory while waiting. The test tmux session was removed.

## Not covered by live end-to-end tests

- Actual account exhaustion and provider reset delays.
- A real CodexBar account mismatch or lagging reading.
- A laptop sleep/wake cycle or timezone change during a wait.
- Process-exit recovery or timed parking, which are intentionally outside this change.
