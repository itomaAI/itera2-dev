# History Event Recorder

## Purpose

`HistoryEventRecorder` writes a text-only audit projection of chat history changes to:

```text
system/logs/history/YYYY-MM-DD.jsonl
```

IndexedDB history remains the source of truth. The JSONL file is not a backup or replay format.

## Recorded events

- `append`: A completed textual turn was appended.
- `update`: A textual turn was updated.
- `delete`: A turn was deleted. Only the Turn ID is retained.
- `clear`: History was cleared, including the number of removed turns.
- `load`: Not recorded, to prevent duplicate logs at boot.

Tool-execution turns are excluded because tool activity is recorded separately in `system/logs/tool_events/`.

## Attachment policy

Only the fact that attachments existed is retained:

```json
{
  "attachments": {
    "count": 1
  }
}
```

Attachment names, paths, MIME types, metadata, and contents are not written to the history log.

Text attachment nodes are discarded as a whole. A marker is recognized only for a user Turn whose dedicated text node begins with `<user_attachment`. The untrusted attachment body is not parsed or searched, so tag-like text inside an uploaded file cannot inflate the count or leak content.

Binary uploads produce both a media node and a text marker in History. The recorder treats these as two representations of the same attachment and does not add their counts together.

## Model update coalescing

The Engine can update the same model Turn twice in one JavaScript task:

1. Raw completed response.
2. LPML-truncated final response.

The recorder uses `queueMicrotask` and retains only the latest update for each Turn ID in that task. It does not rely on arbitrary timeout delays.

## Lifecycle

`SystemBootstrapper` constructs and starts the recorder. Calling `start()` repeatedly does not create duplicate subscriptions. `stop()` unsubscribes and clears pending projections.