# Levonis Print Cloud — the workshop agent

The program that runs on the workshop's local network, drives the real
printers and the slicer, and speaks the cloud's agent protocol
(`docs/PRINT_CLOUD.md` §9). Code: `tools/print-cloud-agent/`. Plain Node.js
20 or newer, **no dependencies** (global `fetch`, `node:fs`, `node:net`,
`node:tls`, `node:crypto`, `node:child_process`).

> **Status, honestly.** Every part of the program has been exercised against
> the real Print Cloud API (in process, on real persisted records), the
> built-in printer simulator and small local fakes of OctoPrint, Moonraker, a
> Bambu Lab MQTT broker, an FTP server and a slicer CLI. **Nothing has been run
> against a real Bambu Lab, OctoPrint or Moonraker printer, or a real slicer
> binary.** Field names and command lines follow the vendors' public (or, for
> Bambu, community) documentation; each one still has to be validated on the
> workshop's own machines before the service relies on it. See
> [Tested / not tested](#tested--not-tested).

Contents: [Install](#install) · [The agent token](#the-agent-token) ·
[Binding printers](#binding-printers) · [Configuration](#configuration) ·
[How it works](#how-it-works) · [State](#state) · [Drivers](#drivers) ·
[Slicer](#slicer) · [Security](#security) · [Logs and exit codes](#logs-and-exit-codes) ·
[Limits of v1](#limits-of-v1) · [Tested / not tested](#tested--not-tested)

---

## Install

On a computer that stays on, on the same network as the printers:

```bash
# Node 20+; the repository (or just tools/print-cloud-agent/) copied to /opt/levonis-agent
sudo useradd --system --home /var/lib/levonis-agent levonis-agent
sudo install -d -o levonis-agent -m 700 /var/lib/levonis-agent /etc/levonis-agent
sudo cp tools/print-cloud-agent/config.example.json /etc/levonis-agent/agent.config.json
sudo chmod 600 /etc/levonis-agent/agent.config.json      # edit it: see Configuration
printf 'LEVONIS_AGENT_TOKEN=pca_...\nBAMBU_X2D_1_ACCESS_CODE=...\n' | sudo tee /etc/levonis-agent/env
sudo chmod 600 /etc/levonis-agent/env

# Prove the token, the bindings and every printer — sends no telemetry, opens no state:
sudo -u levonis-agent env $(cat /etc/levonis-agent/env) \
  node /opt/levonis-agent/tools/print-cloud-agent/agent.mjs --config /etc/levonis-agent/agent.config.json --check
```

Run it as a service (systemd shown; on Windows any service wrapper that sets
the environment and restarts on failure will do):

```ini
# /etc/systemd/system/levonis-agent.service
[Unit]
Description=Levonis Print Cloud workshop agent
After=network-online.target
Wants=network-online.target

[Service]
User=levonis-agent
EnvironmentFile=/etc/levonis-agent/env
ExecStart=/usr/bin/node /opt/levonis-agent/tools/print-cloud-agent/agent.mjs --config /etc/levonis-agent/agent.config.json
Restart=on-failure
RestartSec=10
# 77: the cloud refused the token; 78: configuration or state refused. Restarting fixes neither.
RestartPreventExitStatus=77 78
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

`SIGINT`/`SIGTERM` stop it gracefully: no new work is started, work in flight
gets up to ten seconds, pending job events are tried once more, the printer
connections are closed and the state lock is released. A second signal exits
at once.

## The agent token

A **full** admin (the money scope) creates the agent — in the admin console's
Print Cloud section, or with the API:

```http
POST /api/admin/print-cloud/agents
{"name": "Workshop PC", "capabilities": ["telemetry", "job_control", "slicer"]}
```

The answer carries `token` (`pca_…`) **once**; the cloud keeps only its
SHA-256. Put it in the agent's environment (`cloud.token_env`, default
`LEVONIS_AGENT_TOKEN`) — the configuration file may not contain it (a file
that does is refused). Revoke with `POST /api/admin/print-cloud/agents/{id}/revoke`;
the agent then exits with code 77.

Capabilities, least privilege first:

| Capability | Lets the agent | Without it |
|---|---|---|
| `telemetry` | report readings of its printers | no readings: the printers look silent and get no work |
| `job_control` | report job events, read the files and input of jobs on its printers | it never starts a print |
| `slicer` | claim slicing requests and read their files | it claims nothing |
| `camera` | reserved by the cloud; this agent does not use it (camera metadata travels inside telemetry) | — |

A slicing PC and a printer bay can run two agents with two tokens; each
reads only what its capabilities and printers allow (`GET /files/{id}` is
scoped to the job it slices or prints).

## Binding printers

Each printer row names the agent and an opaque `connection_ref`; the agent's
configuration maps that same `connection_ref` to the machine's address and
credentials, which never leave the LAN:

```http
PATCH /api/admin/print-cloud/catalog/printers/{id}
{"adapter": "agent", "agent_id": "pcag_…", "connection_ref": "lan-x2d-1"}
```

A printer bound to the agent whose `connection_ref` has no local entry is
logged once (`printer.not_configured`) and sends no telemetry — the cloud
keeps showing it as never connected, which is the truth. `--check` lists
both directions of mismatch.

## Configuration

`tools/print-cloud-agent/config.example.json` is a complete, commented
example. The file is validated strictly: an unknown key is an error (a typo
such as `acess_code_env` would otherwise leave a printer silently
unconfigured). Keys starting with `_` are comments. Relative paths are
relative to the file.

| Key | Default | Meaning |
|---|---|---|
| `cloud.base_url` | — | `https://levonis-iq.com` (http is refused except for localhost, or with `allow_insecure_http` in a lab) |
| `cloud.token_env` | `LEVONIS_AGENT_TOKEN` | the environment variable holding the token |
| `cloud.timeout_seconds` | 20 | per request |
| `state_dir` | — | a directory only this agent uses ([State](#state)) |
| `intervals.telemetry_seconds` | 10 | status poll and reading per printer (keep it well under the cloud's `telemetry_stale_seconds`, 120 by default) |
| `intervals.commands_seconds` | 5 | operator commands poll |
| `intervals.printers_seconds` | 30 | bindings and assignments poll |
| `intervals.slicing_seconds` | 15 | slicing claim poll |
| `jobs.start_mode` | `auto` | `auto` uploads and starts an assigned job; `manual` uploads it and waits for someone to start it on the machine |
| `jobs.bed_clear` | `operator` | after a print ends, the next one starts only after `--bed-cleared`; `assume_clear` for machines that clear their own bed (or the simulator). Per printer too |
| `jobs.command_max_age_seconds` | 600 | an older operator command is skipped, never executed late |
| `jobs.start_timeout_seconds` | 300 | the machine must show the job's file running this soon after the start command |
| `jobs.max_start_attempts` | 3 | then the job is left for an operator (`stalled`) |
| `jobs.prints_retention_days` | 14 | print files and closed job records are kept this long |
| `printers.<connection_ref>` | — | one entry per bound printer ([Drivers](#drivers)) |
| `slicer` | none | optional ([Slicer](#slicer)) |
| `log.level` | `info` | `debug`, `info`, `warn`, `error` |

All requests from one workshop share the cloud's agent rate limit (20,000 an
hour per IP address): ten printers at the default intervals use about a
quarter of it.

## How it works

Every tick (one second) the runner does what is due (`lib/runner.mjs`):

**Telemetry.** Per bound printer, the driver's status becomes a reading with
this run's `boot`, the next `seq`, `reported_at` (when the status was taken)
and `sent_at` (when each attempt leaves) — both from the agent's one clock,
so the cloud computes the reading's age without trusting either clock. A
machine the agent cannot reach is reported `offline`; a value the machine did
not report, or one outside the protocol's range, is sent as null, never
filled in. Readings that fail to send wait in a small outbox (30 per printer;
when full, a reading that only repeats its successor's state goes first) and
are sent first, in order, when the network returns — so a fault or a finish
seen during an outage still reaches the cloud. A cloud that keeps answering
`superseded` is logged as `telemetry.boot_counter_behind` ([State](#state)).

**Jobs.** When `GET /printers` shows a cloud job on one of its printers, the
agent prepares it in the background:

1. **The machine first.** If it is already running the job's file (a restart
   after the start command, or a lost state directory), the print is adopted
   and watched — never sent twice.
2. **The print file.** If this agent sliced the job (its claim's input and
   file are kept under `prints/<job>/`), that file is used — but only when the
   job's input, as `GET /jobs/{id}` states it now, still equals what was
   sliced. Otherwise it downloads the job's models through the file door and
   slices them itself. With neither possible, the job is left `stalled` for an
   operator (logged once). So is a job the door **refuses** (a 409 such as
   `INCOMPATIBLE_PRINTER` after the printer model was edited, a 400): it is
   stalled with `stall_reason` `job_door_<code>` and never re-asked every
   tick. A 403 means the token has no `job_control`, and the agent then
   prepares no job at all (`job_control.forbidden`).
3. **The machine must be free.** Idle, or showing an ended print, with its
   bed known to be clear ([Bed clearing](#bed-clearing)), and not running a
   print of its own.
4. **Upload, then start — only a job the cloud still holds in `preparing`.**
   Just before starting, the agent asks again whether the job is still on that
   printer (an operator may have taken it back while the file travelled) and
   whether it has started already: a job the cloud shows `printing` or
   `paused` was started before (by an earlier run whose state was lost, or by
   an operator) and is never started again here — it is left for an operator.
5. **Watch.** The machine's own state drives the job's events, each reported
   once: `started` when its file runs, `paused` / `resumed`, `completed` when
   it finishes, `failed` when it is cancelled, faults (the machine's error
   code is the `reason_code`), or forgets the print (said only after two
   looks). The failure is reported `undetermined`: deciding who is
   responsible stays with an operator (§7.7). The cloud completes only a
   printing job, so `completed` always goes right after a `resumed`. That
   covers a pause the agent never saw end: the job was resumed at the printer
   while the machine or the agent was away, or paused in the console only
   while the machine kept printing. The `resumed` answers `already_applied`
   when the cloud already shows the job printing, and the completion reaches
   the cloud exactly once.

Every event is written into the job's record with its `event_id` **before**
it is sent; a lost answer or a crash re-sends the same event and the cloud
answers `already_applied`. A job printed (or failed) here is never prepared
again, even while the cloud still lists it (awaiting an operator's
verification). If the cloud refuses `started` because the job is no longer
this printer's, the print on the machine belongs to no job and is stopped.

On completion the agent reports `printed_seconds`, which is what the
customer is billed. It is the machine's own count when the machine keeps one
(simulator, OctoPrint, Moonraker). Otherwise (Bambu) it is only the time the
agent **saw** this job's print running. The gap between two looks counts when
both looks belong to the same run of the agent, the earlier one saw this
job's print running after its `started`, and the later one still sees it
running or came within two telemetry intervals. Four things are never
counted: time while the agent was down, time while the machine was
unreachable, the unknown part of a long gap in which the print ended, and
another file printed before this job's (manual start). The watched time is
saved once a minute and at every stop, so a restart loses only its own
downtime. The count therefore errs low, never high, and an operator who
knows better corrects it when verifying. The agent does **not** measure
filament: it omits `materials`, which the cloud takes as «used exactly as
reserved» (`parseConsumption`). With `agent_reports_need_verification` (the
default), an operator verifies or corrects every agent completion.

**Restarts.** Job records and the outbox of events live in the state
directory; a restarted agent picks every unfinished job up where it was —
watching a print still running, re-sending an event still pending. A
`stalled` job is tried again at the next start.

**Operator commands** (`GET /commands`): `pause`, `resume`, `stop`,
`light_on`, `light_off` reach the machine; the job event then follows from
the machine's state. A command naming a job that is not the one running is
skipped; one older than `command_max_age_seconds` is skipped (aged by the
cloud's `Date` header when present). Commands queued before the agent's
very first run are history and are skipped. Every poll reads again the
minute behind the newest command handled. A command is stamped when its
request starts and committed later, so one stamped earlier can commit after
one stamped later. Commands already handled are known by their ids, so none
runs twice. Each command's call to the machine is bounded by the printer's
`timeout_seconds` (plus two seconds). A machine that never answers fails its
command and does not hold the loop for the other printers. `camera_snapshot`
is not supported: the protocol carries camera metadata only.

**Every exchange is bounded, its body included.** Each request to a printer
host, and to the cloud (`cloud.timeout_seconds`), must finish within its
timeout, the response body included. A fetch returns at the response headers,
and a body that then stalls would otherwise hold the call. A model download
must finish within five minutes.

### Bed clearing

The protocol has no «bed cleared» signal, and a print started on top of the
last one damages the machine. So, with `bed_clear: "operator"` (the
default), a print starts only on a bed the agent **knows** is clear: an
operator cleared it and said so on the workshop PC, and nothing has started
on it since.

```bash
sudo -u levonis-agent env $(cat /etc/levonis-agent/env) \
  node /opt/levonis-agent/tools/print-cloud-agent/agent.mjs --config /etc/levonis-agent/agent.config.json --bed-cleared lan-x2d-1
```

**Unknown is occupied.** From the start command on, the bed belongs to that
job, and the next print waits for a clearance however this one ends:
finished, cancelled, faulted, or **vanished**. A print vanishes when the
machine comes back idle after a reboot or a power cut, with half a part on
the plate. The bed also counts as occupied when the agent knows nothing about
it: a new agent, a lost or unreadable `bed.json`. So run `--bed-cleared` once
for each printer before its first job. The one exception is a job's own start
command that did not take (the machine never showed its file running). That
job may be sent again without a new clearance.

**A clearance is used exactly once.** The flag goes first. Run it as the
agent's own user, the owner of the state directory. A flag another user
writes (`sudo … --bed-cleared` as root) could not be removed by the agent, so
the CLI refuses to write one (exit 64). If such a flag is there anyway, the
agent clears nothing and logs `bed.flag_not_removable` once. The clearance is
judged against what the machine shows at that moment. Given while a print
still runs, or while the machine cannot be reached, it is refused and logged
`bed.clear_refused`, because that print will end on the plate. Run it again
once the print has ended and the plate is clear. A taken clearance logs
`bed.cleared`.

The flag is picked up within a second and never takes the agent's lock.
`assume_clear` is for machines that clear their own bed (or the simulator).

## State

`state_dir` holds everything the agent must not forget:

| Entry | What |
|---|---|
| `state.json` | the boot counter (atomic: temp file, fsync, rename, directory fsync) |
| `boots.log` | an append-only journal of every boot taken |
| `agent.lock` | one process per directory (two processes sharing a counter would reorder each other's readings) |
| `jobs/<job>.json` | each job's phase, print file and events (pending, acknowledged, refused) |
| `prints/<job>/` | print files this agent sliced, with the input they were sliced from |
| `commands.json` | the commands cursor and the ids already handled |
| `bed.json` | what the agent knows about each bed |

**The boot counter only goes forward.** The cloud orders an agent's readings
by `(boot, seq)` alone (§9). If the counter went back — a lost file reset to
0, a file restored from an old backup — every reading of the new run would
look older than the one the cloud holds: answered `superseded`, the printer
silent, no work, `boot_regressed` recorded. So the agent **refuses to start**
rather than guess:

| Situation | Refusal | Way forward |
|---|---|---|
| `state.json` is not valid JSON or has no valid `boot` | `STATE_UNREADABLE` | fix or restore it, or `--repair-state` |
| `state.json` missing in a directory the agent has used | `STATE_MISSING` | restore it, `--repair-state` (from `boots.log`), or `--init` |
| `state.json` older than `boots.log` (a restored copy) | `STATE_STALE` | `--repair-state` |
| another live process holds `agent.lock` | `STATE_LOCKED` | stop the other process |

`--repair-state` continues from the highest counter that survives
(`boots.log` or the file). `--init` does the same, and starts a new counter
at 0 when nothing survives — then re-bind the printers to a fresh agent token
(a new agent's readings replace the old agent's regardless of numbers). Back
up the state directory as a whole, never `state.json` alone.

## Drivers

Every driver implements one interface (`drivers/common.mjs`): `status()`
(state, file, progress, layers, remaining and elapsed time, temperatures,
errors, AMS trays, camera — null for anything the machine did not report),
`upload()`, `start()`, `pause()`, `resume()`, `cancel()`, optionally
`light()`. Print files are named `lv_<job id>.<ext>`, which is how the agent
recognises its own print on a machine.

**`simulator`** — a deterministic fake printer, for tests and for a dry run
against the real cloud: bind a test printer to a simulator entry. A print
lasts what its file states (the slicer's estimate in it), else
`print_seconds`; `time_scale` speeds it up. It is never presented as a real
machine: the cloud only sees it through the printer an operator bound to it.

**`octoprint`** — OctoPrint's REST API with an application key (`X-Api-Key`):
`POST /api/files/local` (multipart, `select=true`), select and
`POST /api/job {"command":"start"}`, pause/resume/cancel through `/api/job`,
status from `GET /api/job` and `GET /api/printer` (409 — printer not
connected — reads `offline`). OctoPrint reports no layers; the remaining time
is OctoPrint's own `printTimeLeft`. After a print the job keeps its file: 100 %
reads `finished`, a stopped print `cancelled`.

**`moonraker`** — Klipper's Moonraker: `POST /server/files/upload`
(multipart, `root=gcodes`), `POST /printer/print/start?filename=…`,
`/printer/print/pause|resume|cancel`, status from
`GET /printer/objects/query?print_stats&virtual_sdcard&heater_bed&extruder`.
Layers come from `print_stats.info` (only if the slicer's start G-code calls
`SET_PRINT_STATS_INFO`); the remaining time is the file's own slicer
estimate (`/server/files/metadata`) less the print time so far — unknown
when the file carries none, never extrapolated. `api_key` is optional
(Moonraker trusts LAN clients when configured to).

**`bambu`** — Bambu Lab printers in LAN mode:

* MQTT over TLS on port 8883 (`lib/mqtt.mjs`, MQTT 3.1.1), user `bblp`, the
  printer's **LAN access code** as password; reports on
  `device/<serial>/report` (merged — after the first full `pushall` report
  they are incremental), commands on `device/<serial>/request`:
  `project_file` for a `.gcode.3mf` (with `ams_mapping`), `gcode_file` for a
  plain `.gcode`, `pause`, `resume`, `stop`, and `ledctrl` for the chamber
  light;
* the print file goes first to the printer's storage over implicit FTPS on
  port 990 (`lib/ftps.mjs`: USER/PASS/PBSZ 0/PROT P/TYPE I/PASV/STOR, the
  data channel resuming the control channel's TLS session);
* `gcode_state` IDLE → idle, PREPARE/SLICING → preparing, RUNNING → printing,
  PAUSE → paused, FINISH → finished, FAILED → error (cancelled when
  `print_error` is the «cancelled» code); HMS entries become
  `HMS_AAAA_AAAA_CCCC_CCCC` error codes; a chamber temperature is reported
  only with `chamber_sensor: true`;
* AMS: each of the job's materials must be loaded — a tray of the same
  material whose colour is within `color_tolerance` (RGB distance, default
  48) of the catalogue colour — or the print is **not** started and the job
  waits (`material not loaded`). A plain `.gcode` addresses trays by number,
  so filament *i* must already sit in tray *i*; that is checked too.
  `use_ams: false` for a printer printing from an external spool.

  **TLS trust is an explicit choice** (`tls.mode`, required — there is no
  default). The printer's certificate is self-signed:

  * `pin` (recommended): `fingerprint256` is the SHA-256 fingerprint of that
    printer's certificate. Read it once from the machine you trust and pin it:
    `node tools/print-cloud-agent/agent.mjs --print-fingerprint 192.168.1.50:8883`.
    The handshake runs without CA verification, then the certificate must
    match the pin before a single byte — the access code included — is sent.
  * `ca`: `ca_file` (a CA you trust for these printers) and the name the
    certificate must carry (`servername`, default the printer's serial).
  * `insecure`: no verification at all; allowed only when written, and every
    connection logs `tls.insecure`.

  Bambu Lab's firmware has been changing what third-party LAN control it
  allows; recent firmware may require «LAN only» mode with developer access
  enabled. Check the printer's firmware notes. **None of this has been run
  against a Bambu printer** — only against a fake broker and FTP server.

## Slicer

The cloud never slices (§7.2). With `slicer` configured and the token's
`slicer` capability, the agent claims slicing requests (a ten-minute lease),
downloads the models, runs the workshop's slicer CLI with the workshop's own
profiles and posts the figures the slicer **wrote** — or a failure with a
reason. It never posts a number the slicer did not state.

```jsonc
"slicer": {
  "kind": "orca",                       // orca | bambu-studio | prusa
  "cli_path": "/opt/orca-slicer/orca-slicer",
  "profiles_dir": "./profiles",
  "timeout_seconds": 480,               // at most 540: the lease is 600
  "output": "gcode.3mf",                // or "gcode" (PrusaSlicer: "gcode")
  "machines": { "BBL-X2D-COMBO": [{ "nozzle_um": 400, "machine": "machine/….json", "process": "process/….json", "pause_gcode": "M400 U1" }] },
  "filaments": { "by_sku": { "PLA-BASIC-COLDWHITE": "filament/….json" }, "by_material": { "PLA": "filament/….json" } }
}
```

* **Machines** are keyed by the cloud's printer-model `code` and the job's
  nozzle. **Filaments** by variant SKU, else by material. A job with no
  matching profile fails `PROFILE_NOT_CONFIGURED`.
* **Profiles must be complete exports** (OrcaSlicer / Bambu Studio JSON with
  no `inherits` chain the CLI cannot resolve; PrusaSlicer `.ini`).
* **The job's settings** become overrides: for Orca/Bambu Studio a copy of
  the process profile with `layer_height`, `sparse_infill_density`,
  `wall_loops`, `enable_support`/`support_type` and `brim_type` replaced; for
  PrusaSlicer the `--layer-height`, `--fill-density`, `--perimeters`,
  `--support-material…` and `--brim-width` options.
* **Command lines.** Orca / Bambu Studio:
  `--slice 0 --arrange 1 --orient 0|1 --load-settings "<machine>;<process>" --load-filaments "<f1>;<f2>" --load-filament-ids "1,2,…" --outputdir <dir> [--export-3mf lv_<job>.gcode.3mf] <models…>`.
  PrusaSlicer: `--export-gcode --load <printer.ini> --load <print.ini> --load <filament.ini> … --output <file> <models…>`.
  No shell is involved. A headless Linux PC may need the slicer run under a
  virtual display (point `cli_path` at a wrapper script) — not tested.
* **The figures** are read from the produced file (`slicers/gcode.mjs`):
  print time («total estimated time», else the normal-mode estimate, else the
  3MF's `prediction`), grams per filament (`filament used [g]`, else the 3MF's
  `used_g`, rounded **up** to whole grams), layers (declared, else the layer
  markers counted; omitted — the protocol allows it — when neither exists),
  colour changes (tool changes counted). A missing time or weight is a
  failure; **0 g reported for a non-zero length** means the filament profile
  has no density, and is a failure too (`ESTIMATE_INCOMPLETE`), never a zero.
  These slicers state total grams per filament, not split into model /
  support / purge: the agent sends model grams only and adds a warning saying
  so.
* **Pauses** (`pause_at_layers`, e.g. magnet insertion) are inserted as the
  machine's `pause_gcode` at those layer changes — plain G-code output only.
* **Transient trouble** (a download that fails on the network) is not
  reported: the lease lapses and the cloud gives the request to the next
  claim. Everything else is reported as a failure, which sends the job back
  to the customer with «estimate unavailable».

Failure codes the agent sends: `PLATE_LAYOUT_UNSUPPORTED`,
`MULTI_PART_ASSIGNMENT_UNSUPPORTED`, `MULTI_MATERIAL_UNSUPPORTED` (PrusaSlicer),
`AUTO_ORIENTATION_UNSUPPORTED` (PrusaSlicer), `PROFILE_NOT_CONFIGURED`,
`PROFILE_NOT_FOUND`, `PROFILE_UNREADABLE`, `PAUSE_AT_LAYER_UNSUPPORTED`,
`PAUSE_LAYER_OUT_OF_RANGE`, `TOO_MANY_OBJECTS`, `UNSUPPORTED_MODEL_FORMAT`,
`MODEL_FILE_MISSING`, `INPUT_INVALID`, `SLICER_TIMEOUT`, `SLICER_FAILED`,
`SLICER_OUTPUT_MISSING`, `SLICER_OUTPUT_UNREADABLE`,
`OBJECTS_DO_NOT_FIT_ONE_PLATE`, `ESTIMATE_INCOMPLETE`, `ESTIMATE_OUT_OF_RANGE`,
`FILAMENT_MAPPING_MISMATCH`, `ESTIMATE_REJECTED`.

The agent keeps the file it sliced: when the job is later assigned to one of
its printers, that very file — the one whose figures the customer confirmed
— is the one printed.

## Security

* **Token scope.** Mint a token with only the capabilities that machine needs;
  it is bound to the printers an admin binds to it and nothing else. It is
  read from the environment only, sent only to `cloud.base_url` (https), and
  a file path the cloud hands back is followed only inside the agent API.
* **Printer credentials stay on the LAN.** Access codes and API keys live in
  the agent's environment (or its 0600 configuration file); the cloud knows a
  printer only by its `connection_ref`, and no request carries anything else.
  The access code is written only to the printer's own MQTT/FTPS connection,
  after the TLS check.
* **Logs** never carry a secret: fields named like credentials are replaced,
  and every configured secret is cut out of any line that contains it.
* **Customer models are untrusted input** to the slicer. Run the agent as an
  unprivileged user with the state directory (mode 0700) as its only
  writable place.
* **TLS to the printers** is verified as configured (pin, CA) or explicitly
  and loudly not (`insecure`) — never silently.

## Logs and exit codes

One JSON object per line on stdout: `ts`, `level`, `msg`, fields. Useful
`msg` values: `agent.started`, `telemetry.deferred`,
`telemetry.boot_counter_behind`, `printer.unreachable`,
`printer.not_configured`, `job.assigned`, `job.waiting`, `job.uploaded`,
`job.start_sent`, `job.event_sent`, `job.event_refused`,
`job.print_file_unavailable`, `job.print_cancelled_not_assigned`,
`command.handled`, `slicing.claimed`, `slicing.result_posted`,
`slicing.failed`, `tls.insecure`, `cloud.token_rejected`.

| Exit code | Meaning |
|---|---|
| 0 | stopped cleanly |
| 1 | unexpected failure (see the last log line) |
| 64 | bad command-line arguments |
| 77 | the cloud refused the token (revoked or wrong) |
| 78 | configuration or state refused |

## Limits of v1

Refused with a code (the customer is told) rather than done differently:
fixed plate layouts, one model with parts in different materials, pauses
inside a `.gcode.3mf`, and — with PrusaSlicer — more than one filament or
automatic orientation. All objects of a job (models × quantity × copies) go on
one plate.

Not done at all: measuring filament actually used; camera snapshots or
streams (metadata only); one print per printer at a time; the Bambu driver
reads no elapsed print time (the agent's own watch is used).

The protocol has no «bed cleared» signal (hence `--bed-cleared` on the
workshop PC). The agent added one read-only door to the protocol,
`GET /api/print-cloud/v1/agent/jobs/{id}` (§9): without it an agent that had
not sliced a job itself — an operator's estimate, a workshop reprint — could
not learn what to print.

## Tested / not tested

Tests: `tests/printCloudAgentProgram.test.ts` and, for the job door,
`tests/printCloudAgentJobDoor.test.ts`
(`node --import tsx --test tests/printCloudAgent*.test.ts`). The cloud side is
the real Print Cloud app in process, on real persisted records.

| Part | Exercised against | Real hardware / binary |
|---|---|---|
| Cloud client (every agent door, retries, idempotent re-sends) | the real Print Cloud API in process | n/a — the live cloud not yet |
| Boot counter, sequence, lock, refusals | real files in a temporary directory | n/a |
| Telemetry order, outbox flush, restart, superseded late reading | the real API | — |
| Whole job: claim → slice → estimate → queue → upload → start → pause/resume commands → complete | the real API + simulator + fake slicer CLI | **not tested** |
| Operator estimate → job door → slice → print; bed clearing; restart mid-print and with a pending completion; lost state (a started job never started again, a running one adopted); machine fault; orphan print stopped | the real API + simulator + fake slicer CLI | **not tested** |
| Operator commands (pause, resume, stop, light; stale and foreign skipped) | the real API + simulator | **not tested** |
| Simulator driver | itself | n/a |
| OctoPrint driver | an in-process HTTP fake | **not tested** on OctoPrint |
| Moonraker driver | an in-process HTTP fake | **not tested** on Moonraker/Klipper |
| Bambu driver (MQTT report/commands, AMS mapping, FTPS upload) | a fake MQTT broker and FTP server over plain sockets | **not tested** on any Bambu Lab printer; TLS pinning not exercised against a printer certificate |
| MQTT 3.1.1 codec | the specification's byte tables, round trips | — |
| FTPS command sequence | a fake FTP server (TLS replaced by plain sockets) | **not tested** against a Bambu FTPS server |
| OrcaSlicer / Bambu Studio / PrusaSlicer command lines | argument assertions and a fake CLI | **not tested** with any real slicer binary |
| Slicer figure parsing | synthetic G-code and `.gcode.3mf` written from the documented comment formats | **not tested** on real slicer output |
| Configuration, logs (no secret), CLI | unit tests | — |

Before the service relies on it: run `--check` on the workshop PC; bind one
printer of each kind and run a real print end to end through the cloud; slice
a real job with the real slicer and compare the posted figures with the
slicer's own preview; pin each Bambu printer's certificate.
