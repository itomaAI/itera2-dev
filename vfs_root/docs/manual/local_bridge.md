# Local Bridge — working with a local machine from Itera

Last updated: 2026-10-21 / server v3.8.0 / daemon v3.13

Connects part of the VFS to a real directory on a host machine (your PC or a GPU server).
**It is not only file sync: it also covers shell execution, search, and materialising / releasing files to stubs.**

## Components

| Part | Where | Role |
| :-- | :-- | :-- |
| Host-side server | `services/itera_bridge_server.py` | One file that is both the server and the CLI. Handles several roots |
| OS-side daemon | `services/local_bridge.html` (pid `local_bridge`) | Mounting, reconciliation, the LPML tools |
| Settings app | `apps/local_bridge_settings.html` | List and operate connections and roots, distribute the server |
| Connection settings | `system/config/local_bridge.json` | Connections and ignore patterns |
| Anchors | `data/apps/local_bridge/anchors/` | The state of the last sync and **the identity of the other side** |

Mount point: **`local/<connection>/<root>`**.

## Getting started

On the host (Python 3, `fastapi` / `uvicorn`, optionally `watchdog`):

```bash
python3 itera_bridge_server.py serve --port 8001      # start
python3 itera_bridge_server.py attach ~/projects/foo  # add a root (any time after start)
python3 itera_bridge_server.py ls
python3 itera_bridge_server.py detach foo             # remove
```

Roots are persisted in `~/.itera/roots.json`, so they come back on the next start.
For a machine behind ssh, forward with `ssh -L 8002:localhost:8002 <host>` and add
`http://127.0.0.1:8002` in the settings app. **You do not have to type a connection name** (the server announces its own).

## Connection names and identity

**The URL says nothing about who the other side is.** With `ssh -L` every machine's server
looks like `127.0.0.1:<port>` from the OS. The two machines in this environment even had
the same user name (`ryamauchi`) and the same home path.

So the server announces itself in `/api/status`:

* `hostname` / `user` / `platform`
* `machineId` … a UUID persisted in `~/.itera/machine.json`

