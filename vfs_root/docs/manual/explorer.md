# Files (`system/apps/explorer.html`)

An app for browsing the user areas (**data / memory / apps / docs / services**). It is separate from the explorer panel
on the left of the host and is limited to the vocabulary and operations a user needs. It shares its source with the
`system/apps/explorer.html` of Myaku-Raku; only the definition of the areas (`ROOTS`) differs. The VFS is the only truth.
The app keeps just two things: "where am I looking" and "what is selected".

## Screen

| Where | What you can do |
| :-- | :-- |
| Tree on the left | The roots of the areas and their folders. Click to go there |
| Breadcrumb at the top | The current location. Click to go up |
| List | Name, size, modified. Click to select (Ctrl for several, Shift for a range). **Double-click or Enter opens** |
| Import | Files from your PC into the current folder. **Dragging and dropping onto the list does the same.** If a file of the same name exists, you are asked whether to replace it |
| + Folder / Rename / Move to Trash | "Move to Trash" only moves to `trash/` (nothing is destroyed; the Delete key does the same) |
| ⚡ Hand to AI | Attaches the selected files to the chat. For a folder only the path is passed (the AI lists it with `list_files`) |
| Show in panel | Expands and selects the location in the host's explorer panel (`MetaOS.host.revealInExplorer`; hidden on hosts that do not have it) |

## How a file is opened

By extension: `system/registry/associations.json` first, then each app's `fileHandlers` (`apps.json`); the app found is
launched with `{ file }` (e.g. `.md` → notes).
`.html` is launched as itself, text files open in the host editor, everything else (images and so on) is only selected in the host panel.

## Entry points

* The launch argument `{ path }` starts at that location (in Myaku-Raku the "file areas" entry on the home screen uses this; the Itera home has no such section)
* If already open, `route_changed` moves it
* When the VFS changes (`vfs_mutation`) the current folder is re-read (batched for 200 ms)
