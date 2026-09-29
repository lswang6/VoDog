#!/usr/bin/env python3
"""Tests for infra/retention.py.

Pure-logic tests always run. The end-to-end test runs only when TEST_DATABASE_URL points
at a throwaway local database whose name contains `test`; it applies the real Control
schema, deletes one call and checks the rows, the files and the replay ledger.
"""

import base64
import contextlib
import datetime as dt
import hashlib
import hmac
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("vodog_retention", ROOT / "infra" / "retention.py")
retention = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(retention)

SCHEMA = ROOT / "services" / "control" / "src" / "schema.sql"
TRANSCRIPTION_SCHEMA = ROOT / "services" / "control" / "src" / "transcription" / "schema.sql"
PSQL_CANDIDATES = (os.environ.get("PSQL", "psql"),)


def psql_binary():
    for candidate in PSQL_CANDIDATES:
        if os.path.isabs(candidate):
            if os.path.exists(candidate):
                return candidate
            continue
        try:
            subprocess.run([candidate, "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
            return candidate
        except (OSError, subprocess.SubprocessError):
            continue
    return None


def database_skip_reason():
    url = os.environ.get("TEST_DATABASE_URL", "")
    if not url:
        return "TEST_DATABASE_URL is not set"
    if urllib.parse.urlsplit(url).hostname not in ("localhost", "127.0.0.1", "::1"):
        return "TEST_DATABASE_URL must point to a loopback host"
    if "test" not in urllib.parse.urlsplit(url).path:
        return "TEST_DATABASE_URL database name must contain 'test'"
    if psql_binary() is None:
        return "psql is not available (retention.py talks to PostgreSQL through psql, like recording-backup.py)"
    return None


def write_tree(base, relative, body=b"x"):
    path = Path(base) / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return path


class CutoffTests(unittest.TestCase):
    reference = dt.datetime(2026, 9, 13, 12, 0, 0, tzinfo=dt.timezone.utc)

    def test_days_are_measured_back_from_the_run_reference(self):
        self.assertEqual(retention.cutoff_value(2, None, self.reference),
                         dt.datetime(2026, 9, 11, 12, 0, 0, tzinfo=dt.timezone.utc))

    def test_absolute_cutoff_accepts_iso_forms_and_normalizes_to_utc(self):
        self.assertEqual(retention.cutoff_value(None, "2026-09-01T00:00:00Z", self.reference),
                         dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc))
        self.assertEqual(retention.cutoff_value(None, "2026-09-01T08:00:00+08:00", self.reference),
                         dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc))
        # A naive value is read as UTC rather than as the host's local zone.
        self.assertEqual(retention.cutoff_value(None, "2026-09-01", self.reference),
                         dt.datetime(2026, 9, 1, tzinfo=dt.timezone.utc))

    def test_no_scope_means_no_cutoff(self):
        self.assertIsNone(retention.cutoff_value(None, None, self.reference))

    def test_invalid_scopes_are_refused(self):
        for days, before in ((0, None), (-1, None), (True, None), (None, "not-a-date"), (1, "2026-09-01")):
            with self.assertRaises(retention.RetentionError):
                retention.cutoff_value(days, before, self.reference)

    def test_thresholds_default_and_are_overridable(self):
        self.assertEqual(retention.threshold({}, "RETENTION_EVENT_DAYS"), 90)
        self.assertEqual(retention.threshold({"RETENTION_EVENT_DAYS": "5"}, "RETENTION_EVENT_DAYS"), 5)
        self.assertEqual(retention.threshold({"RETENTION_SNAPSHOT_EVENT_DAYS": ""}, "RETENTION_SNAPSHOT_EVENT_DAYS"), 7)
        with self.assertRaises(retention.RetentionError):
            retention.threshold({"RETENTION_COMMAND_DAYS": "0"}, "RETENTION_COMMAND_DAYS")
        with self.assertRaises(retention.RetentionError):
            retention.threshold({"RETENTION_COMMAND_DAYS": "3 days"}, "RETENTION_COMMAND_DAYS")

    def test_call_and_sms_days_opt_in_only(self):
        self.assertIsNone(retention.optional_days({}, "RETENTION_CALL_DAYS"))
        self.assertEqual(retention.optional_days({"RETENTION_CALL_DAYS": "30"}, "RETENTION_CALL_DAYS"), 30)


class EnvTests(unittest.TestCase):
    def test_quoted_values_are_unwrapped(self):
        with tempfile.TemporaryDirectory() as base:
            path = Path(base) / "app.env"
            path.write_text("# comment\n\nDATABASE_URL='postgres://u:p@h/db'\n"
                            'MEDIA_NODES_JSON="[{\\"id\\":\\"relay-secondary\\"}]"\n'
                            "RECORDING_ROOT=/data/recordings\n")
            values = retention.load_env(str(path))
        self.assertEqual(values["DATABASE_URL"], "postgres://u:p@h/db")
        self.assertEqual(json.loads(values["MEDIA_NODES_JSON"]), [{"id": "relay-secondary"}])
        self.assertEqual(values["RECORDING_ROOT"], "/data/recordings")

    def test_report_mode_forces_a_read_only_session(self):
        env = retention.database_environment("postgres://u:p@h:5432/db", read_only=True)
        self.assertIn("default_transaction_read_only=on", env["PGOPTIONS"])
        self.assertIn("statement_timeout=", env["PGOPTIONS"])
        self.assertNotIn("default_transaction_read_only",
                         retention.database_environment("postgres://u:p@h/db", read_only=False)["PGOPTIONS"])

    def test_secrets_never_leak_into_the_report(self):
        error = retention.RetentionError("config", "database_config_invalid")
        report = retention.Report("apply")
        report.error(error.failure_type, error.code)
        self.assertEqual(report.document()["errors"], [{"failureType": "config", "failureCode": "database_config_invalid"}])

    def test_malformed_database_urls_are_refused(self):
        for url in ("", "mysql://h/db", "postgres://h/", "postgres://h/db?options=-c%20x"):
            with self.assertRaises(retention.RetentionError):
                retention.database_environment(url, read_only=True)


class DirectoryFilterTests(unittest.TestCase):
    def test_only_uuid_directories_are_ever_considered(self):
        with tempfile.TemporaryDirectory() as base:
            call = str(uuid.uuid4())
            os.mkdir(os.path.join(base, call))
            os.mkdir(os.path.join(base, ".staging"))
            os.mkdir(os.path.join(base, "not-a-uuid"))
            Path(base, ".cursor-relay-secondary.json").write_text("{}")
            Path(base, f"{uuid.uuid4()}").write_text("a regular file, not a directory")
            os.symlink("/etc", os.path.join(base, str(uuid.uuid4())))
            self.assertEqual(retention.uuid_directories(base), [call])

    def test_node_directories_skip_dotfiles_and_files(self):
        with tempfile.TemporaryDirectory() as base:
            os.mkdir(os.path.join(base, "relay-secondary"))
            os.mkdir(os.path.join(base, "relay-primary"))
            os.mkdir(os.path.join(base, ".staging"))
            Path(base, ".recording-backup.lock").write_text("")
            self.assertEqual(retention.node_directories(base), ["relay-primary", "relay-secondary"])

    def test_missing_roots_are_not_an_error(self):
        self.assertEqual(retention.uuid_directories("/nonexistent/vodog/root"), [])
        self.assertEqual(retention.node_directories("/nonexistent/vodog/root"), [])
        self.assertEqual(retention.uuid_directories(None), [])


class OrphanDecisionTests(unittest.TestCase):
    def test_a_finalized_directory_is_reclaimable_at_any_age(self):
        with tempfile.TemporaryDirectory() as base:
            write_tree(base, "manifest.json", b"{}")
            self.assertTrue(retention.orphan_is_reclaimable(base, os.stat(base).st_mtime))

    def test_a_nested_manifest_counts(self):
        with tempfile.TemporaryDirectory() as base:
            write_tree(base, "archive-1/manifest.json", b"{}")
            self.assertTrue(retention.orphan_is_reclaimable(base, os.stat(base).st_mtime))

    def test_a_fresh_directory_without_a_manifest_is_left_alone(self):
        with tempfile.TemporaryDirectory() as base:
            write_tree(base, "remote_original.ogg", b"in flight")
            self.assertFalse(retention.orphan_is_reclaimable(base, os.stat(base).st_mtime))

    def test_an_aged_directory_without_a_manifest_is_reclaimable(self):
        with tempfile.TemporaryDirectory() as base:
            write_tree(base, "remote_original.ogg", b"abandoned")
            reference = os.stat(base).st_mtime + 2 * retention.ORPHAN_MIN_AGE_SECONDS
            self.assertTrue(retention.orphan_is_reclaimable(base, reference))

    def test_orphan_targets_cover_all_three_roots(self):
        with tempfile.TemporaryDirectory() as base:
            call = str(uuid.uuid4())
            paths = {"recording": os.path.join(base, "recordings"),
                     "pixel": os.path.join(base, "pixel"),
                     "ledger": os.path.join(base, "ledger")}
            write_tree(paths["recording"], f"{call}/manifest.json", b"{}")
            write_tree(paths["pixel"], f"{call}/a1/manifest.json", b"{}")
            write_tree(paths["ledger"], f"relay-secondary/{call}/1/manifest.json", b"{}")
            # `.staging` and `NotANode` are not node ids, so the ledger sweep never descends.
            write_tree(paths["ledger"], f".staging/{call}/x")
            write_tree(paths["ledger"], f"NotANode/{call}/x")
            found = retention.orphan_targets(paths)
        self.assertEqual([item[0] for item in found], [call, call, call])
        self.assertTrue(all(item[1].endswith(call) for item in found))
        self.assertFalse(any(".staging" in item[1] or "NotANode" in item[1] for item in found))


