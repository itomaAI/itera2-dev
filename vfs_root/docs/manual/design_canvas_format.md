# The design file (`.design`)

This document defines the file that Design Canvas saves. A design file is the shared source that a person and the AI use to exchange a screen design. Whether it is drawn in the app or written directly by the AI with `write`, it is the same file.

- Version: `itera-design/1` (adding kinds of parts does not change the version: an older app draws an unknown part as a named box and saves it unchanged)
- Extension: `.design` (the content is UTF-8 JSON). The app also opens the older `.design.json`
- Default folder: `data/designs/`
- Screen images made by **Send to AI**: next to the design file, `<file name>_screens/<screen id>.png`

## 1. What was kept from the original, and what was not

The starting point is M3E Canvas (github.com/lnkiai/m3e-canvas, MIT; its saved form is the `Doc` type in `lib/tokens.ts`). The ideas were kept; the shape was fitted to Itera OS.

| In the original | Here | Why |
| :-- | :-- | :-- |
| Screens (frames) with a name and a note | Kept (`screens[].name`, `note`) | Saying in words what a screen is for is the heart of the tool |
| Notes on parts (items) | Kept (`parts[].note`) | So that the behavior of each part can be written down |
| Navigation when a part is clicked (action `to` / `transition`, back) | Kept (`parts[].to`) | How screens connect is hard to say in a prompt and worth drawing |
| A title and a brief for the whole app | Kept (`title`, `brief`) | The purpose of the whole design needs a place |
| Phone and desktop screen sizes | Kept (`screens[].w`, `h`; desktop is the default) | Most Itera apps are desktop screens, so the default is reversed |
| Material 3 parts and colors (palette, theme, dynamicColor) | Not kept. Replaced by the parts and colors of the Itera UI kit | Itera apps are drawn with the `ui.js` colors, which follow the theme |
| Automatic layout (groups, axis, "tidy") | The layout structure was not kept: parts have coordinates inside their screen. "Arrange" exists as an operation that rewrites the coordinates once (nothing about it is stored) | Coordinates are harder to get wrong when the AI writes the file directly |
| Deciding which screen a part belongs to from its position | Not kept. A part is written inside its screen's `parts` | With position-based membership, a slightly off coordinate written by the AI puts the part on another screen |
| Prompt generation (prompt.ts, promptEdit, promptOptions) | Not kept. A summary and the file path are sent to the AI through the chat | In Itera the AI reads files in the VFS directly |
| History of notes rewritten by the AI (noteHistory) | Not kept | The app's undo is enough |
| Swipe navigation, target platform | Not kept | Not used by desktop Itera apps |

## 2. Overall shape

```json
{
  "format": "itera-design/1",
  "title": "Expenses",
  "brief": "Photograph receipts and see the total for each month. Entering one should take three steps at most.",
  "screens": [
    {
      "id": "s_list",
      "name": "List",
      "x": 0, "y": 0, "w": 1280, "h": 800,
      "bg": "app",
      "note": "The first screen. Newest first.",
      "parts": [
        { "id": "p_header", "kind": "header", "x": 0, "y": 0, "w": 1280, "h": 56, "label": "Expenses" },
        { "id": "p_add", "kind": "button", "x": 1144, "y": 72, "w": 120, "h": 36,
          "label": "Add", "variant": "primary",
          "note": "Goes to the entry screen.",
          "to": { "screen": "s_edit", "transition": "slide" } }
      ]
    }
  ],
  "notes": []
}
```

## 3. Fields

### 3.1 The design

| Field | Type | Required | Meaning |
| :-- | :-- | :-- | :-- |
| `format` | string | yes | The format version. Currently `"itera-design/1"` |
| `title` | string | yes | The name of the app (may be empty) |
| `brief` | string | no | What the app does, who uses it and how |
| `screens` | array | yes | The screens (3.2) |
| `notes` | array | no | Sticky notes on the canvas (3.4) |

### 3.2 Screens (`screens[]`)

| Field | Type | Required | Meaning |
| :-- | :-- | :-- | :-- |
| `id` | string | yes | Unique in the design. Used as a navigation target. By convention it starts with `s_` |
| `name` | string | yes | The name of the screen ("List", "Settings", …) |
| `x`, `y` | number | yes | Position of the screen's top left corner on the canvas (px) |
| `w`, `h` | number | no | Size of the screen (px). Desktop (1280×800) when omitted. A phone is 390×844 |
| `bg` | color name | no | Background of the screen (3.5). `app` when omitted |
| `note` | string | no | What this screen is for |
| `parts` | array | yes | The parts on the screen (3.3). They are drawn in array order (later ones on top) |

### 3.3 Parts (`screens[].parts[]`)

