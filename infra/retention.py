#!/usr/bin/env python3
"""Bounded Control retention: report is read-only, apply deletes rows then files.

Database access uses psql, so the
job needs only Python and the PostgreSQL client. Every run prints exactly one JSON object and
never puts an exception message (which could carry a DSN password) into it.
"""

import argparse
import base64
import datetime as dt
import fcntl
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
NODE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
ENV_KEY = re.compile(r"[A-Z][A-Z0-9_]*")

DEFAULT_ROOT = os.path.abspath("./data/recording-backups")
DEFAULT_ENV_FILE = "./control.env"
LOCK_NAME = ".recording-backup.lock"

MAX_CALLS = 500
MAX_ROWS = 50000
CALLS_CEILING = 5000
ROWS_CEILING = 500000
# An orphan younger than this may still be an in-flight capture that has not written
# its manifest yet, so only aged directories are reclaimed.
ORPHAN_MIN_AGE_SECONDS = 3600
ORPHAN_CHUNK = 500
REMOTE_TIMEOUT_SECONDS = 15
# S39 §4: Control tries the remote delete once; this job carries the retries.
REMOTE_RETRY_LIMIT = 100
REMOTE_RETRY_MAX_ATTEMPTS = 10
REMOTE_RETRY_WINDOW_DAYS = 30
MAX_RUNTIME_SECONDS = 900
PSQL_TIMEOUT_SECONDS = 120

# Thresholds; every one is overridable from the env file (S29 §2.3).
THRESHOLDS = {
    "RETENTION_SNAPSHOT_EVENT_DAYS": 7,
    "RETENTION_EVENT_DAYS": 90,
    "RETENTION_IDEMPOTENCY_DAYS": 7,
    "RETENTION_COMMAND_DAYS": 30,
    "RETENTION_DIAG_EVENTS_DAYS": 10,
}

SNAPSHOT_EVENT_TYPE = "telecom.snapshot"

# Archive states that mean the Pixel is still uploading into PIXEL_ARCHIVE_ROOT/<id>/.
PIXEL_ARCHIVE_BUSY = ("uploading", "verifying")
# Non-terminal ai_call_runs states, copied from schema.sql's ai_call_runs_due_idx.
AI_RUN_BUSY = ("pending", "preparing", "answer_committed", "awaiting_active", "active",
               "ending", "reconcile_unknown")


def sql_string_list(values):
    return ",".join("'" + value + "'" for value in values)


# Per-call guards from S29 §2.3. `c` is the call_records alias in every statement.
CALL_GUARDS = (
    "c.state IN ('ended','failed')",
    "COALESCE(c.ended_at,c.started_at) < now() - interval '1 hour'",
    "NOT EXISTS (SELECT 1 FROM gateway_call_locks l WHERE l.call_id=c.id)",
    "NOT EXISTS (SELECT 1 FROM commands m WHERE m.call_id=c.id AND m.status='pending')",
    "NOT EXISTS (SELECT 1 FROM media_close_jobs j WHERE j.call_id=c.id AND j.completed_at IS NULL)",
    # A Pixel archive still being uploaded owns files under PIXEL_ARCHIVE_ROOT/<id>/.
    f"NOT EXISTS (SELECT 1 FROM pixel_recording_archives p WHERE p.call_id=c.id "
    f"AND p.state IN ({sql_string_list(PIXEL_ARCHIVE_BUSY)}))",
    # An AI run that has not settled can still write transcripts and issue commands.
    f"NOT EXISTS (SELECT 1 FROM ai_call_runs a WHERE a.call_id=c.id "
    f"AND a.state IN ({sql_string_list(AI_RUN_BUSY)}))",
)


class RetentionError(Exception):
    def __init__(self, failure_type, code):
        super().__init__(code)
        self.failure_type = failure_type
        self.code = code


def fail(failure_type, code):
    raise RetentionError(failure_type, code)


# --------------------------------------------------------------------------- env


def load_env(path):
    """KEY=value, optional quoting, no expansion."""
    values = {}
    try:
        with open(path, "r", encoding="utf-8") as source:
            lines = source.readlines()
    except OSError:
        fail("config", "env_unreadable")
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            fail("config", "env_invalid")
        key, value = line.split("=", 1)
        if not ENV_KEY.fullmatch(key):
            fail("config", "env_invalid")
        if len(value) >= 2 and value[0] == value[-1] == "'":
            value = value[1:-1]
        elif value.startswith('"'):
            try:
                value = json.loads(value)
            except (ValueError, TypeError):
                fail("config", "env_invalid")
            if not isinstance(value, str):
                fail("config", "env_invalid")
        values[key] = value
    return values


def threshold(values, name):
    raw = values.get(name, os.environ.get(name))
    if raw is None or raw == "":
        return THRESHOLDS[name]
    if not re.fullmatch(r"[0-9]{1,5}", str(raw)):
        fail("config", "threshold_invalid")
    days = int(raw)
    if days < 1:
        fail("config", "threshold_invalid")
    return days