class RemovalTests(unittest.TestCase):
    def test_dry_run_measures_without_deleting(self):
        with tempfile.TemporaryDirectory() as base:
            call = str(uuid.uuid4())
            directory = os.path.join(base, call)
            write_tree(base, f"{call}/manifest.json", b"0123456789")
            write_tree(base, f"{call}/tracks/remote_original.ogg", b"01234")
            used, dirs = retention.remove_directory(directory, True)
            self.assertEqual((used, dirs), (15, 1))
            self.assertTrue(os.path.isdir(directory))
            used, dirs = retention.remove_directory(directory, False)
            self.assertEqual((used, dirs), (15, 1))
            self.assertFalse(os.path.exists(directory))

    def test_a_missing_directory_is_a_no_op(self):
        with tempfile.TemporaryDirectory() as base:
            self.assertEqual(retention.remove_directory(os.path.join(base, str(uuid.uuid4())), False), (0, 0))

    def test_a_file_is_never_removed_as_if_it_were_a_directory(self):
        with tempfile.TemporaryDirectory() as base:
            path = write_tree(base, "regular-file", b"data")
            with self.assertRaises(retention.RetentionError):
                retention.remove_directory(str(path), False)
            self.assertTrue(path.exists())

    def test_call_file_targets_cover_every_local_copy(self):
        with tempfile.TemporaryDirectory() as base:
            call = str(uuid.uuid4())
            paths = {"recording": os.path.join(base, "recordings"),
                     "pixel": os.path.join(base, "pixel"),
                     "ledger": os.path.join(base, "ledger")}
            write_tree(paths["ledger"], f"relay-secondary/{call}/1/manifest.json", b"{}")
            write_tree(paths["ledger"], f"relay-primary/{call}/1/manifest.json", b"{}")
            targets = retention.call_file_targets(paths, call)
        self.assertEqual(targets, [
            os.path.join(paths["recording"], call),
            os.path.join(paths["pixel"], call),
            os.path.join(paths["ledger"], "relay-primary", call),
            os.path.join(paths["ledger"], "relay-secondary", call),
        ])


class StubResponse:
    def __init__(self, status):
        self.status = status

    def close(self):
        pass


class StubOpener:
    """Stands in for urllib's opener; the suite never touches the network."""

    def __init__(self, outcome):
        self.outcome = outcome
        self.requests = []

    def open(self, request, timeout=None):
        self.requests.append(request)
        if isinstance(self.outcome, int):
            if self.outcome >= 400:
                raise urllib.error.HTTPError(request.full_url, self.outcome, "stub", {}, None)
            return StubResponse(self.outcome)
        raise self.outcome


