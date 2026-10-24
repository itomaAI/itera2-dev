# PDF tools (`pdf_tool`) — page count, extract pages into a new PDF, render pages to images, extract text

**Where**: `system/services/pdf_tool.html` (daemon, pid `pdf_tool`) / helper `system/lib/pdf_text.js`
**Not resident** (`autoStart: false` in `services.json`). `spawn` it when needed.

## Why it exists

The host tools only "read text" or "attach a whole file"; they know nothing about splitting a PDF.
Attaching a whole PDF puts **every page** into the AI's context (40 pages cost 40 pages).
Format-specific processing (splitting, converting) belongs in the guest as VFS → VFS tools — this is the first of them.

pdf.js ships with the host (`public/vendor/pdfjs/`, 4 MB). It is not placed in the VFS (it would be distributed to every user).
The daemon asks `MetaOS.vendor.resolve('pdfjs')` for its location before loading it (it never builds the host URL itself).
pdf.js only reads and renders — it **cannot write** a PDF — so extraction (`pdf_extract`) uses pdf-lib
(the maintained fork `@cantoo/pdf-lib`, `public/vendor/pdflib/`, 614 KB, `MetaOS.vendor.resolve('pdflib')`) and `copyPages`.
Neither is downloaded until used. Nothing is sent to an external service. Encrypted PDFs are not handled.

**Attach a PDF as a PDF by default.** Most LLM APIs read the text inside a PDF (the text layer). Rendering pages to images
loses that information (in a PDF without embedded glyphs, names show up blank). Render to images **only when the look matters**.

## Usage (AI)

```
<spawn path="system/services/pdf_tool.html" type="daemon" show="false" />
```
→ the tools arrive via `tool_available`.

| Tool | What it does | Main arguments |
| :-- | :-- | :-- |
| `pdf_info` | Page count, file size, per-page dimensions and character counts. **Call this first** | `path`, `pages` (default: all) |
| `pdf_extract` | Writes the selected pages as a **new, smaller PDF** in the VFS → `attach_file`. The text layer, fonts, images and page annotations survive | `path`, `pages` (required: `"3"` `"3-5"` `"1,4,7-9"`; all pages is refused — attach the original instead), `out` (default `system/temp/pdf/<name>/<name>_p003-005.pdf`) |
| `pdf_pages` | Renders the selected pages to PNG / JPEG in the VFS (when the look matters: drawings, layout, scans with 0 chars) | `path`, `pages` (required: `"3"` `"3-5"` `"1,4,7-9"` `"all"`), `out` (default `system/temp/pdf/<name>/`), `size` (long edge in px, default 1568), `format` |
| `pdf_text` | Extracts the text into a .txt. Reads PDFs without embedded glyphs too | `path`, `pages`, `out`, `form` (`lines` / `items`), `preview` |
| `pdf_to_text` | Old name of `pdf_text` (`from` / `to`) | — |

Flow: `pdf_info` → decide which pages to read → `pdf_extract` into a PDF of just those pages → **`attach_file` that PDF** (the cost is its page count).
Use `pdf_pages` only for the pages whose look matters. If plain text is enough, `pdf_text` (it enters the history as text; no attachment cost).
A page with 0 chars is image only (a scan) and cannot be read with `pdf_text` → `pdf_pages` (even when attached as a PDF, a page without text is treated as an image).

## Limits

* The column order of tables (as seen) is not guaranteed. To rebuild a table use `form="items"` (`y<TAB>x<TAB>text`) and the positions
* `pdf_pages` renders at most 20 pages per call (split `pages` when you need more)
* `pdf_extract` does not copy the document outline (bookmarks). Form fields and links come along per page
* Anything written to `system/temp/` is cleared on session reset. To keep it, point `out` at the user area
* Rendering (canvas) may lag while this OS's tab is in the background

## Tests

`tests/guest/pdfTool.test.ts` (line assembly, `parsePages`, `pagesLabel`, locations and wiring), `tests/guest/pdfExtract.test.ts`
(pdf.js can read the original text from a PDF cut out with pdf-lib's `copyPages`). Rendering does not run in jsdom: use a real browser or headless Chromium.
