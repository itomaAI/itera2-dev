# system/credentials/

**The single place for credentials.**

## Purpose

PATs, API keys, OAuth tokens and the like are gathered here.

They are not scattered around so that **the cloud-sync exclusion can be expressed as "one directory"**.
If credentials hide in `system/config/` or `memory/`, every widening of the sync scope risks missing one,
and **a credential leaks to the cloud in plain text.**

## Rules

- 🔴 **This area must never be included in cloud sync.**
- When moving to another device, credentials are **set up on each device individually**, not synced.
- Permission is R/W (daemons read, auth adapters write).
  So guest apps can read it too. This assumes both that **nothing secret is kept anywhere else** and
  that **untrusted apps are not run**.

## Naming

One file per provider.

```
system/credentials/github.json     { "pat": "..." }
system/credentials/telegram.json   { "botToken": "...", "chatId": "..." }
system/credentials/gdrive.json     { "clientId": "..." }
```

## Notes

- **Short-lived tokens (OAuth access tokens etc.) may live in `system/temp/`.**
  They are discarded on session reset, which can be the safer place. Either way, `system/temp/` is excluded from sync as well.
- When checking a value, do not open the file: look at **the key structure only**.
  The contents would remain in the conversation log in plain text.