def optional_days(values, name):
    raw = values.get(name, os.environ.get(name))
    if raw is None or raw == "":
        return None
    if not re.fullmatch(r"[0-9]{1,5}", str(raw)):
        fail("config", "threshold_invalid")
    days = int(raw)
    return days if days >= 1 else fail("config", "threshold_invalid")


# ----------------------------------------------------------------------- cutoffs


def now_utc():
    return dt.datetime.now(dt.timezone.utc)


def parse_iso(raw):
    try:
        parsed = dt.datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        fail("config", "cutoff_invalid")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def cutoff_value(days, before, reference=None):
    """Resolve one retention cutoff. Returns an aware UTC datetime or None."""
    if days is not None and before is not None:
        fail("config", "cutoff_conflict")
    if days is not None:
        if not isinstance(days, int) or isinstance(days, bool) or days < 1:
            fail("config", "cutoff_invalid")
        return (reference or now_utc()) - dt.timedelta(days=days)
    if before is not None:
        return parse_iso(before)
    return None


def sql_timestamp(value):
    return value.astimezone(dt.timezone.utc).isoformat()


# ---------------------------------------------------------------------- database


def database_environment(raw, read_only, statement_timeout_ms=30000, lock_timeout_ms=5000):
    try:
        parsed = urllib.parse.urlsplit(raw)
    except ValueError:
        fail("config", "database_config_invalid")
    if parsed.scheme not in ("postgres", "postgresql") or not parsed.path or parsed.path == "/":
        fail("config", "database_config_invalid")
    try:
        query = urllib.parse.parse_qs(parsed.query, strict_parsing=True) if parsed.query else {}
    except ValueError:
        fail("config", "database_config_invalid")
    if set(query) - {"sslmode"} or any(len(value) != 1 for value in query.values()):
        fail("config", "database_config_invalid")
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    env.pop("DATABASE_URL", None)
    env["PGDATABASE"] = urllib.parse.unquote(parsed.path[1:])
    if parsed.hostname:
        env["PGHOST"] = parsed.hostname
    try:
        port = parsed.port
    except ValueError:
        fail("config", "database_config_invalid")
    if port:
        env["PGPORT"] = str(port)
    if parsed.username:
        env["PGUSER"] = urllib.parse.unquote(parsed.username)
    if parsed.password:
        env["PGPASSWORD"] = urllib.parse.unquote(parsed.password)
    if "sslmode" in query:
        env["PGSSLMODE"] = query["sslmode"][0]
    env["PGCONNECT_TIMEOUT"] = "15"
    options = [f"-c statement_timeout={statement_timeout_ms}", f"-c lock_timeout={lock_timeout_ms}",
               "-c idle_in_transaction_session_timeout=60000"]
    if read_only:
        # A nightly job that believes it is reporting must be unable to write.
        options.insert(0, "-c default_transaction_read_only=on")
    env["PGOPTIONS"] = " ".join(options)
    return env


class Database:
    """psql subprocess access."""

    def __init__(self, database_url, read_only, psql="psql"):
        self.env = database_environment(database_url, read_only)
        self.psql = psql
        self.read_only = read_only

    def run(self, sql, variables=(), timeout=PSQL_TIMEOUT_SECONDS):
        command = [self.psql, "--no-password", "--no-psqlrc", "--tuples-only", "--no-align",
                   "--set", "ON_ERROR_STOP=1"]
        for key, value in variables:
            if not re.fullmatch(r"[a-z_]+", key):
                fail("database", "query_variable_invalid")
            command.extend(("--set", f"{key}={value}"))
        try:
            result = subprocess.run(command, env=self.env, input=sql, stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, text=True, timeout=timeout, check=True)
        except subprocess.CalledProcessError:
            fail("database", "statement_failed")
        except (OSError, subprocess.SubprocessError):
            fail("database", "database_unavailable")
        return [line for line in result.stdout.splitlines() if line and line not in ("BEGIN", "COMMIT", "ROLLBACK")]

    def read(self, sql, variables=()):
        return self.run("BEGIN READ ONLY;\n" + sql + ";\nCOMMIT;\n", variables)

    def count(self, sql, variables=()):
        lines = self.read(sql, variables)
        if len(lines) != 1 or not re.fullmatch(r"[0-9]+", lines[-1].strip()):
            fail("database", "count_invalid")
        return int(lines[-1].strip())

    def write_count(self, sql, variables=()):
        if self.read_only:
            fail("database", "write_in_report_mode")
        lines = self.run(sql, variables)
        if not lines or not re.fullmatch(r"[0-9]+", lines[-1].strip()):
            fail("database", "count_invalid")
        return int(lines[-1].strip())


def bounded_count_sql(body, limit):
    return f"SELECT count(*)::text FROM (SELECT 1 {body} LIMIT {int(limit)}) t"


