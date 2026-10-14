# Brainbot Bot (BB)

BB is an internal manager service principal. It has no email, password, Auth account, login session or colony membership. Its settings, findings, review notes and run logs are private to the database owner. Existing human accounts and permissions are unchanged.

The current checks cover current cage positions, room/rack references, overlapping cage assignments, living mice without confirmed cage assignments or assigned to missing or inactive cages, Animal Sheet imports older than 36 hours, and queued/running import jobs older than 15 minutes. BB reports these conditions; it does not retry a stalled import or infer animal identity, genotype, experimental use or scientific data.

The only automatic correction fills a cage's blank `room_id` or `rack_id` from its already explicit `location_id`. The position, rack and room must exist and be active, the hierarchy must agree, and exactly one current cage may occupy that position. Existing conflicting values, cage tags, mouse records and source fields remain unchanged. Report-only mode disables even this correction. Manager capabilities are upper bounds: housing controls cage checks and this correction, mice controls mouse/cage checks, and imports controls source freshness checks. Other capability flags reserve future operations and do not execute unimplemented actions.

Every run records the service principal, requested-by user (if manual), settings version, timestamps, outcome, findings and exact before/after versions and payloads for corrections. A failed correction rolls back the run's changes and reports an error code. Scheduled changes have a NULL human audit actor and NULL `updated_by`; no human identity is fabricated. Manual runs retain the actual owner's audit actor. The regular shared record audit remains intact.

The owner can acknowledge or resolve a finding with a note. A later check reopens it if it remains. Checks disabled by a capability cannot falsely resolve their old findings. Historical run and review records remain available; reclassifying an issue never changes the source record.

## Deployment

1. Apply `supabase/brainbot.sql` after `manager-permissions.sql` and `cage-position-guard.sql`. It installs tables/functions only. It creates no service configuration, human account or scheduled job.
2. Activate the authorized colony separately. Create its private settings row, enable the service and call `colony_private.brainbot_schedule(colony_id)` as the database administrator. Keep real colony identifiers and the activation receipt outside the public repository.
3. Confirm a completed first run and an active cron entry. The default `03:00` Asia/Taipei schedule is `0 19 * * *` in UTC. Owner changes to the daily time replace only that colony's BB job; disabling it unschedules that job. Existing Animal Sheet jobs are untouched.

The UI is honest about a missing cron extension: enabled settings without an installed job show an inactive schedule. The private activation package fails and rolls back if scheduling or the first verification fails. No browser or AI agent is required for the deterministic server checks. A separate Codex follow-up, if configured, is an independent review workflow rather than a claim that this SQL service performs general scientific reasoning.

Public owner-only RPCs are `get_brainbot_status`, `save_brainbot_settings`, `run_brainbot`, and `review_brainbot_issue`. Private helper functions and tables deny anonymous and authenticated direct access. The frontend stores no BB logs in colony backups or IndexedDB. A completed run with corrections invalidates the old edit baseline so the caller must pull current data before further edits.