class SignatureTests(unittest.TestCase):
    secret = "routed-recording-secret-at-least-32-bytes"
    call_id = "11111111-1111-1111-1111-111111111111"

    def test_canonical_string_matches_the_media_node_contract(self):
        path = f"/internal/recordings/{self.call_id}"
        self.assertEqual(retention.recording_delete_canonical(path, "1757740000", "nonce-value"),
                         "DELETE\n/internal/recordings/11111111-1111-1111-1111-111111111111\n1757740000\nnonce-value\n")

    def test_signature_matches_an_independently_computed_vector(self):
        path = f"/internal/recordings/{self.call_id}"
        timestamp, nonce = "1757740000", "MW5vbmNlLXZhbHVlLWZvci10ZXN0"
        canonical = f"DELETE\n{path}\n{timestamp}\n{nonce}\n"
        expected = base64.urlsafe_b64encode(
            hmac.new(self.secret.encode(), canonical.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
        headers = retention.recording_delete_headers(self.secret, path, timestamp, nonce)
        self.assertEqual(headers["X-CC-Signature"], expected)
        self.assertEqual(headers["X-CC-Timestamp"], timestamp)
        self.assertEqual(headers["X-CC-Nonce"], nonce)
        # services/media/recording_delete_http_test.go pins the same vector from the Go side.
        self.assertEqual(expected, "1p1pcwz0UlplGxRjHfzGBZRDbftOm4ECqRzmtrvE6ZU")

    def test_signature_is_unpadded_base64url(self):
        # services/media decodes with base64.RawURLEncoding, which rejects '=' padding.
        headers = retention.recording_delete_headers(self.secret, f"/internal/recordings/{self.call_id}")
        self.assertNotIn("=", headers["X-CC-Signature"])
        self.assertRegex(headers["X-CC-Signature"], r"^[A-Za-z0-9_-]{43}$")
        self.assertGreaterEqual(len(headers["X-CC-Nonce"]), 20)
        self.assertLessEqual(len(headers["X-CC-Nonce"]), 100)

    def test_a_get_signature_does_not_authorize_a_delete(self):
        path = f"/internal/recordings/{self.call_id}"
        canonical = f"GET\n{path}\n1757740000\nn\n"
        get_signature = base64.urlsafe_b64encode(
            hmac.new(self.secret.encode(), canonical.encode(), hashlib.sha256).digest()).rstrip(b"=").decode()
        self.assertNotEqual(get_signature,
                            retention.recording_delete_headers(self.secret, path, "1757740000", "n")["X-CC-Signature"])

    def test_remote_node_configuration_is_validated(self):
        for base, secret in (("http://node/", self.secret), ("https://node/path", self.secret),
                             ("https://u:p@node", self.secret), ("https://node", "short"), ("", self.secret)):
            with self.assertRaises(retention.RetentionError):
                retention.RemoteNode("relay-secondary", base, secret)
        node = retention.RemoteNode("relay-secondary", "https://node.example.com/", self.secret)
        self.assertEqual(node.base, "https://node.example.com")

    def test_remote_delete_outcomes_are_mapped_exactly(self):
        """404 is `absent`, 405/501 `unsupported`; every other error, including 401, is a failure.

        A media node that predates S29 answers DELETE with 401 (its handler only allowed
        GET), so that must stay a reported failure rather than a silent success.
        """
        cases = {204: "deleted", 200: "deleted", 202: "deleted",
                 404: "absent", 405: "unsupported", 501: "unsupported",
                 401: "failed", 403: "failed", 409: "failed", 500: "failed", 503: "failed"}
        for status, expected in cases.items():
            opener = StubOpener(status)
            node = retention.RemoteNode("relay-secondary", "https://node.example.com", self.secret, opener=opener)
            self.assertEqual(node.delete(self.call_id), expected, status)
            request = opener.requests[-1]
            self.assertEqual(request.get_method(), "DELETE")
            self.assertEqual(request.full_url, f"https://node.example.com/internal/recordings/{self.call_id}")
            self.assertIn("X-cc-signature", request.headers)
        for failure in (urllib.error.URLError("unreachable"), OSError("reset"), TimeoutError()):
            node = retention.RemoteNode("relay-secondary", "https://node.example.com", self.secret, opener=StubOpener(failure))
            self.assertEqual(node.delete(self.call_id), "failed")
        with self.assertRaises(retention.RetentionError):
            retention.RemoteNode("relay-secondary", "https://node.example.com", self.secret,
                                 opener=StubOpener(204)).delete("../../etc")

    def test_only_remote_nodes_with_a_recording_api_are_selected(self):
        values = {"MEDIA_NODES_JSON": json.dumps([
            {"id": "relay-primary", "recordingBaseUrl": "https://relay-primary.example.com", "mediaSecret": self.secret},
            {"id": "relay-secondary", "recordingBaseUrl": "https://relay-secondary.example.com", "mediaSecret": self.secret},
            {"id": "node3", "mediaSecret": self.secret},
        ])}
        self.assertEqual([node.node_id for node in retention.configured_remote_nodes(values, "relay-primary")], ["relay-secondary"])
        self.assertEqual(retention.configured_remote_nodes({}, "relay-primary"), [])


class FakeDatabase:
    """Returns a fixed candidate list; every delete claims to have removed one row."""

    def __init__(self, rows):
        self.rows = rows
        self.deletes = []
        self.states = []

    def read(self, sql, variables=()):
        return list(self.rows)

    def write_count(self, sql, variables=()):
        values = dict(variables)
        if "call_deletion_tombstones" in sql:
            self.states.append((values["call_id"], values["remote_state"]))
            return 1
        self.deletes.append(values["call_id"])
        return 1


class RemoteTargetingTests(unittest.TestCase):
    secret = "routed-recording-secret-at-least-32-bytes"

    def node(self, node_id, opener):
        return retention.RemoteNode(node_id, f"https://{node_id}.example.com", self.secret, opener=opener)

    def test_remote_node_for_picks_the_recordings_own_host(self):
        secondary = self.node("relay-secondary", StubOpener(204))
        remotes = {"relay-secondary": secondary}
        self.assertIs(retention.remote_node_for("relay-secondary", "relay-primary", remotes), secondary)
        # Hosted here, unrouted, or remote deletion disabled: nothing to contact.
        self.assertIsNone(retention.remote_node_for("relay-primary", "relay-primary", remotes))
        self.assertIsNone(retention.remote_node_for(None, "relay-primary", remotes))
        self.assertIsNone(retention.remote_node_for("relay-secondary", "relay-primary", None))
        # A node id that MEDIA_NODES_JSON does not describe is a reported gap, not a silent skip.
        self.assertEqual(retention.remote_node_for("node3", "relay-primary", remotes), "unconfigured")

    def run_one(self, node_id, remotes, local="relay-primary"):
        call = str(uuid.uuid4())
        database = FakeDatabase([f"{call},{node_id or ''},1"])
        report = retention.Report("apply")
        with tempfile.TemporaryDirectory() as base:
            paths = {"recording": base, "pixel": None, "ledger": None}
            retention.run_calls(database, report, paths, remotes, None, [], 500, False,
                                retention.Deadline(60), local_node_id=local)
        self.assertEqual(database.deletes, [call])
        self.database = database
        return report.document(), call

    def test_a_call_hosted_here_never_contacts_another_node(self):
        opener = StubOpener(204)
        document, _call = self.run_one("relay-primary", {"relay-secondary": self.node("relay-secondary", opener)})
        self.assertEqual(opener.requests, [])
        self.assertEqual(document["calls"]["deleted"], 1)
        self.assertEqual(document["calls"]["remoteDeleteUnsupported"], 0)
        self.assertTrue(document["ok"])
        # Nothing was asked of another node, so nothing is written onto the tombstone.
        self.assertEqual(self.database.states, [])

    def test_a_call_hosted_remotely_contacts_only_that_node(self):
        secondary_opener, other_opener = StubOpener(204), StubOpener(204)
        remotes = {"relay-secondary": self.node("relay-secondary", secondary_opener), "node3": self.node("node3", other_opener)}
        document, call = self.run_one("relay-secondary", remotes)
        self.assertEqual(len(secondary_opener.requests), 1)
        self.assertEqual(secondary_opener.requests[0].full_url, f"https://relay-secondary.example.com/internal/recordings/{call}")
        self.assertEqual(secondary_opener.requests[0].get_method(), "DELETE")
        self.assertEqual(other_opener.requests, [])
        self.assertTrue(document["ok"])
        self.assertEqual(self.database.states, [(call, "deleted")])

    def test_no_remote_contacts_nothing(self):
        document, _call = self.run_one("relay-secondary", None)
        self.assertTrue(document["ok"])
        self.assertEqual(document["calls"]["remoteDeleteUnsupported"], 0)

    def test_a_call_with_no_media_node_contacts_nothing(self):
        opener = StubOpener(204)
        document, _call = self.run_one(None, {"relay-secondary": self.node("relay-secondary", opener)})
        self.assertEqual(opener.requests, [])
        self.assertTrue(document["ok"])

    def test_unsupported_only_counts_the_own_nodes_answer(self):
        for status, state in ((404, "deleted"), (405, "unsupported")):
            document, call = self.run_one("relay-secondary", {"relay-secondary": self.node("relay-secondary", StubOpener(status))})
            self.assertEqual(document["calls"]["remoteDeleteUnsupported"], 1, status)
            self.assertTrue(document["ok"], status)
            # 404 means the copy is gone, 405 that the node has no such route: different proofs.
            self.assertEqual(self.database.states, [(call, state)], status)

    def test_a_rejecting_node_is_a_reported_failure(self):
        document, call = self.run_one("relay-secondary", {"relay-secondary": self.node("relay-secondary", StubOpener(401))})
        self.assertFalse(document["ok"])
        self.assertIn({"failureType": "remote", "failureCode": "remote_delete_failed"}, document["errors"])
        # Left pending on purpose: run_remote_retries owns every attempt after the first.
        self.assertEqual(self.database.states, [(call, "pending")])

    def test_an_unconfigured_host_is_reported(self):
        document, _call = self.run_one("node9", {"relay-secondary": self.node("relay-secondary", StubOpener(204))})
        self.assertFalse(document["ok"])
        self.assertIn({"failureType": "config", "failureCode": "media_node_unconfigured"}, document["errors"])

    def test_candidate_rows_are_strictly_parsed(self):
        call = str(uuid.uuid4())
        candidate = retention.Candidate.parse(f"{call},relay-secondary,4")
        self.assertEqual((candidate.call_id, candidate.node_id, candidate.media_epoch), (call, "relay-secondary", 4))
        self.assertIsNone(retention.Candidate.parse(f"{call},,1").node_id)
        for line in (call, f"{call},relay-secondary", f"{call},relay-secondary,1,x", "not-a-uuid,relay-secondary,1",
                     f"{call},Bad Node,1", f"{call},relay-secondary,x"):
            with self.assertRaises(retention.RetentionError):
                retention.Candidate.parse(line)


class FakeTombstones:
    """The tombstone table, reduced to what the retry phase reads and writes."""

    def __init__(self, rows):
        # {call_id: [node_id, remote_recording_state, remote_attempts]}
        self.rows = rows
        self.updates = []

    def read(self, sql, variables=()):
        local = dict(variables)["node_id"]
        return [f"{call},{node},{attempts}" for call, (node, state, attempts) in sorted(self.rows.items())
                if state == "pending" and node != local and attempts < retention.REMOTE_RETRY_MAX_ATTEMPTS]

    def write_count(self, sql, variables=()):
        values = dict(variables)
        row = self.rows[values["call_id"]]
        row[1], row[2] = values["remote_state"], row[2] + 1
        self.updates.append((values["call_id"], values["remote_state"]))
        return 1


class RemoteRetryTests(unittest.TestCase):
    """S39 §4: the tombstone, not the deleted call row, carries the remaining attempts."""

    secret = "routed-recording-secret-at-least-32-bytes"
    call = "22222222-2222-2222-2222-222222222222"

    def node(self, node_id, opener):
        return retention.RemoteNode(node_id, f"https://{node_id}.example.com", self.secret, opener=opener)

    def run_phase(self, database, opener=None, dry_run=False, remotes=True):
        report = retention.Report("report" if dry_run else "apply")
        opener = StubOpener(204) if opener is None else opener
        table = {"relay-secondary": self.node("relay-secondary", opener)} if remotes else None
        retention.run_remote_retries(database, report, table, dry_run, retention.Deadline(60),
                                     local_node_id="relay-primary")
        return report.document(), opener

    def pending(self, node="relay-secondary", attempts=0):
        return FakeTombstones({self.call: [node, "pending", attempts]})

    def test_a_deleted_remote_copy_settles_the_tombstone(self):
        database = self.pending()
        document, opener = self.run_phase(database, StubOpener(204))
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(opener.requests[0].full_url, f"https://relay-secondary.example.com/internal/recordings/{self.call}")
        self.assertEqual(opener.requests[0].get_method(), "DELETE")
        self.assertEqual(database.updates, [(self.call, "deleted")])
        self.assertEqual(document["remoteRetries"],
                         {"candidates": 1, "deleted": 1, "unsupported": 0, "failed": 0, "retried": 1})
        self.assertTrue(document["ok"])
        # Settled means settled: the next run has nothing to do.
        self.assertEqual(self.run_phase(database)[0]["remoteRetries"]["candidates"], 0)

    def test_a_missing_remote_copy_counts_as_deleted(self):
        database = self.pending()
        document, _opener = self.run_phase(database, StubOpener(404))
        self.assertEqual(database.updates, [(self.call, "deleted")])
        self.assertEqual(document["remoteRetries"]["deleted"], 1)
        self.assertTrue(document["ok"])

    def test_a_node_without_the_route_settles_as_unsupported(self):
        for status in (405, 501):
            database = self.pending()
            document, _opener = self.run_phase(database, StubOpener(status))
            self.assertEqual(database.updates, [(self.call, "unsupported")], status)
            self.assertEqual(document["remoteRetries"]["unsupported"], 1, status)

    def test_ten_failures_exhaust_the_tombstone_and_then_it_is_left_alone(self):
        database = self.pending()
        for attempt in range(1, retention.REMOTE_RETRY_MAX_ATTEMPTS + 1):
            document, opener = self.run_phase(database, StubOpener(500))
            self.assertEqual(len(opener.requests), 1, attempt)
            self.assertEqual(document["remoteRetries"], {"candidates": 1, "deleted": 0, "unsupported": 0,
                                                         "failed": 1, "retried": 1}, attempt)
            terminal = attempt == retention.REMOTE_RETRY_MAX_ATTEMPTS
            self.assertEqual(database.rows[self.call][1], "failed" if terminal else "pending", attempt)
            self.assertEqual(database.rows[self.call][2], attempt, attempt)
            # Only the last attempt is worth waking someone for.
            self.assertEqual({"failureType": "remote", "failureCode": "remote_retry_exhausted"} in document["errors"],
                             terminal, attempt)
            self.assertEqual(document["ok"], not terminal, attempt)
        document, opener = self.run_phase(database, StubOpener(500))
        self.assertEqual(document["remoteRetries"]["candidates"], 0)
        self.assertEqual(opener.requests, [])

    def test_an_unconfigured_node_is_settled_instead_of_retried_forever(self):
        database = self.pending(node="node9")
        document, opener = self.run_phase(database, StubOpener(204))
        self.assertEqual(opener.requests, [])
        self.assertEqual(database.updates, [(self.call, "unsupported")])
        self.assertEqual(document["remoteRetries"]["unsupported"], 1)
        self.assertIn({"failureType": "config", "failureCode": "media_node_unconfigured"}, document["errors"])

    def test_a_dry_run_counts_the_backlog_without_a_request_or_a_write(self):
        database = self.pending()
        document, opener = self.run_phase(database, StubOpener(204), dry_run=True)
        self.assertEqual(opener.requests, [])
        self.assertEqual(database.updates, [])
        self.assertEqual(document["remoteRetries"],
                         {"candidates": 1, "deleted": 0, "unsupported": 0, "failed": 0, "retried": 0})

    def test_no_remote_counts_the_backlog_without_a_request_or_a_write(self):
        database = self.pending()
        document, opener = self.run_phase(database, StubOpener(204), remotes=False)
        self.assertEqual(opener.requests, [])
        self.assertEqual(database.updates, [])
        self.assertEqual(document["remoteRetries"]["candidates"], 1)
        self.assertEqual(document["remoteRetries"]["retried"], 0)

    def test_one_unreachable_node_costs_one_request_per_run(self):
        second = "33333333-3333-3333-3333-333333333333"
        database = FakeTombstones({self.call: ["relay-secondary", "pending", 0], second: ["relay-secondary", "pending", 0]})
        document, opener = self.run_phase(database, StubOpener(urllib.error.URLError("unreachable")))
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(document["remoteRetries"]["candidates"], 2)
        self.assertEqual(document["remoteRetries"]["retried"], 1)
        # The skipped row keeps its attempt count, so tomorrow's run is a fresh try.
        self.assertEqual(database.rows[second], ["relay-secondary", "pending", 0])

    def test_malformed_tombstone_rows_are_refused(self):
        class Rows:
            def __init__(self, lines):
                self.lines = lines

            def read(self, sql, variables=()):
                return self.lines

        for line in (f"{self.call},relay-secondary", f"{self.call},relay-secondary,1,x", "not-a-uuid,relay-secondary,1",
                     f"{self.call},Bad Node,1", f"{self.call},relay-secondary,x"):
            with self.assertRaises(retention.RetentionError):
                retention.remote_retry_candidates(Rows([line]), "relay-primary")

    def test_the_candidate_query_carries_every_bound_the_contract_names(self):
        captured = {}

        class Recorder:
            def read(self, sql, variables=()):
                captured["sql"], captured["variables"] = sql, list(variables)
                return []

        retention.remote_retry_candidates(Recorder(), "relay-primary")
        self.assertEqual(captured["variables"], [("node_id", "relay-primary")])
        for fragment in ("FROM call_deletion_tombstones", "remote_recording_state='pending'",
                         "media_node_id<>:'node_id'", "remote_attempts<10",
                         "deleted_at > now()-interval '30 days'", "ORDER BY deleted_at LIMIT 100"):
            self.assertIn(fragment, captured["sql"])


class QueryShapeTests(unittest.TestCase):
    def test_every_call_guard_is_present(self):
        predicate = retention.call_predicate(True, True)
        for fragment in ("c.state IN ('ended','failed')", "now() - interval '1 hour'", "gateway_call_locks",
                         "m.status='pending'", "j.completed_at IS NULL", ":'call_cutoff'", ":'call_ids'",
                         "pixel_recording_archives p", "p.state IN ('uploading','verifying')",
                         "ai_call_runs a", "a.state IN ('pending','preparing','answer_committed'"):
            self.assertIn(fragment, predicate)

    def test_the_in_delete_recheck_uses_the_same_guards(self):
        # `--call-id` pins the row, so only the id clause differs between selection and delete.
        selection = retention.call_predicate(True, True)
        recheck = retention.call_predicate(True, False)
        self.assertEqual(selection.replace(" AND c.id = ANY(string_to_array(:'call_ids',',')::uuid[])", ""), recheck)

    def test_the_busy_state_sets_match_the_schema(self):
        schema = SCHEMA.read_text()
        self.assertIn("CHECK(state IN ('uploading','verifying','complete','rejected'))", schema)
        self.assertEqual(retention.PIXEL_ARCHIVE_BUSY, ("uploading", "verifying"))
        # schema.sql's ai_call_runs_due_idx is the authoritative non-terminal set.
        self.assertIn("WHERE state IN (" + retention.sql_string_list(retention.AI_RUN_BUSY) + ")", schema)

    def test_scope_clauses_appear_only_when_requested(self):
        self.assertNotIn(":'call_cutoff'", retention.call_predicate(False, True))
        self.assertNotIn(":'call_ids'", retention.call_predicate(True, False))

    def test_command_victims_never_reach_or_pass_the_committed_floor(self):
        self.assertIn("c.sequence < h.committed_floor", retention.COMMAND_VICTIMS)
        self.assertIn("h.state='ready'", retention.COMMAND_VICTIMS)
        self.assertIn("g.device_epoch=c.generation", retention.COMMAND_VICTIMS)
        # Rows that still point at a command hold a NO ACTION foreign key.
        self.assertIn("ai_call_runs", retention.COMMAND_VICTIMS)
        self.assertIn("session_revoked_call_cleanups", retention.COMMAND_VICTIMS)

    def test_bounded_statements_carry_their_limit(self):
        self.assertIn("LIMIT 10", retention.bounded_count_sql("FROM sms_messages", 10))
        delete = retention.bounded_delete_sql("sms_messages", "FROM sms_messages", 7)
        self.assertIn("DELETE FROM sms_messages WHERE ctid IN", delete)
        self.assertIn("LIMIT 7", delete)

    def test_housekeeping_covers_every_table_the_spec_names(self):
        reference = dt.datetime(2026, 9, 13, tzinfo=dt.timezone.utc)
        tables = retention.housekeeping_tables({}, reference)
        self.assertEqual([name for name, _table, _body, _variables in tables],
                         ["diag_events", "device_events_telecom_snapshot", "device_events_other",
                          "idempotency_requests", "webauthn_challenges", "device_pairing_codes"])
        bodies = {name: body for name, _table, body, _variables in tables}
        self.assertIn("received_at < :'diag_cutoff'", bodies["diag_events"])
        self.assertIn("event_type='telecom.snapshot'", bodies["device_events_telecom_snapshot"])
        self.assertIn("event_type<>'telecom.snapshot'", bodies["device_events_other"])
        self.assertIn("expires_at <", bodies["webauthn_challenges"])
        self.assertIn("consumed_at IS NOT NULL", bodies["device_pairing_codes"])
        cutoffs = {name: variables[0][1] for name, _table, _body, variables in tables}
        self.assertEqual(cutoffs["device_events_telecom_snapshot"], "2026-09-06T00:00:00+00:00")
        self.assertEqual(cutoffs["device_events_other"], "2026-06-15T00:00:00+00:00")
        self.assertEqual(cutoffs["idempotency_requests"], "2026-09-06T00:00:00+00:00")


class ReportShapeTests(unittest.TestCase):
    def test_document_has_the_documented_shape(self):
        report = retention.Report("report")
        document = report.document()
        self.assertEqual(set(document), {"ok", "action", "dryRun", "calls", "remoteRetries", "sms", "orphans",
                                         "housekeeping", "errors"})
        self.assertEqual(set(document["calls"]), {"candidates", "deleted", "failed", "remoteDeleteUnsupported", "files"})
        self.assertEqual(set(document["remoteRetries"]), {"candidates", "deleted", "unsupported", "failed", "retried"})
        self.assertEqual(set(document["calls"]["files"]), {"bytes", "dirs"})
        self.assertEqual(set(document["orphans"]), {"candidates", "deleted", "files"})
        self.assertTrue(document["ok"])
        self.assertTrue(document["dryRun"])
        self.assertEqual(document["action"], "report")
        json.dumps(document, sort_keys=True)

    def test_apply_is_not_a_dry_run(self):
        self.assertFalse(retention.Report("apply").document()["dryRun"])

    def test_errors_and_failed_calls_clear_ok_but_unsupported_remote_deletes_do_not(self):
        report = retention.Report("apply")
        report.calls["remoteDeleteUnsupported"] = 3
        self.assertTrue(report.document()["ok"])
        report.calls["failed"] = 1
        self.assertFalse(report.document()["ok"])
        report = retention.Report("apply")
        report.error("remote", "remote_delete_failed")
        self.assertFalse(report.document()["ok"])

    def test_errors_are_deduplicated_and_bounded(self):
        report = retention.Report("apply")
        for _ in range(200):
            report.error("database", "statement_failed")
        for index in range(200):
            report.error("filesystem", f"code_{index}")
        self.assertLessEqual(len(report.document()["errors"]), 50)

    def test_a_failed_run_still_prints_exactly_one_json_object(self):
        captured = subprocess.run([sys.executable, str(ROOT / "infra" / "retention.py"), "report",
                                   "--env-file", "/nonexistent/vodog/app.env"],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(captured.returncode, 1)
        document = json.loads(captured.stdout)
        self.assertFalse(document["ok"])
        self.assertEqual(document["errors"], [{"failureType": "config", "failureCode": "env_unreadable"}])
        self.assertEqual(captured.stdout.count("\n"), 1)

    def test_report_is_the_default_action(self):
        args = retention.parser().parse_args([])
        self.assertEqual(args.action, "report")
        self.assertEqual(args.root, retention.DEFAULT_ROOT)
        self.assertEqual(args.env_file, retention.DEFAULT_ENV_FILE)
        self.assertEqual(args.max_calls, 500)
        self.assertEqual(args.max_rows, 50000)
        self.assertEqual(args.call_id, [])
        self.assertFalse(args.no_remote)
        self.assertFalse(args.skip_housekeeping)

    def test_repeatable_call_ids_and_exclusive_cutoffs(self):
        args = retention.parser().parse_args(["apply", "--call-id", "a", "--call-id", "b"])
        self.assertEqual(args.call_id, ["a", "b"])
        for conflict in (["--calls-older-than-days", "1", "--calls-before", "2026-01-01"],
                         ["--sms-older-than-days", "1", "--sms-before", "2026-01-01"]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                retention.parser().parse_args(conflict)

    def test_report_never_writes(self):
        """`report` uses a read-only session and the write path refuses to run in it."""
        database = retention.Database("postgres://u:p@127.0.0.1:1/db", read_only=True)
        with self.assertRaises(retention.RetentionError) as caught:
            database.write_count("DELETE FROM sms_messages")
        self.assertEqual(caught.exception.code, "write_in_report_mode")

    def test_report_never_deletes_files(self):
        with tempfile.TemporaryDirectory() as base:
            call = str(uuid.uuid4())
            paths = {"recording": os.path.join(base, "recordings"), "pixel": None, "ledger": None}
            manifest = write_tree(paths["recording"], f"{call}/manifest.json", b"{}")
            report = retention.Report("report")
            for target in retention.call_file_targets(paths, call):
                report.call_files.add(*retention.remove_directory(target, True))
            self.assertTrue(manifest.exists())
            self.assertEqual(report.document()["calls"]["files"], {"bytes": 2, "dirs": 1})


class Psql:
    def __init__(self, url, binary):
        self.env = retention.database_environment(url, read_only=False)
        self.binary = binary

    def script(self, sql):
        result = subprocess.run([self.binary, "--no-password", "--no-psqlrc", "--tuples-only", "--no-align",
                                 "--set", "ON_ERROR_STOP=1"], env=self.env, input=sql,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=180)
        if result.returncode != 0:
            raise AssertionError("psql failed: " + result.stderr[-2000:])
        return [line for line in result.stdout.splitlines() if line]

    def value(self, sql):
        lines = self.script(sql)
        return lines[-1] if lines else ""


@unittest.skipIf(database_skip_reason() is not None, database_skip_reason() or "")
class DatabaseRetentionTests(unittest.TestCase):
    maxDiff = None

    @classmethod
    def setUpClass(cls):
        cls.binary = psql_binary()
        cls.url = os.environ["TEST_DATABASE_URL"]
        cls.db = Psql(cls.url, cls.binary)
        cls.db.script("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;")
        cls.db.script(SCHEMA.read_text())
        cls.db.script(TRANSCRIPTION_SCHEMA.read_text())
        # S39 tombstone columns (Control owns them in schema.sql); idempotent so the suite
        # stands on its own whichever revision of schema.sql is checked out.
        cls.db.script("ALTER TABLE call_deletion_tombstones "
                      "ADD COLUMN IF NOT EXISTS media_node_id text,"
                      "ADD COLUMN IF NOT EXISTS remote_recording_state text NOT NULL DEFAULT 'pending',"
                      "ADD COLUMN IF NOT EXISTS remote_attempts integer NOT NULL DEFAULT 0,"
                      "ADD COLUMN IF NOT EXISTS remote_last_attempt_at timestamptz;")

    def setUp(self):
        self.db.script("TRUNCATE TABLE users, gateways, call_deletion_tombstones RESTART IDENTITY CASCADE;")
        self.base = tempfile.TemporaryDirectory()
        self.addCleanup(self.base.cleanup)
        self.recording_root = os.path.join(self.base.name, "recordings")
        self.pixel_root = os.path.join(self.base.name, "pixel-archives")
        self.ledger_root = os.path.join(self.base.name, "recording-backups")
        for path in (self.recording_root, self.pixel_root, self.ledger_root):
            os.makedirs(path, mode=0o700, exist_ok=True)
        self.env_file = os.path.join(self.base.name, "app.env")
        Path(self.env_file).write_text(
            f"DATABASE_URL={self.url}\nRECORDING_ROOT={self.recording_root}\n"
            f"PIXEL_ARCHIVE_ROOT={self.pixel_root}\nMEDIA_DEFAULT_NODE_ID=relay-primary\n")
        os.chmod(self.env_file, 0o600)

    def run_retention(self, *arguments):
        command = [sys.executable, str(ROOT / "infra" / "retention.py"), *arguments,
                   "--env-file", self.env_file, "--root", self.ledger_root, "--no-remote"]
        environment = {**os.environ, "PATH": os.path.dirname(self.binary) + os.pathsep + os.environ.get("PATH", "")}
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                timeout=300, env=environment)
        self.assertEqual(result.stdout.count("\n"), 1, result.stdout)
        document = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0 if document["ok"] else 1)
        return document

    def seed_call(self, ended_days_ago=2, media_node_id="relay-primary"):
        ids = {name: str(uuid.uuid4()) for name in
               ("user", "gateway", "sim", "session", "call", "command", "registration", "delivery")}
        self.db.script(f"""
          INSERT INTO users(id,email,password_hash) VALUES('{ids['user']}','owner-{ids['user']}@example.com','x');
          INSERT INTO gateways(id,name,device_epoch,command_sequence) VALUES('{ids['gateway']}','pixel',3,100);
          INSERT INTO sims(id,gateway_id,label) VALUES('{ids['sim']}','{ids['gateway']}','sim-a');
          INSERT INTO sessions(id,user_id,access_hash,client_type,access_expires_at)
            VALUES('{ids['session']}','{ids['user']}','hash-{ids['session']}','web',now()+interval '1 day');
          INSERT INTO call_records(id,gateway_id,sim_id,snapshot_owner_id,direction,state,generation,
                                   started_at,answered_at,ended_at,mode_snapshot,media_node_id,media_epoch)
            VALUES('{ids['call']}','{ids['gateway']}','{ids['sim']}','{ids['user']}','incoming','ended',3,
                   now()-interval '{ended_days_ago} days 5 minutes', now()-interval '{ended_days_ago} days 4 minutes',
                   now()-interval '{ended_days_ago} days','normal','{media_node_id}',1);
          INSERT INTO commands(id,gateway_id,call_id,generation,sequence,kind,payload,expires_at,status,created_at)
            VALUES('{ids['command']}','{ids['gateway']}','{ids['call']}',3,5,'hangup','{{}}',
                   now()-interval '{ended_days_ago} days','acked',now()-interval '{ended_days_ago} days');
          INSERT INTO gateway_command_replay_receipts(command_id,fingerprint,status,result)
            VALUES('{ids['command']}','fingerprint-5','acked','{{}}');
          INSERT INTO gateway_command_replay_horizons(gateway_id,generation,proposed_floor,proposed_revision,
                                                      committed_floor,committed_revision,state)
            VALUES('{ids['gateway']}',3,24,7,24,7,'ready');
          INSERT INTO push_registrations(id,installation_id,user_id,session_id,environment,device_name,apns_token)
            VALUES('{ids['registration']}','{uuid.uuid4()}','{ids['user']}','{ids['session']}','production','iphone','token');
          INSERT INTO push_deliveries(id,call_id,registration_id,session_id)
            VALUES('{ids['delivery']}','{ids['call']}','{ids['registration']}','{ids['session']}');
          INSERT INTO android_push_deliveries(call_id,registration_id,session_id,event)
            VALUES('{ids['call']}','{ids['registration']}','{ids['session']}','call.incoming');
          INSERT INTO owner_blocked_numbers(owner_user_id,canonical_key,remote_number,source_call_id)
            VALUES('{ids['user']}','12025550101','+12025550101','{ids['call']}');
          INSERT INTO recording_capture_bindings(call_id,gateway_id,snapshot_owner_id,device_call_id,
                                                 telecom_creation_time_millis,capture_generation,media_node_id,media_epoch)
            VALUES('{ids['call']}','{ids['gateway']}','{ids['user']}','device-call-1',1757000000000,3,'relay-primary',1);
          INSERT INTO pixel_recording_archives(call_id,capture_binding_id,gateway_id,snapshot_owner_id,
                                               client_manifest_sha256,client_manifest,state)
            SELECT '{ids['call']}',b.id,'{ids['gateway']}','{ids['user']}',repeat('a',64),'{{}}','complete'
              FROM recording_capture_bindings b WHERE b.call_id='{ids['call']}';
          INSERT INTO transcript_jobs(call_id,snapshot_owner_id,manifest,manifest_fingerprint)
            VALUES('{ids['call']}','{ids['user']}','{{}}',repeat('b',64));
        """)
        call = ids["call"]
        write_tree(self.recording_root, f"{call}/manifest.json", b"{}")
        write_tree(self.recording_root, f"{call}/remote_original.ogg", b"0123456789")
        write_tree(self.pixel_root, f"{call}/{uuid.uuid4()}/manifest.json", b"{}")
        write_tree(self.ledger_root, f"{media_node_id}/{call}/1/manifest.json", b"{}")
        return ids

    def test_apply_deletes_the_call_row_and_every_local_file_without_touching_the_replay_ledger(self):
        ids = self.seed_call()
        report = self.run_retention("report", "--calls-older-than-days", "1")
        self.assertEqual(report["calls"]["candidates"], 1)
        self.assertEqual(report["calls"]["deleted"], 0)
        self.assertTrue(report["dryRun"])
        self.assertGreater(report["calls"]["files"]["dirs"], 0)
        self.assertEqual(self.db.value(f"SELECT count(*) FROM call_records WHERE id='{ids['call']}'"), "1")
        self.assertTrue(os.path.isdir(os.path.join(self.recording_root, ids["call"])))

        document = self.run_retention("apply", "--calls-older-than-days", "1")
        self.assertTrue(document["ok"], document)
        self.assertEqual(document["calls"], {"candidates": 1, "deleted": 1, "failed": 0, "remoteDeleteUnsupported": 0,
                                             "files": {"bytes": document["calls"]["files"]["bytes"], "dirs": 3}})
        # 12 bytes under RECORDING_ROOT, 2 under PIXEL_ARCHIVE_ROOT, 2 in the backup ledger.
        self.assertEqual(document["calls"]["files"]["bytes"], 16)

        self.assertEqual(self.db.value(f"SELECT count(*) FROM call_records WHERE id='{ids['call']}'"), "0")
        self.assertFalse(os.path.exists(os.path.join(self.recording_root, ids["call"])))
        self.assertFalse(os.path.exists(os.path.join(self.pixel_root, ids["call"])))
        self.assertFalse(os.path.exists(os.path.join(self.ledger_root, "relay-primary", ids["call"])))
        self.assertTrue(os.path.isdir(os.path.join(self.ledger_root, "relay-primary")))

        # commands survives with a null call_id; the replay evidence ledger is untouched.
        self.assertEqual(self.db.value(f"SELECT count(*) FROM commands WHERE id='{ids['command']}' AND call_id IS NULL"), "1")
        self.assertEqual(self.db.value(f"SELECT count(*) FROM gateway_command_replay_receipts WHERE command_id='{ids['command']}'"), "1")
        self.assertEqual(self.db.value(f"SELECT committed_floor||'/'||committed_revision||'/'||state "
                                       f"FROM gateway_command_replay_horizons WHERE gateway_id='{ids['gateway']}'"), "24/7/ready")
        # Push deliveries cascade, the blocklist entry survives with a null source.
        self.assertEqual(self.db.value("SELECT count(*) FROM push_deliveries"), "0")
        self.assertEqual(self.db.value("SELECT count(*) FROM android_push_deliveries"), "0")
        self.assertEqual(self.db.value("SELECT count(*) FROM owner_blocked_numbers WHERE source_call_id IS NULL"), "1")
        for table in ("recording_capture_bindings", "pixel_recording_archives", "transcript_jobs"):
            self.assertEqual(self.db.value(f"SELECT count(*) FROM {table}"), "0", table)

    def test_a_call_id_scope_deletes_exactly_that_call(self):
        first, second = self.seed_call(), self.seed_call()
        document = self.run_retention("apply", "--call-id", first["call"])
        self.assertEqual(document["calls"]["deleted"], 1, document)
        self.assertEqual(self.db.value(f"SELECT count(*) FROM call_records WHERE id='{first['call']}'"), "0")
        self.assertEqual(self.db.value(f"SELECT count(*) FROM call_records WHERE id='{second['call']}'"), "1")
        self.assertTrue(os.path.isdir(os.path.join(self.recording_root, second["call"])))

    def test_an_ineligible_named_call_is_reported_not_silently_skipped(self):
        ids = self.seed_call()
        self.db.script(f"UPDATE call_records SET state='active' WHERE id='{ids['call']}';")
        document = self.run_retention("report", "--call-id", ids["call"])
        self.assertFalse(document["ok"])
        self.assertEqual(document["calls"]["candidates"], 0)
        self.assertIn({"failureType": "database", "failureCode": "call_not_eligible"}, document["errors"])
        unknown = self.run_retention("report", "--call-id", str(uuid.uuid4()))
        self.assertIn({"failureType": "database", "failureCode": "call_not_eligible"}, unknown["errors"])

    def test_ineligible_calls_are_never_selected(self):
        ids = self.seed_call()
        self.db.script(f"INSERT INTO gateway_call_locks(gateway_id,call_id,generation) "
                       f"VALUES('{ids['gateway']}','{ids['call']}',3);")
        self.assertEqual(self.run_retention("report", "--calls-older-than-days", "1")["calls"]["candidates"], 0)
        self.db.script(f"DELETE FROM gateway_call_locks WHERE call_id='{ids['call']}';"
                       f"INSERT INTO media_close_jobs(call_id) VALUES('{ids['call']}');")
        self.assertEqual(self.run_retention("report", "--calls-older-than-days", "1")["calls"]["candidates"], 0)
        self.db.script(f"UPDATE media_close_jobs SET completed_at=now() WHERE call_id='{ids['call']}';"
                       f"UPDATE commands SET status='pending' WHERE call_id='{ids['call']}';")
        self.assertEqual(self.run_retention("report", "--calls-older-than-days", "1")["calls"]["candidates"], 0)
        self.db.script(f"UPDATE commands SET status='acked' WHERE call_id='{ids['call']}';"
                       f"UPDATE call_records SET state='active' WHERE id='{ids['call']}';")
        self.assertEqual(self.run_retention("report", "--calls-older-than-days", "1")["calls"]["candidates"], 0)
        self.db.script(f"UPDATE call_records SET state='ended' WHERE id='{ids['call']}';")
        self.assertEqual(self.run_retention("report", "--calls-older-than-days", "1")["calls"]["candidates"], 1)
        # A call that ended inside the last hour is never eligible even with a wide cutoff.
        self.db.script(f"UPDATE call_records SET ended_at=now()-interval '5 minutes' WHERE id='{ids['call']}';")
        self.assertEqual(self.run_retention("report", "--calls-older-than-days", "1")["calls"]["candidates"], 0)

    def test_an_unfinished_pixel_archive_pins_its_call(self):
        ids = self.seed_call()
        for busy in ("uploading", "verifying"):
            self.db.script(f"UPDATE pixel_recording_archives SET state='{busy}' WHERE call_id='{ids['call']}';")
            self.assertEqual(self.run_retention("report", "--calls-older-than-days", "1")["calls"]["candidates"],
                             0, busy)
        for settled in ("complete", "rejected"):
            self.db.script(f"UPDATE pixel_recording_archives SET state='{settled}' WHERE call_id='{ids['call']}';")
            self.assertEqual(self.run_retention("report", "--calls-older-than-days", "1")["calls"]["candidates"],
                             1, settled)

    def test_an_unsettled_ai_run_pins_its_call(self):
        ids = self.seed_call()
        self.db.script(
            f"INSERT INTO ai_call_runs(call_id,gateway_id,snapshot_owner_id,device_generation,media_epoch,"
            f"mode_snapshot,settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,"
            f"trigger_at,state) VALUES('{ids['call']}','{ids['gateway']}','{ids['user']}',3,1,'ai',1,1,45,"
            f"now()-interval '2 days','active');")
        for busy in ("pending", "preparing", "answer_committed", "awaiting_active", "active",
                     "ending", "reconcile_unknown"):
            self.db.script(f"UPDATE ai_call_runs SET state='{busy}' WHERE call_id='{ids['call']}';")
            self.assertEqual(self.run_retention("report", "--calls-older-than-days", "1")["calls"]["candidates"],
                             0, busy)
        for settled in ("ended", "failed_before_answer", "lost_race"):
            self.db.script(f"UPDATE ai_call_runs SET state='{settled}' WHERE call_id='{ids['call']}';")
            self.assertEqual(self.run_retention("report", "--calls-older-than-days", "1")["calls"]["candidates"],
                             1, settled)
        # The run cascades with the call rather than blocking the delete.
        self.assertEqual(self.run_retention("apply", "--calls-older-than-days", "1")["calls"]["deleted"], 1)
        self.assertEqual(self.db.value("SELECT count(*) FROM ai_call_runs"), "0")

    def test_a_named_call_pinned_by_an_unfinished_archive_is_reported(self):
        ids = self.seed_call()
        self.db.script(f"UPDATE pixel_recording_archives SET state='uploading' WHERE call_id='{ids['call']}';")
        document = self.run_retention("report", "--call-id", ids["call"])
        self.assertFalse(document["ok"])
        self.assertIn({"failureType": "database", "failureCode": "call_not_eligible"}, document["errors"])

    def test_a_remote_hosted_call_still_has_its_local_copies_removed(self):
        ids = self.seed_call(media_node_id="relay-secondary")
        document = self.run_retention("apply", "--call-id", ids["call"])
        self.assertTrue(document["ok"], document)
        self.assertEqual(document["calls"]["deleted"], 1)
        # --no-remote, so the relay-secondary node is never contacted and nothing is counted unsupported.
        self.assertEqual(document["calls"]["remoteDeleteUnsupported"], 0)
        self.assertFalse(os.path.exists(os.path.join(self.recording_root, ids["call"])))
        self.assertFalse(os.path.exists(os.path.join(self.ledger_root, "relay-secondary", ids["call"])))

    def seed_tombstone(self, node="relay-secondary", state="pending", attempts=0, age="1 hour"):
        call = str(uuid.uuid4())
        self.db.script(
            f"INSERT INTO call_deletion_tombstones(call_id,gateway_id,gateway_generation,previously_verified,"
            f"previously_complete,deleted_at,media_node_id,remote_recording_state,remote_attempts) "
            f"VALUES('{call}','{uuid.uuid4()}',3,false,false,now()-interval '{age}','{node}','{state}',{attempts});")
        return call

    def test_only_unsettled_recent_remote_tombstones_are_retry_candidates(self):
        pending = self.seed_tombstone()
        self.seed_tombstone(node="relay-primary")                                        # hosted here
        self.seed_tombstone(attempts=retention.REMOTE_RETRY_MAX_ATTEMPTS)      # attempts exhausted
        self.seed_tombstone(age="40 days")                                     # outside the window
        self.seed_tombstone(state="deleted")                                   # already settled
        # A call retention deletes itself leaves a tombstone with no node, which is not remote.
        self.run_retention("apply", "--call-id", self.seed_call()["call"])

        document = self.run_retention("report")
        self.assertEqual(document["remoteRetries"],
                         {"candidates": 1, "deleted": 0, "unsupported": 0, "failed": 0, "retried": 0}, document)
        # `--no-remote` counts the backlog and writes nothing.
        applied = self.run_retention("apply")
        self.assertEqual(applied["remoteRetries"]["candidates"], 1, applied)
        self.assertEqual(applied["remoteRetries"]["retried"], 0)
        self.assertEqual(self.db.value("SELECT remote_attempts::text||'/'||remote_recording_state||'/'||"
                                       "coalesce(remote_last_attempt_at::text,'never') "
                                       f"FROM call_deletion_tombstones WHERE call_id='{pending}'"),
                         "0/pending/never")

    def test_recording_a_remote_answer_settles_exactly_one_tombstone(self):
        call, other = self.seed_tombstone(), self.seed_tombstone()
        db = retention.Database(self.url, read_only=False, psql=self.binary)
        self.assertEqual(retention.record_remote_state(db, call, "deleted"), 1)
        self.assertEqual(self.db.value("SELECT remote_recording_state||'/'||remote_attempts||'/'||"
                                       "(remote_last_attempt_at IS NOT NULL) FROM call_deletion_tombstones "
                                       f"WHERE call_id='{call}'"), "deleted/1/true")
        self.assertEqual(self.db.value("SELECT remote_recording_state||'/'||remote_attempts "
                                       f"FROM call_deletion_tombstones WHERE call_id='{other}'"), "pending/0")
        # A proof that was already trimmed is not an error.
        self.assertEqual(retention.record_remote_state(db, str(uuid.uuid4()), "deleted"), 0)

    def test_orphan_sweep_reclaims_unreferenced_directories_only(self):
        ids = self.seed_call()
        orphan = str(uuid.uuid4())
        write_tree(self.recording_root, f"{orphan}/manifest.json", b"{}")
        fresh = str(uuid.uuid4())
        write_tree(self.recording_root, f"{fresh}/remote_original.ogg", b"in flight")
        write_tree(self.ledger_root, f"relay-secondary/{orphan}/1/manifest.json", b"{}")
        os.mkdir(os.path.join(self.recording_root, "not-a-uuid"))

        report = self.run_retention("report")
        self.assertEqual(report["orphans"]["candidates"], 2)
        self.assertEqual(report["orphans"]["deleted"], 0)
        self.assertTrue(os.path.isdir(os.path.join(self.recording_root, orphan)))

        document = self.run_retention("apply")
        self.assertEqual(document["orphans"]["candidates"], 2, document)
        self.assertEqual(document["orphans"]["deleted"], 2)
        self.assertFalse(os.path.exists(os.path.join(self.recording_root, orphan)))
        self.assertFalse(os.path.exists(os.path.join(self.ledger_root, "relay-secondary", orphan)))
        self.assertTrue(os.path.isdir(os.path.join(self.recording_root, fresh)))
        self.assertTrue(os.path.isdir(os.path.join(self.recording_root, "not-a-uuid")))
        self.assertTrue(os.path.isdir(os.path.join(self.recording_root, ids["call"])))

    def test_housekeeping_respects_every_threshold(self):
        ids = self.seed_call()
        gateway = ids["gateway"]
        self.db.script(f"""
          INSERT INTO device_events(gateway_id,event_id,event_type,resource_id,payload,created_at)
            VALUES('{gateway}','{uuid.uuid4()}','telecom.snapshot','{uuid.uuid4()}','{{}}',now()-interval '8 days'),
                  ('{gateway}','{uuid.uuid4()}','telecom.snapshot','{uuid.uuid4()}','{{}}',now()-interval '6 days'),
                  ('{gateway}','{uuid.uuid4()}','call.incoming','{uuid.uuid4()}','{{}}',now()-interval '100 days'),
                  ('{gateway}','{uuid.uuid4()}','call.incoming','{uuid.uuid4()}','{{}}',now()-interval '80 days');
          INSERT INTO idempotency_requests(user_id,operation,idem_key,request_hash,resource_type,resource_id,created_at)
            VALUES('{ids['user']}','dial','old','h','call','{uuid.uuid4()}',now()-interval '8 days'),
                  ('{ids['user']}','dial','new','h','call','{uuid.uuid4()}',now()-interval '1 day');
          INSERT INTO webauthn_challenges(user_id,purpose,challenge,expires_at)
            VALUES('{ids['user']}','register','expired-challenge',now()-interval '1 hour'),
                  ('{ids['user']}','register','live-challenge',now()+interval '1 hour');
          INSERT INTO device_pairing_codes(gateway_id,code_hash,expires_at,consumed_at,created_by)
            VALUES('{gateway}','hash-expired',now()-interval '1 hour',NULL,'{ids['user']}'),
                  ('{gateway}','hash-consumed',now()+interval '1 hour',now(),'{ids['user']}'),
                  ('{gateway}','hash-live',now()+interval '1 hour',NULL,'{ids['user']}');
        """)
        report = self.run_retention("report")
        self.assertEqual(report["housekeeping"]["device_events_telecom_snapshot"], {"candidates": 1, "deleted": 0})
        self.assertEqual(report["housekeeping"]["device_events_other"], {"candidates": 1, "deleted": 0})
        self.assertEqual(report["housekeeping"]["idempotency_requests"], {"candidates": 1, "deleted": 0})
        self.assertEqual(report["housekeeping"]["webauthn_challenges"], {"candidates": 1, "deleted": 0})
        self.assertEqual(report["housekeeping"]["device_pairing_codes"], {"candidates": 2, "deleted": 0})

        document = self.run_retention("apply")
        self.assertEqual(document["housekeeping"]["device_events_telecom_snapshot"]["deleted"], 1)
        self.assertEqual(document["housekeeping"]["device_events_other"]["deleted"], 1)
        self.assertEqual(document["housekeeping"]["idempotency_requests"]["deleted"], 1)
        self.assertEqual(document["housekeeping"]["webauthn_challenges"]["deleted"], 1)
        self.assertEqual(document["housekeeping"]["device_pairing_codes"]["deleted"], 2)
        self.assertEqual(self.db.value("SELECT count(*) FROM device_events"), "2")
        self.assertEqual(self.db.value("SELECT count(*) FROM idempotency_requests"), "1")
        self.assertEqual(self.db.value("SELECT challenge FROM webauthn_challenges"), "live-challenge")
        self.assertEqual(self.db.value("SELECT code_hash FROM device_pairing_codes"), "hash-live")
        self.assertEqual(self.run_retention("apply", "--skip-housekeeping")["housekeeping"], {})

    def test_commands_below_the_floor_are_retired_and_nothing_else_is(self):
        ids = self.seed_call()
        gateway = ids["gateway"]
        kept = ("below_recent", "at_floor", "above_floor", "other_epoch")
        rows = [("below_old_a", 10, 3, "60 days"), ("below_old_b", 11, 3, "60 days"),
                ("below_recent", 12, 3, "2 days"), ("at_floor", 24, 3, "60 days"),
                ("above_floor", 30, 3, "60 days"), ("other_epoch", 7, 2, "60 days")]
        command_ids = {}
        for name, sequence, generation, age in rows:
            command_ids[name] = str(uuid.uuid4())
            self.db.script(
                f"INSERT INTO commands(id,gateway_id,generation,sequence,kind,payload,expires_at,status,created_at) "
                f"VALUES('{command_ids[name]}','{gateway}',{generation},{sequence},'hangup','{{}}',"
                f"now()-interval '{age}','acked',now()-interval '{age}');"
                f"INSERT INTO gateway_command_replay_receipts(command_id,fingerprint,status,result) "
                f"VALUES('{command_ids[name]}','fingerprint-{name}','acked','{{}}');")
        # A retained command that another NO ACTION foreign key still points at.
        pinned = str(uuid.uuid4())
        self.db.script(
            f"INSERT INTO commands(id,gateway_id,generation,sequence,kind,payload,expires_at,status,created_at) "
            f"VALUES('{pinned}','{gateway}',3,4,'answer','{{}}',now()-interval '60 days','acked',now()-interval '60 days');"
            f"INSERT INTO ai_call_runs(call_id,gateway_id,snapshot_owner_id,device_generation,media_epoch,mode_snapshot,"
            f"settings_version_snapshot,assignment_version_snapshot,timeout_seconds_snapshot,trigger_at,answer_command_id) "
            f"VALUES('{ids['call']}','{gateway}','{ids['user']}',3,1,'ai',1,1,45,now()-interval '2 days','{pinned}');")

        report = self.run_retention("report")
        self.assertEqual(report["housekeeping"]["commands"], {"candidates": 2, "deleted": 0})
        self.assertEqual(report["housekeeping"]["gateway_command_replay_receipts"], {"candidates": 2, "deleted": 0})

        document = self.run_retention("apply")
        self.assertEqual(document["housekeeping"]["commands"]["deleted"], 2, document)
        self.assertEqual(document["housekeeping"]["gateway_command_replay_receipts"]["deleted"], 2)
        for name in ("below_old_a", "below_old_b"):
            self.assertEqual(self.db.value(f"SELECT count(*) FROM commands WHERE id='{command_ids[name]}'"), "0", name)
        for name in kept:
            self.assertEqual(self.db.value(f"SELECT count(*) FROM commands WHERE id='{command_ids[name]}'"), "1", name)
        # Below the floor and old enough, but an ai_call_runs row still points at it (NO ACTION).
        self.assertEqual(self.db.value(f"SELECT count(*) FROM commands WHERE id='{pinned}'"), "1")
        self.assertEqual(self.db.value(f"SELECT committed_floor FROM gateway_command_replay_horizons "
                                       f"WHERE gateway_id='{gateway}' AND generation=3"), "24")
        # Four seeded receipts plus the one belonging to the still-present seeded hangup command.
        self.assertEqual(self.db.value("SELECT count(*) FROM gateway_command_replay_receipts"), "5")

    def test_a_quarantined_or_stale_horizon_retires_nothing(self):
        ids = self.seed_call()
        command = str(uuid.uuid4())
        self.db.script(
            f"UPDATE gateway_command_replay_horizons SET state='quarantined',quarantine_reason='test' "
            f"WHERE gateway_id='{ids['gateway']}';"
            f"INSERT INTO commands(id,gateway_id,generation,sequence,kind,payload,expires_at,status,created_at) "
            f"VALUES('{command}','{ids['gateway']}',3,6,'hangup','{{}}',now()-interval '60 days','acked',now()-interval '60 days');")
        self.assertEqual(self.run_retention("report")["housekeeping"]["commands"]["candidates"], 0)
        self.db.script(f"UPDATE gateway_command_replay_horizons SET state='ready' WHERE gateway_id='{ids['gateway']}';"
                       f"UPDATE gateways SET device_epoch=4 WHERE id='{ids['gateway']}';")
        self.assertEqual(self.run_retention("report")["housekeeping"]["commands"]["candidates"], 0)

    def test_sms_retention_only_touches_terminal_messages(self):
        ids = self.seed_call()
        self.db.script(f"""
          INSERT INTO sms_messages(gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,created_at)
            VALUES('{ids['gateway']}','{ids['sim']}','{ids['user']}','outgoing','+1','old delivered','delivered',now()-interval '10 days'),
                  ('{ids['gateway']}','{ids['sim']}','{ids['user']}','outgoing','+1','old failed','failed',now()-interval '10 days'),
                  ('{ids['gateway']}','{ids['sim']}','{ids['user']}','outgoing','+1','old queued','queued',now()-interval '10 days'),
                  ('{ids['gateway']}','{ids['sim']}','{ids['user']}','outgoing','+1','new delivered','delivered',now()-interval '1 day');
          INSERT INTO sms_interceptions(owner_user_id,sim_id,gateway_id,remote_number,body,message_key,received_at,source,created_at)
            VALUES('{ids['user']}','{ids['sim']}','{ids['gateway']}','+1','blocked','key-old',now()-interval '10 days','gateway',now()-interval '10 days'),
                  ('{ids['user']}','{ids['sim']}','{ids['gateway']}','+1','blocked','key-new',now()-interval '1 day','gateway',now()-interval '1 day');
        """)
        report = self.run_retention("report", "--sms-older-than-days", "5", "--skip-housekeeping")
        self.assertEqual(report["sms"]["sms_messages"], {"candidates": 2, "deleted": 0})
        self.assertEqual(report["sms"]["sms_interceptions"], {"candidates": 1, "deleted": 0})
        document = self.run_retention("apply", "--sms-older-than-days", "5", "--skip-housekeeping")
        self.assertEqual(document["sms"]["sms_messages"]["deleted"], 2)
        self.assertEqual(document["sms"]["sms_interceptions"]["deleted"], 1)
        self.assertEqual(self.db.value("SELECT count(*) FROM sms_messages"), "2")
        self.assertEqual(self.db.value("SELECT count(*) FROM sms_interceptions"), "1")

    def test_deleting_an_sms_leaves_its_command_with_a_null_reference(self):
        ids = self.seed_call()
        sms = str(uuid.uuid4())
        command = str(uuid.uuid4())
        self.db.script(
            f"INSERT INTO sms_messages(id,gateway_id,sim_id,snapshot_owner_id,direction,remote_number,body,state,created_at) "
            f"VALUES('{sms}','{ids['gateway']}','{ids['sim']}','{ids['user']}','outgoing','+1','body','delivered',now()-interval '10 days');"
            f"INSERT INTO commands(id,gateway_id,sms_id,generation,sequence,kind,payload,expires_at,status,created_at) "
            f"VALUES('{command}','{ids['gateway']}','{sms}',3,50,'send_sms','{{\"smsId\":\"{sms}\"}}',"
            f"now()-interval '1 day','acked',now()-interval '1 day');")
        self.run_retention("apply", "--sms-older-than-days", "5", "--skip-housekeeping")
        self.assertEqual(self.db.value(f"SELECT count(*) FROM commands WHERE id='{command}' AND sms_id IS NULL"), "1")
        self.assertEqual(self.db.value(f"SELECT payload->>'smsId' FROM commands WHERE id='{command}'"), sms)

    def test_apply_holds_the_recording_backup_lock(self):
        import fcntl
        lock_path = os.path.join(self.ledger_root, retention.LOCK_NAME)
        with open(lock_path, "a+b") as held:
            os.chmod(lock_path, 0o600)
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            document = self.run_retention("apply")
        self.assertFalse(document["ok"])
        self.assertIn({"failureType": "lock", "failureCode": "job_already_running"}, document["errors"])

    def test_report_needs_no_lock(self):
        import fcntl
        lock_path = os.path.join(self.ledger_root, retention.LOCK_NAME)
        with open(lock_path, "a+b") as held:
            os.chmod(lock_path, 0o600)
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertTrue(self.run_retention("report")["ok"])


if __name__ == "__main__":
    reason = database_skip_reason()
    if reason:
        print(f"# database test skipped: {reason}", file=sys.stderr)
    unittest.main(verbosity=2)