def bounded_delete_sql(table, body, limit):
    return (f"WITH d AS (DELETE FROM {table} WHERE ctid IN (SELECT ctid {body} LIMIT {int(limit)}) RETURNING 1) "
            "SELECT count(*)::text FROM d")


# ------------------------------------------------------------------- filesystem


def is_uuid_dir(root, name):
    if not UUID.fullmatch(name):
        return False
    path = os.path.join(root, name)
    try:
        info = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISDIR(info.st_mode)


def uuid_directories(root):
    """Names of uuid-shaped real directories directly under `root`. Dotfiles never match."""
    if not root:
        return []
    try:
        names = sorted(os.listdir(root))
    except FileNotFoundError:
        return []
    except OSError:
        fail("filesystem", "directory_unreadable")
    return [name for name in names if is_uuid_dir(root, name)]


def node_directories(root):
    try:
        names = sorted(os.listdir(root))
    except FileNotFoundError:
        return []
    except OSError:
        fail("filesystem", "directory_unreadable")
    result = []
    for name in names:
        if not NODE.fullmatch(name):
            continue
        path = os.path.join(root, name)
        try:
            info = os.lstat(path)
        except OSError:
            continue
        if stat.S_ISDIR(info.st_mode):
            result.append(name)
    return result


def directory_usage(path):
    """Bytes held by regular files below `path`; symlinks are counted as zero, never followed."""
    total = 0
    for base, directories, files in os.walk(path, followlinks=False):
        directories[:] = [name for name in directories if not os.path.islink(os.path.join(base, name))]
        for name in files:
            try:
                info = os.lstat(os.path.join(base, name))
            except OSError:
                continue
            if stat.S_ISREG(info.st_mode):
                total += info.st_size
    return total


def contains_manifest(path):
    for base, _directories, files in os.walk(path, followlinks=False):
        if "manifest.json" in files:
            return True
    return False


def directory_age_seconds(path, reference):
    try:
        return reference - os.lstat(path).st_mtime
    except OSError:
        return 0.0


def orphan_is_reclaimable(path, reference, min_age=ORPHAN_MIN_AGE_SECONDS):
    """S29 §2.3: a finalized capture (manifest anywhere inside) or an aged directory."""
    return contains_manifest(path) or directory_age_seconds(path, reference) > min_age


def remove_directory(path, dry_run):
    """The only deletion primitive; `dry_run` measures and returns without touching disk."""
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return 0, 0
    except OSError:
        fail("filesystem", "path_unreadable")
    if not stat.S_ISDIR(info.st_mode):
        fail("filesystem", "path_not_directory")
    used = directory_usage(path)
    if dry_run:
        return used, 1
    try:
        shutil.rmtree(path)
    except OSError:
        fail("filesystem", "remove_failed")
    return used, 1


class FileTally:
    def __init__(self):
        self.bytes = 0
        self.dirs = 0

    def add(self, used, dirs):
        self.bytes += used
        self.dirs += dirs

    def document(self):
        return {"bytes": self.bytes, "dirs": self.dirs}


class JobLock:
    """The recording-backup ledger lock, so replication never races a ledger deletion."""

    def __init__(self, root):
        self.root = root
        self.root_fd = None
        self.fd = None

    def __enter__(self):
        if not os.path.isabs(self.root):
            fail("config", "root_invalid")
        try:
            os.makedirs(self.root, mode=0o700, exist_ok=True)
            self.root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        except OSError:
            fail("filesystem", "root_unavailable")
        try:
            self.fd = os.open(LOCK_NAME, os.O_RDWR | os.O_CREAT | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC,
                              0o600, dir_fd=self.root_fd)
        except OSError:
            os.close(self.root_fd)
            self.root_fd = None
            fail("filesystem", "job_lock_unavailable")
        lock_stat = os.fstat(self.fd)
        if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_mode & 0o077:
            fail("filesystem", "job_lock_invalid")
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail("lock", "job_already_running")
        return self

    def __exit__(self, *_):
        if self.fd is not None:
            os.close(self.fd)
        if self.root_fd is not None:
            os.close(self.root_fd)


# ----------------------------------------------------------------- remote delete


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def recording_delete_canonical(path, timestamp, nonce):
    """Matches services/media authorizeRecordingRequest: method, path, ts, nonce, Range(empty)."""
    return f"DELETE\n{path}\n{timestamp}\n{nonce}\n"


def recording_delete_headers(secret, path, timestamp=None, nonce=None):
    timestamp = str(int(time.time())) if timestamp is None else str(timestamp)
    nonce = secrets.token_urlsafe(18) if nonce is None else nonce
    canonical = recording_delete_canonical(path, timestamp, nonce)
    digest = hmac.new(secret.encode() if isinstance(secret, str) else secret, canonical.encode(), hashlib.sha256).digest()
    signature = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return {"X-CC-Timestamp": timestamp, "X-CC-Nonce": nonce, "X-CC-Signature": signature}


