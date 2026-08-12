# MySQL 8.0.45 → 8.4 LTS upgrade runbook — `fcgg-crm-db`

Purpose: stop the `USE2-ExtendedSupport:Yr1-Yr2:MySQL8.0` charge (~$53/mo).

## STATUS: EXECUTED AND VERIFIED — 2026-08-12

Upgrade ran in place, mid-day. RDS event trail:

| UTC | Event |
|-----|-------|
| 18:12:32 | manual snapshot `pre-84-upgrade-20260812` started (available 18:13:34) |
| 18:36:52 → 18:37:13 | pre-upgrade check started → finished (passed; `rds_superuser_role` was **not** a blocker) |
| 18:37:29 | DB instance shutdown |
| 18:38:02 | **downtime started** |
| 18:38:38 → 18:39:40 | engine upgrade started → finished |
| 18:39:33 | DB instance restarted |
| 18:39:54 | major version upgrade complete: 8.0.45 → 8.4.10, `default.mysql8.0` → `default.mysql8.4` |

**Total downtime ≈ 100 seconds** — far under the 10–20 min estimate, because the
dataset is only 1.5 MB. No error events.

Post-upgrade state: `available`, 8.4.10, `default.mysql8.4` **in-sync** (not
pending-reboot), backup retention **7 days**, deletion protection **on**, no
pending modifications. `sql_mode` still `NO_ENGINE_SUBSTITUTION` — no
`ONLY_FULL_GROUP_BY` surprise. All 31 tables `CHECK TABLE` → OK. `Admin@%` still
on `caching_sha2_password`; the app pool reconnected with zero DB errors.
INSERT + DELETE verified through the API with a self-cleaning note test.

Rollback snapshot `pre-84-upgrade-20260812` (8.0.45, manual) — **keep until
2026-08-26**. RDS also took its own `rds:preupgrade-...` automated snapshot.

Unrelated pre-existing bug found during verification (NOT upgrade fallout):
`/reports/work-orders` 500s on `Unknown column 'wo.createdAt'` — the column is
`created_at`. Broken since 2026-02-12.

The original plan and gate evidence follow.

---

## Already done (no action needed)

| Gate | Result |
|------|--------|
| Driver | `mysql2` 3.16.3 via `mysql2/promise`; legacy `mysql` package absent. Supports `caching_sha2_password`. |
| Auth plugin | **CHANGED**: `Admin@%` moved `mysql_native_password` → `caching_sha2_password`, same password (no config change). Verified with a cold connection + full container restart + all DB endpoints 200. |
| Parameter group | Instance uses **default** `default.mysql8.0` (not custom). `default.mysql8.4` exists with **identical** `sql_mode = NO_ENGINE_SUBSTITUTION`. Nothing to create. |
| sql_mode / GROUP BY | `ONLY_FULL_GROUP_BY` is **not** enabled today and **will not** be after the upgrade. Separately dry-ran all 10 GROUP BY-heavy app queries under full-strict mode: 10/10 pass. Double-safe. |
| Schema | 31 tables, all InnoDB, all utf8mb4/utf8mb4_0900_ai_ci, all have PRIMARY KEYs. 1.5 MB total. |

---

## Step 3 — Snapshot (run first, admin creds)

```bash
SNAP="pre-84-upgrade-$(date +%Y%m%d)"
aws rds create-db-snapshot \
  --db-instance-identifier fcgg-crm-db \
  --db-snapshot-identifier "$SNAP" \
  --region us-east-2

aws rds wait db-snapshot-available \
  --db-snapshot-identifier "$SNAP" --region us-east-2

aws rds describe-db-snapshots --db-snapshot-identifier "$SNAP" \
  --region us-east-2 --query "DBSnapshots[].{id:DBSnapshotIdentifier,status:Status,engine:EngineVersion}" --output table
```

**Gate: do not continue until `status = available`.**

Automated backups exist but retention is only **1 day** — a manual snapshot is
the real safety net here because it persists until deleted.

## Step 4 — Upgrade (evening only)

```bash
aws rds modify-db-instance \
  --db-instance-identifier fcgg-crm-db \
  --engine-version 8.4.10 \
  --db-parameter-group-name default.mysql8.4 \
  --allow-major-version-upgrade \
  --apply-immediately \
  --region us-east-2

aws rds wait db-instance-available --db-instance-identifier fcgg-crm-db --region us-east-2

aws rds describe-db-instances --db-instance-identifier fcgg-crm-db --region us-east-2 \
  --query "DBInstances[].{version:EngineVersion,status:DBInstanceStatus,pg:DBParameterGroups[0].DBParameterGroupName}" --output table
```

`--apply-immediately` = outage for the duration. The DB holds 1.5 MB, so time is
dominated by the engine/OS swap, not data — expect ~10–20 min on db.t3.small,
single-AZ (no Multi-AZ failover to soften it).

Watch the pre-upgrade check output. The one residual item: `rds_superuser_role@%`
is still on `mysql_native_password`. It is an RDS-managed **role**, not a login
(`account_locked = Y`, empty authentication_string), so it cannot authenticate
and AWS normally handles it. Left untouched deliberately — altering an
RDS-managed role is riskier than the thing it would prevent. If and only if the
pre-check rejects the upgrade because of it:

```sql
ALTER USER 'rds_superuser_role'@'%' IDENTIFIED WITH caching_sha2_password;
```

## Step 5 — Verify

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://FCGG.us-east-2.elasticbeanstalk.com/health
```

Then, signed in to the CRM: work orders list, invoices, customers, purchase
orders, reports/P&L. Add a note to a WO and change its status (write paths),
then delete the test note. Load the field-tech app (same DB, should be
transparent). Finally:

```bash
cd crm-backend && eb logs 2>&1 | grep -E 'ER_[A-Z]|Access denied|PROTOCOL_|Handshake' | tail -20
```

Note: grep for `ER_[A-Z]`, not `ER_` — a bare `ER_` case-insensitively matches
`work_ord**er_**pos` and floods with false positives.

## Rollback

A major version upgrade is **not** reversible in place. Rollback = restore the
Step 3 snapshot to a **new** instance, then repoint `DB_HOST` in the EB
environment. Keep the snapshot **2 weeks** before deleting.

## Aftercare

- Cost Explorer: confirm `USE2-ExtendedSupport:Yr1-Yr2:MySQL8.0` flatlines a day
  or two after the upgrade completes.
- Unrelated pending item: RDS reports "New Operating System update is available"
  for this instance.
- Worth considering separately: backup retention is 1 day, and deletion
  protection is off.
