# Zip tools (`zip_tool`) — list, extract, create

**Where**: `system/services/zip_tool.html` (daemon, pid `zip_tool`) / helper `system/lib/zip_core.js`
**Not resident** (`autoStart: false` in `services.json`). `spawn` it when needed.

## Why it exists

Work is handed over as zip files (skill apps, bundles of documents). The host tools only "read text" or "attach a whole file";
they know nothing about archives, and the Explorer's zip export is a human action the AI cannot call.
Without this tool, every account ended up with its own home-made `unzip.html`. Format-specific processing belongs in the guest
as VFS → VFS tools (the same idea as `pdf_tool`).

Compression and decompression use the browser's `CompressionStream` / `DecompressionStream` (`deflate-raw`).
No external library, nothing leaves the browser.

## Usage (AI)

```
<spawn path="system/services/zip_tool.html" type="daemon" show="false" />
```
→ the tools arrive via `tool_available`.

| Tool | What it does | Main arguments |
| :-- | :-- | :-- |
| `zip_list` | Lists the entries (names, sizes, method) without extracting. **Call this first** | `path`, `encoding`, `limit` (default 200) |
| `zip_extract` | Extracts into a directory. Default target: a directory next to the zip with the same name (`a/b.zip` → `a/b/`) | `path`, `out`, `only` (globs), `strip` (drop leading folders), `overwrite` (default: keep existing files), `encoding` |
| `zip_create` | Builds a zip from a directory (or files). UTF-8 names with the flag set; deflate unless it does not shrink the file | `src`, `out` (default `<src>.zip`), `prefix` (top folder; default: the directory name), `method` (`deflate` / `store`), `exclude` (globs) |

Typical flow: `zip_list` → (the zip has one top folder? then `strip="1"`) → `zip_extract`.
To hand something over: `zip_create src="data/apps/my_app"` → `data/apps/my_app.zip` with `my_app/…` inside.

Globs (`only` / `exclude`): a bare name matches that entry and everything under it (`app` = `app/**`), a trailing `/` means
"under this directory", `**` crosses directories, `*` does not, `?` is one character. Comma-separated.

## Names and encodings

* Written zips use UTF-8 names with the UTF-8 flag (bit 11). Windows Explorer and modern tools read them correctly.
* When reading, a name without the flag is interpreted as ASCII → strict UTF-8 → **cp932** (`shift_jis`), in that order.
  Zips made with Windows' "Send to → Compressed folder" store names in cp932; this makes them readable.
  The Info-ZIP Unicode Path extra field (0x7075) is honoured when its CRC matches.
* `encoding="…"` forces another label for names without the flag (`"utf-8"`, `"euc-jp"`, …). `zip_list` says which encoding was used.

## Safety and limits

* Entries with `..`, absolute paths or drive letters are **never written** (reported as "unsafe names"). Backslashes become `/`.
* Each extracted file is checked against the CRC in the archive; a mismatch is reported as a failure, not written.
* Existing files are kept unless `overwrite="true"`; the kept ones are listed.
* Before writing, the uncompressed total is compared with the free VFS space (`MetaOS.fs.getUsage`).
* Not supported: zip64 (over 4 GB or 65,535 entries), encrypted entries, spanned archives, compression methods other than
  store (0) and deflate (8). These are refused per entry (or per archive) with a message, never silently dropped.
* The whole archive is held in memory while working; very large archives (hundreds of MB) may be slow or fail in the browser.
* Timestamps: extracted files keep the archive's modification time (2-second resolution); created zips take `updatedAt` from the VFS.

## Tests

`tests/guest/zipTool.test.ts`: round trip (store / deflate, CRC, timestamps), name encodings (UTF-8 flag, cp932, Unicode Path),
unsafe names, zip64 / encryption refusal, and the daemon end-to-end against an in-memory VFS (`zip_create` → `zip_list` → `zip_extract`,
`only` / `strip` / `overwrite`), plus wiring (registry, system prompt, `read`'s refusal hint).