class RemoteNode:
    def __init__(self, node_id, base_url, secret, opener=None):
        parsed = urllib.parse.urlsplit(base_url or "")
        if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password \
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
            fail("config", "media_node_invalid")
        if not isinstance(secret, str) or len(secret) < 32 or not NODE.fullmatch(node_id or ""):
            fail("config", "media_node_invalid")
        self.node_id = node_id
        self.base = base_url.rstrip("/")
        self.secret = secret
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def delete(self, call_id, timeout=REMOTE_TIMEOUT_SECONDS):
        """204 -> deleted, 404 -> absent, 405/501 -> unsupported, anything else -> per-call failure.

        `absent` (the node has no such recording) and `unsupported` (the node has no such
        route) are both `calls.remoteDeleteUnsupported`, but only `absent` settles a
        tombstone as deleted: there is nothing left over there.
        """
        if not UUID.fullmatch(call_id):
            fail("config", "call_id_invalid")
        path = f"/internal/recordings/{call_id}"
        request = urllib.request.Request(self.base + path, headers=recording_delete_headers(self.secret, path),
                                         method="DELETE")
        try:
            response = self.opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            code = error.code
            try:
                error.close()
            except Exception:
                pass
            if code == 404:
                return "absent"
            if code in (405, 501):
                return "unsupported"
            return "failed"
        except (urllib.error.URLError, OSError):
            return "failed"
        try:
            status = response.status
        finally:
            response.close()
        return "deleted" if status in (200, 202, 204) else "failed"


def configured_remote_nodes(values, local_node_id, report=None):
    """Nodes other than this host that expose a recording API. One bad entry is reported, not fatal."""
    raw = values.get("MEDIA_NODES_JSON")
    if not raw:
        return []
    try:
        nodes = json.loads(raw)
    except (ValueError, TypeError):
        fail("config", "media_nodes_invalid")
    if not isinstance(nodes, list):
        fail("config", "media_nodes_invalid")
    remotes = []
    for node in nodes:
        if not isinstance(node, dict):
            fail("config", "media_nodes_invalid")
        node_id = node.get("id")
        if node_id == local_node_id or not node.get("recordingBaseUrl"):
            continue
        try:
            remotes.append(RemoteNode(node_id, node.get("recordingBaseUrl"), node.get("mediaSecret")))
        except RetentionError as error:
            if report is None:
                raise
            report.error(error.failure_type, error.code)
    return remotes


# The remote answer, as written onto the call's tombstone. A failure stays 'pending' so the
# retry phase picks it up again; only the last attempt writes the terminal 'failed'.
REMOTE_STATE = {"deleted": "deleted", "absent": "deleted", "unsupported": "unsupported"}

TOMBSTONE_STATE_SQL = (
    "WITH u AS (UPDATE call_deletion_tombstones SET remote_recording_state=:'remote_state',"
    "remote_attempts=remote_attempts+1,remote_last_attempt_at=now() "
    "WHERE call_id=:'call_id'::uuid RETURNING 1) SELECT count(*)::text FROM u")


def record_remote_state(db, call_id, state):
    """Settle one tombstone. Zero rows is normal: the proof may predate S39 or be trimmed."""
    return db.write_count(TOMBSTONE_STATE_SQL, [("call_id", call_id), ("remote_state", state)])


# --------------------------------------------------------------------- report


class Report:
    def __init__(self, action):
        self.action = action
        self.dry_run = action != "apply"
        self.calls = {"candidates": 0, "deleted": 0, "failed": 0, "remoteDeleteUnsupported": 0}
        self.call_files = FileTally()
        self.remote_retries = {"candidates": 0, "deleted": 0, "unsupported": 0, "failed": 0, "retried": 0}
        self.sms = {}
        self.orphans = {"candidates": 0, "deleted": 0}
        self.orphan_files = FileTally()
        self.housekeeping = {}
        self.errors = []

    def error(self, failure_type, code):
        entry = {"failureType": failure_type, "failureCode": code}
        if entry not in self.errors and len(self.errors) < 50:
            self.errors.append(entry)

    def table(self, target, name, candidates=0, deleted=0):
        bucket = target.setdefault(name, {"candidates": 0, "deleted": 0})
        bucket["candidates"] += candidates
        bucket["deleted"] += deleted

    def document(self):
        return {
            "ok": not self.errors and self.calls["failed"] == 0,
            "action": self.action,
            "dryRun": self.dry_run,
            "calls": {**self.calls, "files": self.call_files.document()},
            "remoteRetries": self.remote_retries,
            "sms": self.sms,
            "orphans": {**self.orphans, "files": self.orphan_files.document()},
            "housekeeping": self.housekeeping,
            "errors": self.errors,
        }


class Deadline:
    def __init__(self, seconds):
        self.limit = time.monotonic() + seconds

    def expired(self):
        return time.monotonic() >= self.limit


# ----------------------------------------------------------------------- phases


