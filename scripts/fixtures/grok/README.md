# Grok Build streaming-json fixtures

The `grok --output-format streaming-json` event schema is **not publicly
documented** (docs.x.ai as of 2026-08-14). These `*.ndjson` files are
**synthetic, provisional** captures shaped from the documented CLI surface and
the conventions of the sibling CLIs (Claude / Codex / Cursor / Kimi). They exist
so `src/main/services/harness/grok.ts` `parseLine()` and its test
(`scripts/grok-parse-test.ts`) have a concrete contract to code against.

**Before merge (spec §8):** replace these with a real capture from a SuperGrok
Heavy or xAI API account:

```sh
grok -p "read package.json and summarize" \
  --output-format streaming-json --always-approve --no-auto-update \
  -s test-$RANDOM > basic-turn.ndjson
```

Capture the event/field names for: session announcement (if any), text,
reasoning/thinking, tool call start, tool result, final result (tokens? cost?),
and an error record (kill the network mid-run). Then reconcile the real names
with `parseLine()` and delete this notice.

`parseLine()` assumes the **`type`-tagged** NDJSON shape these fixtures encode
(the convention codex/cursor/claude use). It stays lightly tolerant — JSON.parse
guard, args-as-JSON-string, a couple of field fallbacks — and returns `[]` for
anything unrecognized (the runner synthesizes `done` on close), rather than trying
to guess several schema families at once. If the real schema is `role`-tagged (as
Kimi's is) or otherwise different, adjust the `switch` discriminator and the
fixtures together.