| Field | Type | Required | Meaning |
| :-- | :-- | :-- | :-- |
| `id` | string | yes | Unique in the whole design. By convention it starts with `p_` |
| `kind` | string | yes | The kind of part (section 4) |
| `x`, `y` | number | yes | Position measured from the screen's top left corner (px) |
| `w`, `h` | number | yes | Size (px) |
| `label` | string | no | The text shown on the part (a button's text, a heading, the caption of an input, …) |
| `text` | string | no | The content of the part, one line per row (rows of a list or table, body text, …; section 4) |
| `variant` | string | no | The style (defined per part in section 4) |
| `fill` | color name | no | Background color (3.5). Only when changing the part's default |
| `checked` | boolean | no | State of a checkbox or toggle |
| `value` | number | no | Progress (0–100) |
| `note` | string | no | What this part does and how it behaves |
| `to` | object | no | Navigation on click (3.6) |

### 3.4 Sticky notes (`notes[]`)

Notes about the design as a whole, placed outside the screens.

| Field | Type | Required | Meaning |
| :-- | :-- | :-- | :-- |
| `id` | string | yes | Unique. By convention it starts with `n_` |
| `x`, `y`, `w`, `h` | number | yes | Position and size on the canvas (px) |
| `text` | string | yes | The text |

### 3.5 Color names

Colors are written as the color names of the Itera UI kit (`system/core/ui.js`), not as values. Switching the theme changes the actual colors.

| Name | Tailwind class | Used for |
| :-- | :-- | :-- |
| `app` | `bg-app` | The background of the whole app |
| `panel` | `bg-panel` | A separated area (a sidebar, the frame of a form) |
| `card` | `bg-card` | Cards, inputs |
| `hover` | `bg-hover` | A selected row |
| `primary` | `bg-primary` | The main action |
| `success`, `warning`, `error` | `bg-success` and so on | Showing a state |

Text colors are decided by the part itself (`text-text-main`, `text-text-muted`).

### 3.6 Navigation (`to`)

| Field | Type | Required | Meaning |
| :-- | :-- | :-- | :-- |
| `screen` | string | yes | The `id` of the target screen. `"back"` returns to the previous screen |
| `transition` | string | no | `none` (default), `slide` or `fade` |

## 4. Kinds of parts

28 kinds. They are drawn by `system/apps/design_canvas/js/parts.js`.

| `kind` | Part | `label` | `text` | `variant` |
| :-- | :-- | :-- | :-- | :-- |
| `header` | The bar at the top of an app (back button and title) | Title | — | `back` (with a back button), `plain` |
| `sidebar` | A vertical list on the left | Caption | Items (one per line) | — |
| `tabs` | A row of tabs | — | Tab names (one per line; the first is selected) | — |
| `heading` | A heading | Text | — | `large`, `medium` (default), `small` |
| `paragraph` | Body text | — | Text | `main` (default), `muted` |
| `button` | A button | Text | — | `primary` (default), `secondary`, `ghost`, `danger` |
| `iconButton` | A button with only a symbol | Symbol (one emoji) | — | — |
| `input` | A single-line input | Caption | Placeholder | — |
| `textarea` | A multi-line input | Caption | Placeholder | — |
| `select` | A select box | Caption | Options (one per line; the first is selected) | — |
| `checkbox` | A checkbox | Text | — | — |
| `toggle` | An on / off switch | Text | — | — |
| `list` | A list of rows | — | Rows (one per line) | — |
| `card` | A card | Title | Body | — |
| `box` | A box (marks off an area) | — | — | — |
| `table` | A table | — | Rows (the first row is the header; columns are separated by a tab or `,`) | — |
| `badge` | A small badge | Text | — | `primary`, `success`, `warning`, `error`, `muted` (default) |
| `divider` | A dividing line | — | — | — |
| `image` | A placeholder for an image | What the image is | — | — |
| `progress` | A progress bar | — | — | — |
| `search` | A search box | — | Placeholder | — |
| `avatar` | A person's icon (text in a circle) | Text (1–2 characters) | — | — |
| `stat` | A large number | What the number is | Value | — |
| `menu` | A pop-up menu | — | Items (one per line; a line with only `-` is a divider) | — |
| `modal` | A dialog (draws only itself; to dim what is behind it, put a `box` underneath) | Title | Body | `confirm` (Cancel / OK; default), `danger` (Cancel / Delete), `info` (Close only) |
| `toast` | A notification at the edge of the screen | Text | — | `success` (default), `warning`, `error`, `primary`, `muted` |
| `tree` | A tree list | — | Items (one per line; two leading spaces indent one level) | — |
| `chart` | A chart | Title | Values (one `name,number` per line; a tab also separates) | `bar` (default), `line` |

The button captions drawn inside `modal` follow the interface language of the app; they are not stored in the file.

## 5. Rules (for the app and the AI alike)

- An `id` is unique in the design across screens, parts and sticky notes.
- Positions and sizes are on the 4px grid (the app snaps before saving; the AI does the same when writing).
- A part stays inside its screen (`0 <= x`, `x + w <= w of the screen`; the same for `y`).
- `to.screen` is the `id` of an existing screen, or `"back"`.
- Unknown fields are not removed. The app writes back what it read, including fields it does not know (so that an older app does not break a file from a newer version).
- An unknown `kind` is drawn by the app as a named box and saved unchanged.

## 6. The summary sent to the AI

**Send to AI** saves the design file and then posts text of the following shape, with a PNG of each screen, to the chat (`MetaOS.chat.append('user', [{ text }, { media: { path } }, …], { wake: true })`). The summary is a table of contents; the details are in the file. The images are for checking the appearance; the source is the file.

```
[Design Canvas] Sending a design: data/designs/Expenses.design
Title: Expenses — Photograph receipts and see the total for each month. …
Screens (3):
- List (s_list): 4 parts (1 with notes) / The first screen. … / Navigation: "Add" → Edit (s_edit)
- Edit (s_edit): 6 parts / … / Navigation: "Save" → back
- …
(the request written by the sender)

Screen images (3, rendered from the design file):
- List: data/designs/Expenses_screens/s_list.png
- …
```

The summary is written in the interface language of the app (English, or Japanese when the OS language is `ja`). When the images cannot be made, the list of images is replaced by one line saying so with the reason, and only the text is sent.