def call_predicate(with_cutoff, with_ids):
    clauses = list(CALL_GUARDS)
    if with_cutoff:
        clauses.append("COALESCE(c.ended_at,c.started_at) < :'call_cutoff'::timestamptz")
    if with_ids:
        clauses.append("c.id = ANY(string_to_array(:'call_ids',',')::uuid[])")
    return " AND ".join(clauses)


class Candidate:
    """One eligible call plus the media routing needed to delete its remote copy."""

    __slots__ = ("call_id", "node_id", "media_epoch")

    def __init__(self, call_id, node_id, media_epoch):
        self.call_id = call_id
        self.node_id = node_id
        self.media_epoch = media_epoch

    @classmethod
    def parse(cls, line):
        # `id,node,epoch`; a uuid, a node id and an integer can none of them contain a comma.
        parts = line.strip().split(",")
        if len(parts) != 3 or not UUID.fullmatch(parts[0]):
            fail("database", "call_id_invalid")
        node_id = parts[1] or None
        if node_id is not None and not NODE.fullmatch(node_id):
            fail("database", "media_node_invalid")
        if not re.fullmatch(r"[0-9]{1,18}", parts[2]):
            fail("database", "media_epoch_invalid")
        return cls(parts[0].lower(), node_id, int(parts[2]))


def call_candidates(db, cutoff, call_ids, limit):
    variables = []
    if cutoff is not None:
        variables.append(("call_cutoff", sql_timestamp(cutoff)))
    if call_ids:
        variables.append(("call_ids", ",".join(call_ids)))
    sql = ("SELECT c.id::text||','||COALESCE(c.media_node_id,'')||','||c.media_epoch::text "
           f"FROM call_records c WHERE {call_predicate(cutoff is not None, bool(call_ids))} "
           f"ORDER BY COALESCE(c.ended_at,c.started_at),c.id LIMIT {int(limit)}")
    return [Candidate.parse(line) for line in db.read(sql, variables)]


def remote_node_for(node_id, local_node_id, remotes):
    """The media node that holds this call's recording, or None when there is nothing to call.

    `remotes` is None when remote deletion is off. A call with no media node, or one hosted
    here, is never sent over the network; an unknown node id is a reported configuration gap.
    """
    if remotes is None or node_id is None or node_id == local_node_id:
        return None
    return remotes.get(node_id, "unconfigured")


def delete_one_call(db, call_id, cutoff):
    """One transaction; the eligibility predicate is re-checked inside the DELETE."""
    variables = [("call_id", call_id)]
    if cutoff is not None:
        variables.append(("call_cutoff", sql_timestamp(cutoff)))
    sql = ("BEGIN;\n"
           "WITH d AS (DELETE FROM call_records c WHERE c.id=:'call_id'::uuid AND "
           f"{call_predicate(cutoff is not None, False)} RETURNING 1) SELECT count(*)::text FROM d;\n"
           "COMMIT;\n")
    return db.write_count(sql, variables)


def call_file_targets(paths, call_id):
    """Every local directory that belongs to one call. Order is stable for tests."""
    targets = []
    for root in (paths.get("recording"), paths.get("pixel")):
        if root:
            targets.append(os.path.join(root, call_id))
    ledger = paths.get("ledger")
    if ledger:
        for node in node_directories(ledger):
            targets.append(os.path.join(ledger, node, call_id))
    return targets


def run_calls(db, report, paths, remotes, cutoff, call_ids, limit, dry_run, deadline, local_node_id="relay-primary"):
    candidates = call_candidates(db, cutoff, call_ids, limit)
    report.calls["candidates"] = len(candidates)
    # An explicitly named call that the guards rejected is reported, never silently skipped.
    if call_ids and len(candidates) < limit and \
            {value.lower() for value in call_ids} - {item.call_id for item in candidates}:
        report.error("database", "call_not_eligible")
    if dry_run:
        for candidate in candidates:
            for target in call_file_targets(paths, candidate.call_id):
                report.call_files.add(*remove_directory(target, True))
        return
    for candidate in candidates:
        if deadline.expired():
            report.error("runtime", "runtime_limit")
            return
        try:
            deleted = delete_one_call(db, candidate.call_id, cutoff)
        except RetentionError as error:
            report.calls["failed"] += 1
            report.error(error.failure_type, error.code)
            continue
        if deleted != 1:
            # The row became ineligible or vanished between selection and delete; the
            # orphan sweep reclaims its files on a later run.
            report.calls["failed"] += 1
            report.error("database", "call_not_eligible")
            continue
        report.calls["deleted"] += 1
        for target in call_file_targets(paths, candidate.call_id):
            try:
                report.call_files.add(*remove_directory(target, False))
            except RetentionError as error:
                report.error(error.failure_type, error.code)
        # Only the node that actually hosted this recording is contacted.
        node = remote_node_for(candidate.node_id, local_node_id, remotes)
        if node is None:
            continue
        if node == "unconfigured":
            report.error("config", "media_node_unconfigured")
            continue
        outcome = node.delete(candidate.call_id)
        if outcome in ("absent", "unsupported"):
            report.calls["remoteDeleteUnsupported"] += 1
        elif outcome == "failed":
            report.error("remote", "remote_delete_failed")
        # The tombstone the BEFORE DELETE trigger just wrote carries the answer; a failure
        # stays 'pending' and run_remote_retries tries it again on a later run.
        try:
            record_remote_state(db, candidate.call_id, REMOTE_STATE.get(outcome, "pending"))
        except RetentionError as error:
            report.error(error.failure_type, error.code)


