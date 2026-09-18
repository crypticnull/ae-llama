# Keeping Remote Control sessions alive

`scripts/remote-sessions.ps1` keeps a Remote Control session running for
each project the owner wants reachable from his phone, and brings one
back when it dies.

## Why it exists

Remote Control links are held by the **Claude desktop app**, and the app
restarts itself to apply its own auto-updates. Measured 2026-09-17: it
restarted at 09:22:37 and again at 12:34:43 (every app process carried
that start time, and a new bundled CLI, 2.1.274, appeared at 12:34). The
machine never slept and the network never dropped. Every session went
offline at once, and the owner found out by opening his phone to a wall
of offline icons.

A session started from the CLI with `--remote-control` belongs to its OWN
process, so an app restart cannot take it down. This script starts those,
and a scheduled task keeps the script itself running.

## Adding a project

Edit `local/remote-sessions.json` — git ignores it, because the owner's
other projects are not this repo's business:

```json
{
  "projects": [
    { "name": "AE Llama",             "path": "X:\_CLAUDE\26_08_19_AE_Llama\cptk_claude" },
    { "name": "Mealplan and Tracker", "path": "X:\_CLAUDE\26_09_08_mealplan_and_tracker" }
  ]
}
```

`name` is the title, `path` is the folder the session opens in. Add an
entry, and within 15 minutes the watchdog starts it; or run
`-Action Ensure` to start it now. Nothing else needs changing.

## How a session is titled

The title is the `name` in **UPPER CASE**, to match the titles the app
already shows. A first start carries no suffix:

    AE LLAMA

If that session dies and the watchdog brings it back, the new one gets a
version number, so it reads as the next in a series rather than competing
with the entry it replaced:

    AE LLAMA v2      (came back once)
    AE LLAMA v3      (came back twice)

The number is therefore a **record of a failure**, not decoration. A
session still showing no suffix has never dropped. Nothing else may bump
it -- if the watchdog itself ends a session, that is a bug in the
watchdog, not a failure of the session (see Self-update).

## Commands

    powershell -ExecutionPolicy Bypass -File scripts\remote-sessions.ps1 -Action Status
    powershell -ExecutionPolicy Bypass -File scripts\remote-sessions.ps1 -Action Ensure
    powershell -ExecutionPolicy Bypass -File scripts\remote-sessions.ps1 -Action Stop
    powershell -ExecutionPolicy Bypass -File scripts\remote-sessions.ps1 -Action Watch

`Ensure` starts what is missing and exits. `Watch` does that every 60
seconds and does not return. `Stop` stops only the sessions this script
started, by remembered pid.

## The scheduled task

Registered as **Claude Remote Sessions**, at the owner's normal user
level (`schtasks /create` was refused as access-denied; PowerShell's
`Register-ScheduledTask` succeeded without elevation).

Two triggers, and the second one matters:

- **At logon** — starts the watchdog when he signs in.
- **Every 15 minutes, forever** — because a logon trigger fires ONCE.
  `RestartCount 3` gives Windows three attempts to restart a failed task
  and then it stops for good; a machine left on for days would never
  reach another logon, so the watchdog would stay dead. The repeating
  trigger is what makes recovery unbounded. `MultipleInstances
  IgnoreNew` means the 15-minute trigger does nothing while the watchdog
  is already running.

Also set: no execution time limit (Windows will not kill a long-running
task), start when available (a missed trigger runs late rather than
never), and start on battery.

## What it refuses to do

- **It never stops a live session.** `Stop` acts only on pids it recorded.
  Never match Claude processes by NAME: the desktop app owns a dozen
  processes called `claude`, and killing by name takes the owner's editor
  down with the session.
- **It will not join a conversation someone is in.** `--continue` resumes
  the most recent conversation in a folder, and run while an interactive
  session was open in this repo it attached to that live session -- two
  processes on one transcript. It now skips a project whose newest
  transcript was written in the last five minutes, and says so.

## Things that were measured the hard way

- **Quote the name.** Passing it as its own argument splits on the space:
  four sessions came up titled AE, Mealplan, Job and TES.
- **Pass `--continue`.** Without it a restarted session is a stranger. The
  owner asked his phone to carry on with the meal-plan UI work and it had
  no idea what he meant: the repo and the memory index survive a restart,
  the conversation does not.
- **Remember the pid you started.** Windows reports a NULL CommandLine for
  the first seconds of a hidden process, so a check made right after
  launch calls the session missing and starts a SECOND one.

## Self-update

`Watch` records the CLI binary's timestamp and size and logs it when they
change, because the CLI updates itself in place. **It does not restart
anything for it.** A running session keeps the build it launched with and
picks up the new one whenever it next restarts on its own.

It used to cycle every session onto the new build. Measured 2026-09-18,
that fired three times in seven hours (15:11, 18:45, 22:21) and each time
it killed four conversations the owner was in the middle of, bumped every
title a version, and left four more dead entries on his account that he
has no way to delete -- the titles reached `v7` in a single day, none of
it from a real failure. It also blinded itself for five minutes each
time, because killing a session writes to its transcript and the
busy-check then read that write as "someone is in there".

The rule that came out of it: **a new build is a nicety, a live
conversation is the product.** Nothing here stops a session that is
working.

## When a session will not start

A session that dies within two minutes of starting did not go offline --
it failed to start. Retrying that every minute forever would fill the
owner's account with dead entries, so the watchdog holds off for 1, 2, 4,
8 and then 15 minutes, logging `HOLD <name>: died Ns after starting`.

The hold never becomes permanent. A project that fails all night is still
retried every fifteen minutes, because the standing rule is that a
session which goes down comes back.