The connection name is derived from `hostname` and written back into the settings (so the mount path stays stable).
**Two connections announcing the same `machineId` produce a warning** (syncing the same directory twice
makes each side read the other's writes as deletions, and the data breaks).

## Safety valves (what it stops for, and why)

* **Identity check.** The anchor records "the previous counterpart (machineId + real path of the root)";
  if they differ, **reconciliation is aborted with a warning**. This prevents old leftovers from being sent
  into a new directory when a root of the same name is pointed somewhere else.
  If the combination is intended, delete the anchor named in the warning and it resumes.
* **Tombstones apply only to files that have not moved.** A record of a deletion made on the host through the API (a tombstone)
  deletes the VFS side only for files that have not changed since the last sync. Files recreated or rewritten in the VFS
  after the deletion, and files newly added under that directory, are not deleted but sent to the host (v3.12, T-0548).
* **Disconnection never deletes.** A temporary disconnection (sleep, network drop) must not lose
  content that exists only on the VFS side. Clean-up happens only on an **intentional `detach`**.
* **Clean-up on detach.** If everything is a stub, delete. **If even one file is materialised**, nothing is deleted:
  the tree is moved aside to `local/<connection>/<root>.detached-<date>` and only the stubs that could no longer be opened are removed.
* **Releasing to stubs (`local_release`) only after confirmation.** The host must have the file and its hash must match
  before the bytes are dropped. If that cannot be confirmed, the operation aborts.
* **Stashing on conflict (both sides changed).** The VFS content is placed on the host as
  `<name>.conflict-<time>` and the original path follows the host side.
  If the stash cannot be placed, **both sides are left untouched and the file is put on hold** (it is not reported as success).
  The stash **also gets a node on the VFS side**. That is not decoration but a safety condition —
  an entry that is in the anchor but not in the VFS is read as "the user deleted it", and the daemon
  would then delete the host side (this actually happened on 2026-08-22: the stash was deleted by the daemon itself
  1.97 seconds after it was created, while the notification still said "nothing was lost").

## LPML tools (for Itera)

| Tool | Purpose |
| :-- | :-- |
| `bash_exec` | Shell execution. `scope="host"` allows running outside the roots. Pass `cwd` every time (it is not persisted) |
| `local_search` | Full-text search on the host. **Works even while the files are still stubs** |
| `local_fetch` | stub → materialised (download) |
| `local_release` | materialised → stub (frees VFS space) |

The execution mode is per connection: `ask` (confirm every time) or `auto` (no confirmation). Switch it in the settings app.

## Release all to stubs (settings app)

"Release all to stubs" on a root's row **turns that root's materialised files back into stubs in one go and frees VFS space**.
The bytes are on the host, so opening a file fetches it again automatically.

**Before dropping anything, every file is checked against the host.**

| State | What happens |
| :-- | :-- |
| The host has the same content (hash match) | Becomes a stub (the VFS bytes are dropped) |
| The host does not have the file | **Skipped** (not deleted) |
| The contents differ | **Skipped** (the VFS edit is not lost) |
| The host cannot be asked | **Aborted** (never read as "the host does not have it") |

* The decision lives **only in the daemon**. The settings app merely sends the request and receives the result; it has no copy of the logic.
  Keeping a safety decision in two places lets one be fixed and the other drift.
  Therefore **the button does not appear when the daemon is not running**.
* Files are checked 200 at a time. Asking for the whole root in one request returns nothing until the host
  has hashed every file, and no progress could be shown.
* At the end it reports "released N / skipped M". **Skipped is not failure**:
  per the table above, it means something that must not be dropped was not dropped.
* `local_release` does the same (and can be narrowed to a path). **Both go through the same function.**

## Ignored files (settings app)

For a tree whose contents you never intend to bring into the VFS (a dataset, say), it is better not to create stubs at all.
A stub holds no bytes, but **it is one entry in the index**. Tens of thousands of them make the index itself heavy
(measured 2026-08-21: 36,286 stubs → index 30.4 MB, anchor 8.6 MB).

In the settings app, write one pattern per line. **The editor opens from the buttons on the rows.**

| What you want to open | Where to click |
| :-- | :-- |
| Just that root | **"Ignore…"** on the root's row |
| Every root of that connection | **"Ignore…"** on the connection's heading |
| The defaults that apply to all connections | **"Edit common defaults…"** under "Ignored files" |

The editor edits **that level only**. The settings from the levels above are listed read-only as
**"also in effect here"**, and you can open them from there (the three levels are combined as a union, so
**a file may be ignored even when your own field is empty** — in that case the pattern is written at a higher level).
**Counting and clean-up exist only on the root's editor** (so that the scope of a deletion is never ambiguous).

| Where it is written | Where it applies |
| :------------------- | :------------------------------ |
| Common defaults | Every connection, every root |
| Per connection | Every root of that connection |
| Per root | That root only |

**The three are a union** (not an override). A connection's settings cannot weaken the common defaults;
to relax something, remove it from the common defaults.

* A pattern containing `/` is matched against the whole path relative to the root (e.g. `output/tmp`)
* A pattern without `/` is matched against **each segment** of the path (e.g. `data` also matches a `data/` in the middle)
* `*` and `?` are allowed. A line starting with `#` is a comment
* **The settings are read when the daemon starts.** After changing them, click "Restart daemon"

### It also applies to the host's enumeration (server v3.6.0 and later)

For a long time ignoring only meant **skipping on the VFS side**. The host kept scanning and hashing every file and sending it,
and the daemon dropped it after receiving it (in `kukuri/auto-sekisan`, 28,910 of 32,170 entries arrived for nothing on every round).

Daemon v3.9 **sends the list actually in effect for that root (the union of the three levels) to the host
every time it receives `/api/status`.** The host stores it in `rootIgnore` in `~/.itera/roots.json` and
follows it for scanning and searching from then on. It survives a restart. The daemon compares on every connect
and every round and resends only when the list changed.

* **The host does not add or remove anything.** It uses the list **as sent** (it takes precedence over the server-side
  common defaults; there is no union). If the host alone hid something extra, reconciliation would read that entry as
  "deleted on the host".
* Change the settings and restart the daemon, and the host receives the list on the next round (the log says the ignore patterns were handed to the host)
* **Old servers (v3.5 and earlier) do not receive it.** They are handled on the VFS side as before. The log says once that the server cannot receive it
* Changing the common defaults through the host CLI (`POST /api/config`) **has no effect on roots that received a list from the daemon**

### Patterns added later do not affect existing stubs

Ignoring only skips at the entrance of the scan, so **stubs created earlier remain**.
That is what "Clean up ignored stubs" on each root is for.

| Target | What happens |
| :------------------------ | :------------------------------------------------------------------------ |
| A stub matching a pattern | Removed from the VFS index and dropped from the anchor |
| A directory matching a pattern | Removed if nothing remains inside |
| **A materialised file** | **Not removed** (only counted. To drop it, "Release all to stubs" first) |
| Files on the host | **Never touched** |

* The count is always taken before anything is deleted and shown in the confirmation. "Count" can be clicked on its own
* Counting and clean-up both use **the settings of the running daemon** (saving alone changes nothing)
* Remove the pattern and the stubs come back on the next scan. **Nothing is lost as long as the host has the file**

## Pitfalls

* **Do not restart the server from inside `bash_exec`.**
  The shell is a **child process of the server**; killing the parent from inside it removes the channel that would return the result.
  Detach it with a delay and `setsid`. Identify the process with
  `ss -tlnp | grep ':<port>'` (= the owner of the port); the spelling of the command line is not reliable.
* **Deleting a stub, or moving it outside the mount, materialises it first and then moves it — the real file on the host disappears.**
  It is a "take out", not a "copy". Always call `unregisterSyncProvider()` before cleaning up a mount.
* **`file_info` / `list_files` cannot tell a stub from a materialised file.**
  Only `MetaOS.fs.getSyncState()` can: check `syncState === 'stub'`.
  Note that `getSyncState()` does not return `size`.
* Changes to the settings **take effect when the daemon is restarted** (button in the settings app).
* **When changes are slow to appear, first check whether the watcher is attached.**
  If `watching` is `false` for a root in `curl -s localhost:<port>/api/status`, change detection is off and the root
  runs **only on the 60-second safety scan** (slow, but not stopped).
  The reason is in `watchError` (watchdog not installed, inotify limit, …).
  Before v3.3.0, roots added with `attach` were always in this state.
* **Do not write inside `bash_exec` when measuring propagation time.**
  `/api/exec` calls **`touch()` on every scanner when the command ends**, so the change is noticed by that `touch`
  rather than by the watcher, and the measurement is meaningless. Delay the write with `setsid` so that it fires after exec has returned.

## Propagation time

**v3.5.0 (current; merged into main in PR #29)**: from a write on the host to its appearance in the VFS,
**about 2 seconds** (1.97 / 2.30 / 2.09 / 2.35 / 2.04 s).
The breakdown is below; **the dominant term today is the 1.5-second quiet period on the host**.

**v3.4.0 (old)**: about 4–6 seconds (measured 4.39 / 4.39 / 5.97). Take the table below without the long-poll row
and replace it with the OS-side polling of **0–5 seconds** (2.5 on average) plus a 0.8-second debounce.
The large spread comes from that 0–5 seconds.
**Server and daemon work across versions** (see "compatibility" below).

| Stage | Time | What the wait is for |
| :-- | :-- | :-- |
| Quiet period on the host | 1.5 s | Coalesces bursts of events. **Insurance after the hang on moving a huge tree (v2.0)**; do not shorten it lightly |
| Scan-loop tick | 0–0.5 s | `time.sleep(0.5)` in `scan_loop` |
| Long-poll tick | 0.1 s | How often the server checks whether the revision changed |
| OS-side debounce | 0.15 s | Reconciliation triggered by the host. Goes back to 0.8 s right after a write on the VFS side |
| Comparison | 0.17 s | 1,718 entries, of which 0.13 s is 34 `setTimeout(0)` calls that keep the UI responsive; the comparison itself is noise |

* **Comparing the whole tree is not slow.** 1,718 entries in 0.17 s. Delta sync is a measure for "when the tree gets much bigger",
  not the dominant term today (measured).
* **When it takes more than 2 seconds, check `watching` first** (above), then the server version.
  Servers before v3.4.0 have no long-poll and the OS side falls back to polling every 5 seconds.
* **No delay while another tab is in front (daemon v3.11 and later).** Reconciliation yields every 50 entries;
  it used to do so with `setTimeout(0)`, which a background tab throttles to about once per second —
  one reconciliation of a 6,400-entry mirror took more than 2 minutes (T-0544). It now yields through a MessageChannel.
* **The freezes when many files appeared or disappeared on the host were the host's explorer, not the bridge** (T-0544).
  The explorer tree searched the whole DOM by attribute for every single change (about 7 ms each in Firefox)
  and redrew the whole tree whenever a directory was added or removed (0.5–0.7 s for 22,552 rows).
  The bigger the mirror, the bigger the DOM, so the freeze grew with the mirror.
  Rows are now looked up through an index and the tree is redrawn only when a directory moves or is renamed.
  Measured (headless Firefox 151, mirror of 26,695 entries; "freeze" is the total delay of the on-screen clock):

  | Operation on the host | Before | After |
  | :-- | :-- | :-- |
  | First connect (26,400 stubs) | 148 s, freeze 88.0 s | 40 s, freeze 0.5 s |
  | Delete 1,000 files | shown after 7.5 s, freeze 2.7 s | 3.7 s, freeze 0.2 s |
  | Create 1,000 files | shown after 9.0 s, freeze 2.7 s | 4.4 s, freeze 0.3 s |

## Change log

* Daemon v3.13 / server v3.8.0 — **Renames and moves are done on the host side (`onMove`, T-0691)**.
  Renaming or moving a folder that contains stubs (files whose contents have not been fetched) used to make the OS fetch
  every one of them first (T-0689). Now the daemon moves the real files on the host through the server's `POST /api/{root}/move`
  and the OS moves the local side with the stubs intact.
  This is delegated only **inside the same mount** and only when neither path matches an ignore pattern
  (to another root, another machine, or into an ignored area it still fetches first, as before).
  The server moves its listing (meta) on the spot, so the reconciliation right afterwards does not read
  "the new path is not on the host" and bounce.
  Old servers (v3.7 and earlier) do not know `/move` (404), so those fetch first, as before.
* Daemon v3.12 — **A deletion mark left on the host (a tombstone) no longer deletes new files in the VFS** (T-0548).
  A tombstone records "deleted on the host through the API" and lives in the server's memory until the same path
  reappears on the host or the server restarts. Reconciliation used to delete the VFS entry unconditionally, which caused two things:
  (1) a file deleted in the VFS and then recreated at the same path in the VFS was deleted;
  (2) when a directory was deleted on the host through the API, unsent files just added under it in the VFS were deleted too.
  Both were lost on both sides. Now a tombstone applies only to "files unchanged on the VFS side since the last sync".
  Everything else is treated as a change newer than the tombstone and sent to the host (a directory is removed only when it becomes empty).
* Daemon v3.11 — **Reconciliation no longer slows down in a background tab** (T-0544). The three places that yield
  (the reconciliation loop and two in the ignore clean-up) were changed from `setTimeout(0)` to a MessageChannel.
  The same change fixed the incremental update of the host explorer (`src/shell/panels/TreeView.ts`),
  which was the real cause of the freezes (see "Propagation time" above).
* Daemon v3.9 / server v3.6.0 — **Ignore patterns are passed to the host's enumeration** (T-0164).
  On every `/api/status` the daemon sends "the list in effect for that root" with `POST /api/<root>/ignore`;
  the server stores it as `rootIgnore` and uses it for scanning and searching. The server uses the list as is,
  without adding or removing anything (hiding more would make reconciliation read "deleted on the host"). Not sent to old servers.
* Daemon v3.8 — **The conflict stash was being deleted by the daemon itself right afterwards; fixed** (T-0069).
  The stash (`<name>.conflict-<time>`) is placed on the host but **had no node on the VFS side**, so the next round
  read it as "in the anchor but not in the VFS" = the user deleted it, and **deleted the host side**.
  Observed at 0.1-second resolution, the stash disappeared **1.97 seconds** after it was created,
  while the notification still said "nothing was lost".
  The fix: give the stash a node too, and **if the node cannot be created, do not put it in the anchor either**.
  The condition of branch 2 is named `isLocallyDeleted()`, with its precondition (anything in the anchor has a node) written next to it.
  The notification no longer claims what was not verified ("nothing was lost").
  v3.7 had forgotten to bump the version shown at start-up (it still said v3.6), which v3.8 corrects.
* Settings app — **The ignore editor moved to a dialog opened from the row buttons** (T-0072; the daemon is unchanged).
  v3.7 laid out one editor per level on the page, so an environment with 3 connections and 4 roots had **8 editors stacked**,
  pushing the content down. The entrances are now on the root rows and connection headings, and only **the opened level** is edited.
  Higher levels are shown read-only and can be opened from there (they combine as a union, so the editor is unusable unless you can see where a pattern came from).
  The connection heading has an entrance too, because **the settings of a connection with no roots would otherwise have nowhere to live**.
* Daemon v3.7 — **Ignored files can be edited in the settings app** (T-0059).
  Until then `ignorePatterns` existed only as a mechanism: `system/config/local_bridge.json` had to be edited by hand, and in practice
  the 9 defaults were used unchanged. Per-connection and per-root patterns were added at the same time (a union with the common defaults).
  **Ignoring only skips at the entrance of the scan, so patterns added later do not affect existing stubs.**
  Hence "Clean up ignored stubs" (`ignoreCleanup()`). The clean-up removes **only stubs and anchor entries**; it does not touch materialised files or the host.
  Running it concurrently with reconciliation would silently cancel its results, so it rides on the existing serialisation (`mount.syncing`).
* Daemon v3.6 — **"Release all to stubs" added to the settings app** (T-0037).
  The verified release was extracted into `releaseVerified()`, and both `local_release` and the settings app go through it
  (the decision is not kept in two places). Batches of 200 and progress broadcasts were added at the same time.
  App ⇄ daemon talk through the broadcasts `local_bridge:request` / `:progress` / `:result`.
  **`broadcast` is delivered to the sender as well**, so the daemon drops its own broadcasts by `origin`.
* v3.5.0 — **`/api/status` became a long-poll** (merged in PR #29; #28 had the wrong base and went into a dead-end branch, so it was reissued).
  With `?wait=<seconds>&since=<revision>` the response is held until the revision changes. The OS side stopped polling every 5 seconds
  and sends the next request as soon as one returns
  (measured end to end: 3.3–6.1 s → about 2 s; **the spread collapsed from 2.8 s to 0.4 s**;
  round trips when nothing changes 6 per 30 s → 1 per 30 s).
  Old servers do not announce `longPoll`, and for them the OS falls back to the 5-second polling.
* v3.4.0 — **Roots added with `attach` also get a change watcher**. Until then only the roots present at start-up were watched,
  and roots added later were noticed **only by the 60-second safety scan**
  (measured: from write to `rev` update 59.67 s → 1.56 s).
  `/api/status` now reports `watching` / `watchError` per root.
* v3.3.0 — Blocking handlers made plain `def` (every API stalled while a shell command ran)
* v3.2.0 — WebSocket removed in favour of `rev` polling (**changes on the host were not getting through**)
* v3.1.0 — The server announces its identity. Automatic connection names, identity check, clean-up on detach
* v3.0.0 — Two-level structure connection × root, shell execution, search, materialise / release