def remote_retry_candidates(db, local_node_id, limit=REMOTE_RETRY_LIMIT):
    """Tombstones whose remote copy is still unconfirmed, as `call_id,node,attempts` lines."""
    sql = ("SELECT call_id::text||','||media_node_id||','||remote_attempts::text "
           "FROM call_deletion_tombstones WHERE remote_recording_state='pending' "
           "AND media_node_id<>:'node_id' "
           f"AND remote_attempts<{REMOTE_RETRY_MAX_ATTEMPTS} "
           f"AND deleted_at > now()-interval '{REMOTE_RETRY_WINDOW_DAYS} days' "
           f"ORDER BY deleted_at LIMIT {int(limit)}")
    rows = []
    for line in db.read(sql, [("node_id", local_node_id)]):
        parts = line.strip().split(",")
        if len(parts) != 3 or not UUID.fullmatch(parts[0]) or not NODE.fullmatch(parts[1]) \
                or not re.fullmatch(r"[0-9]{1,3}", parts[2]):
            fail("database", "tombstone_row_invalid")
        rows.append((parts[0].lower(), parts[1], int(parts[2])))
    return rows


def run_remote_retries(db, report, remotes, dry_run, deadline, local_node_id="relay-primary"):
    """S39 §4: Control tries the remote recording delete once, this phase carries the rest.

    Ten attempts per tombstone within 30 days of the deletion, then the row is terminal.
    """
    candidates = remote_retry_candidates(db, local_node_id)
    report.remote_retries["candidates"] = len(candidates)
    # `report` and `--no-remote` count the backlog without touching the network or the rows.
    if dry_run or remotes is None:
        return
    unreachable = set()
    for call_id, node_id, attempts in candidates:
        if deadline.expired():
            report.error("runtime", "runtime_limit")
            return
        # One dead node must not spend the whole runtime budget; tomorrow's run retries it.
        if node_id in unreachable:
            continue
        node = remote_node_for(node_id, local_node_id, remotes)
        if node == "unconfigured":
            # Nothing will ever delete that copy, so settle rather than retry forever.
            report.error("config", "media_node_unconfigured")
            state = "unsupported"
        else:
            state = REMOTE_STATE.get(node.delete(call_id))
            if state is None:
                unreachable.add(node_id)
                state = "failed" if attempts + 1 >= REMOTE_RETRY_MAX_ATTEMPTS else "pending"
                if state == "failed":
                    report.error("remote", "remote_retry_exhausted")
        report.remote_retries["retried"] += 1
        report.remote_retries[state if state in ("deleted", "unsupported") else "failed"] += 1
        try:
            record_remote_state(db, call_id, state)
        except RetentionError as error:
            report.error(error.failure_type, error.code)


SMS_TABLES = (
    ("sms_messages", "FROM sms_messages WHERE state IN ('delivered','failed') AND created_at < :'sms_cutoff'::timestamptz"),
    ("sms_interceptions", "FROM sms_interceptions WHERE created_at < :'sms_cutoff'::timestamptz"),
)


def run_sms(db, report, cutoff, limit, dry_run):
    variables = [("sms_cutoff", sql_timestamp(cutoff))]
    for name, body in SMS_TABLES:
        if dry_run:
            report.table(report.sms, name, candidates=db.count(bounded_count_sql(body, limit), variables))
            continue
        report.table(report.sms, name, deleted=db.write_count(bounded_delete_sql(name, body, limit), variables))


def housekeeping_tables(values, reference):
    events = reference - dt.timedelta(days=threshold(values, "RETENTION_EVENT_DAYS"))
    snapshots = reference - dt.timedelta(days=threshold(values, "RETENTION_SNAPSHOT_EVENT_DAYS"))
    idempotency = reference - dt.timedelta(days=threshold(values, "RETENTION_IDEMPOTENCY_DAYS"))
    diag = reference - dt.timedelta(days=threshold(values, "RETENTION_DIAG_EVENTS_DAYS"))
    expiry = reference
    return [
        ("diag_events", "diag_events",
         "FROM diag_events WHERE received_at < :'diag_cutoff'::timestamptz",
         [("diag_cutoff", sql_timestamp(diag))]),
        ("device_events_telecom_snapshot", "device_events",
         "FROM device_events WHERE event_type='telecom.snapshot' AND created_at < :'snapshot_cutoff'::timestamptz",
         [("snapshot_cutoff", sql_timestamp(snapshots))]),
        ("device_events_other", "device_events",
         "FROM device_events WHERE event_type<>'telecom.snapshot' AND created_at < :'event_cutoff'::timestamptz",
         [("event_cutoff", sql_timestamp(events))]),
        ("idempotency_requests", "idempotency_requests",
         "FROM idempotency_requests WHERE created_at < :'idempotency_cutoff'::timestamptz",
         [("idempotency_cutoff", sql_timestamp(idempotency))]),
        ("webauthn_challenges", "webauthn_challenges",
         "FROM webauthn_challenges WHERE expires_at < :'expiry_cutoff'::timestamptz",
         [("expiry_cutoff", sql_timestamp(expiry))]),
        ("device_pairing_codes", "device_pairing_codes",
         "FROM device_pairing_codes WHERE consumed_at IS NOT NULL OR expires_at < :'expiry_cutoff'::timestamptz",
         [("expiry_cutoff", sql_timestamp(expiry))]),
    ]


