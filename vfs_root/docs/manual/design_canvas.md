# Design Canvas (🎨 `system/apps/design_canvas/design_canvas.html`)

A tool for showing the AI what an app should look like. You lay out screens with the parts of the Itera UI kit, write what each screen and part is for, connect screens with navigation, and send the result to the AI as a design file plus an image of each screen.

The idea comes from M3E Canvas (github.com/lnkiai/m3e-canvas, MIT), rebuilt for the Itera UI kit, the VFS and the chat.

- Design file format: `docs/manual/design_canvas_format.md` (version `itera-design/1`, extension `.design`). The AI follows the same document when it writes a design file directly.
- Default folder: `data/designs/`
- Language: the interface follows the OS language (Settings → appearance `locale`): English by default, Japanese when it is `ja`. The text placed in new parts and the summary sent to the AI use the same language. Existing designs are never rewritten.

## 1. What it does

- Lay out screens (desktop 1280×800, phone 390×844) and place 28 kinds of parts on them.
- Write a note on each screen and part. Give a part an "On click" navigation (a target screen with a slide / fade transition, or "back"). Navigation is drawn as arrows on the canvas.
- Arrange the selected parts (align, space evenly, stack).
- Preview one screen and click through the navigation.
- Save as a design file, and **Send to AI**: a summary, the file path and a PNG of each screen go to the chat.

## 2. Operations

| To | Do this |
| :-- | :-- |
| Open | Open a `.design` file in Files, or use **Open** in the app (old `.design.json` files open too) |
| Place a part | Click it in the left list (it goes to the selected screen), or drag it onto a screen |
| Move / resize | Drag the part / drag the handle at its bottom right. Everything snaps to a 4px grid. Arrow keys move by 4px, Shift + arrow by 16px |
| Move a screen | Drag it by its name |
| Move the canvas | Drag empty space, or use the wheel. Ctrl + wheel zooms, Ctrl+0 shows everything |
| Select several | Shift-click |
| Arrange | Select two or more parts and **Arrange** appears in the right panel (section 3). With a single part selected, **Align to the screen** appears |
| Duplicate / delete / undo | Ctrl+D / Delete / Ctrl+Z (redo is Ctrl+Y) |
| Save | Ctrl+S (Ctrl+Shift+S to save under a new name) |
| Preview | **▶ Preview** at the top. Esc closes it, Backspace goes back one screen |

Dropping a part on another screen moves it to that screen.

## 3. Arrange

| Operation | What happens |
| :-- | :-- |
| Horizontal: Left / Center / Right | Aligns the selected parts to the left edge, horizontal center or right edge of the box that encloses them |
| Vertical: Top / Middle / Bottom | The same for the top edge, vertical center and bottom edge |
| Stack vertically / horizontally | Lines the parts up from the top (left) with the given gap (16px by default). The first part does not move |
| Space evenly (vertical / horizontal) | Keeps the two outer parts in place and spaces the ones between them evenly. Shown only with three or more parts selected |
| Align to the screen | With one part selected: aligns it to the edges and center of its screen |

- Only parts are arranged. Screens and sticky notes do not move.
- Parts selected on different screens are arranged screen by screen (their coordinates are relative to their own screen).
- The result is snapped to the 4px grid and kept inside the screen.

## 4. Working with the AI

- **Send to AI** saves first when there are unsaved changes, asks for an optional request, and then posts the following to the chat as a user message (`MetaOS.chat.append`):
  - the title and, per screen, the number of parts and the navigation (format document, section 6)
  - a PNG of each screen, written next to the design file as `<file name>_screens/<screen id>.png` and attached. PNGs of screens that no longer exist are deleted at that time
- The AI looks at the attached images for the appearance and reads the file for the details.
- When the AI rewrites the design file directly, the app notices and reloads it. If there are unsaved changes it does not discard them: a bar at the top offers **Reload** or **Keep editing**.
- Saving is versioned. If the file was changed from outside after it was opened, the app asks before overwriting.

## 5. How it is built

| File | Role |
| :-- | :-- |
| `js/i18n.js` | Every string shown on screen, placed in new parts or sent to the AI, in English and Japanese. No other file contains user-facing text |
| `js/parts.js` | How the 28 parts are drawn (with the color names of `ui.js`; user text goes in through `textContent`) |
| `js/model.js` | The document: loading (`normalize`), undo, the list of navigation, arranging (`arrange`), the summary for the AI (`summarize`) |
| `js/editor.js` | The canvas (selection, moving, resizing, drop, arrows, keys, zoom) |
| `js/panel.js` | The settings panel on the right (including Arrange) |
| `js/preview.js` | The preview (slide / fade) |
| `js/snapshot.js` | Turning a screen into a PNG (see below) |
| `js/main.js` | The `file` launch argument, saving and loading, reloading after outside changes, Send to AI, the language |

Elements created later (the preview frame, for example) set their layout in `style` directly: measuring before the Tailwind runtime has generated the classes gives 0.

**How the images are made**: the screen is drawn at actual size (1px = 1px) over the whole window and captured with `MetaOS.system.capture()` (a PNG of the app's own window). A screen larger than the window is captured in several shifted pieces and stitched. While capturing (1–3 seconds per screen) the app window briefly shows that screen. The captured image is not always the size of the window (display scaling), so it is corrected by ratio.

**Notes for development**:

- Awaiting the capture inside `inject_js` never returns (`capture()` is not served while the injection is waiting for its reply) and times out after 150 seconds. To try it, only start it from the injection, keep the result in a window variable and read it later. Buttons are not affected.
- `requestAnimationFrame` is sometimes not called even when the window is in front. Every wait also ends on a timeout.
- The selection can be changed through `DesignApp.editor` (`DesignApp.editor.select([...ids])`).

## 6. Known limits

- The request input of **Send to AI** and the overwrite confirmation use the OS dialogs.
- The images are drawn by this app and are not identical to the real app (the parts are samples drawn in the UI kit colors).
- The dialog, toast and menu parts draw only themselves. To dim what is behind them, put a full-screen **Box** underneath and give it a fill.
- The bottom status line keeps the language it was written in until the next message replaces it.
