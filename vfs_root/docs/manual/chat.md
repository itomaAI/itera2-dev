# Chat (💬 `system/apps/chat.html`)

A standalone LLM chat. It is separate from the OS conversation: the agent, its tools and the chat panel's history are not involved, and nothing said here reaches them. Use it for quick questions and thinking out loud.

## Using it

- **Left**: the list of chats, newest first. **+ New chat** starts an empty one.
- **Model** (top): **Same as OS (…)** uses the model and settings of the OS chat. The other entries are the models that can be called right now (an API key is set, or you are signed in for the hosted ones), each with its default settings.
- **Title**: click it to rename. When left empty, it is the first 40 characters of the first message.
- **⚙** system prompt (per chat; not sent when empty) · **🗑** delete the chat (its attachments go to the trash with it) · **☰** show / hide the list.
- **Attachments**: 📎 (files from this device), 📁 (files already in the OS), pasting into the input, or drag & drop. They line up above the input; ✕ removes one.
  - Text files (txt, md, json, csv, source code, … — decided by extension) are read and sent **as text**, wrapped in `--- Attached file: name ---` / `--- End of file ---`.
  - Everything else (images, PDF, audio, video) is sent as media. When the selected model is unlikely to accept one (type or size), a confirmation is shown before sending. The final verdict is the model's answer.
  - Images are shown as thumbnails in the message, other files as chips. Click to open with the default app.
- **Enter** sends, **Shift+Enter** inserts a new line. While a reply is being generated the send button becomes **Stop**.
- **Bottom line**: the size of the last prompt (in tokens) against the model's context limit, and the last output size.

## Data

- One file per chat: `data/apps/chat/<YYYYMMDD-HHMMSS-xxxx>.json`
  `{ id, title, createdAt, updatedAt, model, system, messages: [{ role: 'user'|'model', content, at, attachments?: [{ path, name, mime, size }], model?, stopReason? }], lastUsage }`
- Attachments: `data/apps/chat/files/<chat id>/<timestamp>_<name>`. A file picked from the OS is copied here, so the chat keeps working when the original moves.
  Attachments that were removed before sending, or left unsent when switching chats, are deleted permanently.
- A chat with no messages is not saved.
- Per-device state (selected model, last opened chat, whether the list is shown) is kept on the device, not in the file system.
- Usage is recorded in the OS usage log (`system/logs/usage/`) with `caller: chat` and `tag: chat-<chat id>`, so it shows up in Billing.

## Behaviour

- Every send carries the whole chat, including earlier attachments (nothing is remembered on the other side).
- **Stop**: the partial reply is kept, marked `(stopped)`.
- **Failure**: the message is taken back out of the chat; its text returns to the input and its attachments to the attachment row, and the reason is shown.
- There is no search across chats.