# Retired commands: current epoch only, strictly below the committed floor, horizon ready,
# and never one that another row still points at (those FKs are NO ACTION).
COMMAND_VICTIMS = (
    "FROM commands c "
    "JOIN gateways g ON g.id=c.gateway_id AND g.device_epoch=c.generation "
    "JOIN gateway_command_replay_horizons h ON h.gateway_id=c.gateway_id AND h.generation=c.generation "
    "AND h.state='ready' "
    "WHERE c.sequence < h.committed_floor AND c.created_at < :'command_cutoff'::timestamptz "
    "AND NOT EXISTS (SELECT 1 FROM ai_call_runs r WHERE r.answer_command_id=c.id OR r.hangup_command_id=c.id) "
    "AND NOT EXISTS (SELECT 1 FROM session_revoked_call_cleanups s WHERE s.last_command_id=c.id)"
)


def run_commands(db, report, cutoff, limit, dry_run):
    variables = [("command_cutoff", sql_timestamp(cutoff))]
    if dry_run:
        report.table(report.housekeeping, "commands",
                     candidates=db.count(bounded_count_sql(COMMAND_VICTIMS, limit), variables))
        report.table(report.housekeeping, "gateway_command_replay_receipts",
                     candidates=db.count(
                         "SELECT count(*)::text FROM gateway_command_replay_receipts r WHERE r.command_id IN "
                         f"(SELECT c.id {COMMAND_VICTIMS} LIMIT {int(limit)})", variables))
        return
    # Receipts first, commands second, one transaction; a temp table keeps the victim set
    # identical for both statements instead of relying on CTE evaluation order.
    sql = ("BEGIN;\n"
           f"CREATE TEMP TABLE vodog_retention_victims ON COMMIT DROP AS SELECT c.id {COMMAND_VICTIMS} LIMIT {int(limit)};\n"
           "WITH r AS (DELETE FROM gateway_command_replay_receipts WHERE command_id IN "
           "(SELECT id FROM vodog_retention_victims) RETURNING 1) SELECT count(*)::text FROM r;\n"
           "WITH d AS (DELETE FROM commands WHERE id IN (SELECT id FROM vodog_retention_victims) RETURNING 1) "
           "SELECT count(*)::text FROM d;\n"
           "COMMIT;\n")
    lines = [line.strip() for line in db.run(sql, variables) if re.fullmatch(r"[0-9]+", line.strip())]
    if len(lines) != 2:
        fail("database", "count_invalid")
    report.table(report.housekeeping, "gateway_command_replay_receipts", deleted=int(lines[0]))
    report.table(report.housekeeping, "commands", deleted=int(lines[1]))


def run_housekeeping(db, report, values, reference, limit, dry_run):
    for name, table, body, variables in housekeeping_tables(values, reference):
        if dry_run:
            report.table(report.housekeeping, name, candidates=db.count(bounded_count_sql(body, limit), variables))
            continue
        report.table(report.housekeeping, name, deleted=db.write_count(bounded_delete_sql(table, body, limit), variables))
    run_commands(db, report, reference - dt.timedelta(days=threshold(values, "RETENTION_COMMAND_DAYS")), limit, dry_run)


def known_call_ids(db, call_ids):
    """Fail closed: any query error aborts the sweep instead of reading as `all orphaned`."""
    known = set()
    ordered = sorted(call_ids)
    for index in range(0, len(ordered), ORPHAN_CHUNK):
        chunk = ordered[index:index + ORPHAN_CHUNK]
        lines = db.read("SELECT id::text FROM call_records WHERE id = ANY(string_to_array(:'ids',',')::uuid[])",
                        [("ids", ",".join(chunk))])
        known.update(line.strip().lower() for line in lines)
    return known


def orphan_targets(paths):
    """Every uuid directory that could be an orphan, as (call_id, absolute path)."""
    targets = []
    for root in (paths.get("recording"), paths.get("pixel")):
        if root:
            targets.extend((name.lower(), os.path.join(root, name)) for name in uuid_directories(root))
    ledger = paths.get("ledger")
    if ledger:
        for node in node_directories(ledger):
            node_root = os.path.join(ledger, node)
            targets.extend((name.lower(), os.path.join(node_root, name)) for name in uuid_directories(node_root))
    return targets


def run_orphans(db, report, paths, dry_run, reference=None, deadline=None):
    targets = orphan_targets(paths)
    if not targets:
        return
    known = known_call_ids(db, {call_id for call_id, _path in targets})
    reference = time.time() if reference is None else reference
    for call_id, path in targets:
        if deadline is not None and deadline.expired():
            report.error("runtime", "runtime_limit")
            return
        if call_id in known or not orphan_is_reclaimable(path, reference):
            continue
        report.orphans["candidates"] += 1
        try:
            used, dirs = remove_directory(path, dry_run)
        except RetentionError as error:
            report.error(error.failure_type, error.code)
            continue
        report.orphan_files.add(used, dirs)
        if not dry_run:
            report.orphans["deleted"] += 1


# ------------------------------------------------------------------------- main


def parser():
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("action", nargs="?", default="report", choices=("report", "apply"))
    value.add_argument("--env-file", default=DEFAULT_ENV_FILE)
    value.add_argument("--root", default=DEFAULT_ROOT, help="recording-backup ledger root")
    value.add_argument("--call-id", action="append", default=[])
    calls = value.add_mutually_exclusive_group()
    calls.add_argument("--calls-older-than-days", type=int)
    calls.add_argument("--calls-before")
    sms = value.add_mutually_exclusive_group()
    sms.add_argument("--sms-older-than-days", type=int)
    sms.add_argument("--sms-before")
    value.add_argument("--max-calls", type=int, default=MAX_CALLS)
    value.add_argument("--max-rows", type=int, default=MAX_ROWS)
    value.add_argument("--skip-housekeeping", action="store_true")
    value.add_argument("--node-id", default=None, help="this host's media node id")
    value.add_argument("--no-remote", action="store_true")
    return value


def resolved_paths(values, ledger_root):
    return {
        "recording": values.get("RECORDING_ROOT") or None,
        "pixel": values.get("PIXEL_ARCHIVE_ROOT") or None,
        "ledger": ledger_root,
    }


def execute(args, report):
    if args.max_calls < 1 or args.max_calls > CALLS_CEILING or args.max_rows < 1 or args.max_rows > ROWS_CEILING:
        fail("config", "limit_invalid")
    for call_id in args.call_id:
        if not UUID.fullmatch(call_id):
            fail("config", "call_id_invalid")
    values = load_env(args.env_file)
    reference = now_utc()
    dry_run = args.action != "apply"
    node_id = args.node_id or values.get("MEDIA_DEFAULT_NODE_ID") or os.environ.get("MEDIA_DEFAULT_NODE_ID") or "relay-primary"
    if not NODE.fullmatch(node_id):
        fail("config", "node_id_invalid")
    call_days = args.calls_older_than_days if args.calls_older_than_days is not None else (
        None if args.calls_before else optional_days(values, "RETENTION_CALL_DAYS"))
    sms_days = args.sms_older_than_days if args.sms_older_than_days is not None else (
        None if args.sms_before else optional_days(values, "RETENTION_SMS_DAYS"))
    call_cutoff = cutoff_value(call_days, args.calls_before, reference)
    sms_cutoff = cutoff_value(sms_days, args.sms_before, reference)
    paths = resolved_paths(values, args.root)
    call_scope = call_cutoff is not None or bool(args.call_id)
    # None means "never touch the network"; otherwise a lookup table keyed by media node id.
    # Built on every apply, not just a call-scoped one: the retry phase always runs.
    remotes = None if (args.no_remote or dry_run) else \
        {node.node_id: node for node in configured_remote_nodes(values, node_id, report)}
    database_url = values.get("DATABASE_URL", "")
    if not database_url:
        fail("config", "database_config_invalid")
    db = Database(database_url, read_only=dry_run)
    deadline = Deadline(MAX_RUNTIME_SECONDS)

    def phases():
        if call_scope:
            run_calls(db, report, paths, remotes, call_cutoff, args.call_id, args.max_calls, dry_run, deadline,
                      local_node_id=node_id)
        run_remote_retries(db, report, remotes, dry_run, deadline, local_node_id=node_id)
        if sms_cutoff is not None:
            run_sms(db, report, sms_cutoff, args.max_rows, dry_run)
        if not args.skip_housekeeping:
            run_housekeeping(db, report, values, reference, args.max_rows, dry_run)
        run_orphans(db, report, paths, dry_run, deadline=deadline)

    if dry_run:
        phases()
    else:
        with JobLock(args.root):
            phases()


def main(argv=None):
    args = parser().parse_args(argv)
    report = Report(args.action)
    try:
        execute(args, report)
    except RetentionError as error:
        report.error(error.failure_type, error.code)
    except Exception:
        report.error("internal", "internal_error")
    document = report.document()
    print(json.dumps(document, sort_keys=True))
    return 0 if document["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
