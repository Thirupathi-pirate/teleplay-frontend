#!/usr/bin/env python3
"""
HF Wrapper — Generic file backup to Hugging Face Dataset.

Usage:
    python3 sync.py sync      # Push SYNC_FILE to HF Dataset
    python3 sync.py restore   # Pull SYNC_FILE from HF Dataset

Environment variables:
    SYNC_FILE      — Path to the file to back up (required for backup; optional
                     — if unset, both commands exit silently with no error)
    HF_DATASET     — HF Dataset name (e.g. "myapp-backup")
    HF_USERNAME    — HF username (auto-detected from token if unset)
    HF_TOKEN       — HF token with write access to the dataset
    SYNC_INTERVAL  — Seconds between backups (default 300, used by start.sh)
"""

import json
import os
import sys
import tempfile
import logging
import warnings
from datetime import datetime, timezone
from pathlib import Path

warnings.filterwarnings("ignore", category=UserWarning, module="huggingface_hub")

from huggingface_hub import HfApi
from huggingface_hub.utils import RepositoryNotFoundError, EntryNotFoundError

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.WARNING, format="[sync] %(message)s")
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("huggingface_hub").setLevel(logging.WARNING)

# ── Config from env ─────────────────────────────────────────────────────────
SYNC_FILE = os.environ.get("SYNC_FILE", "").strip()
HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()
HF_USERNAME = os.environ.get("HF_USERNAME", "").strip()
HF_DATASET = os.environ.get("HF_DATASET", "").strip()
SYNC_INTERVAL = int(os.environ.get("SYNC_INTERVAL", "300"))

# HF Dataset snapshot filename in the repo
SNAPSHOT_PATH = "snapshots/latest"

# Sync status file written after each operation so the health server
# (/health endpoint) can report live backup status to monitoring.
STATUS_FILE = Path("/tmp/sync-status.json")


def _init_hf():
    """Initialize HfApi and resolve dataset ID. Returns (api, dataset_id) or None."""
    api = HfApi(token=HF_TOKEN)
    username = HF_USERNAME or api.whoami().get("name")
    if not username:
        logger.error("Failed to resolve HF username")
        return None
    return api, f"{username}/{HF_DATASET}"


def _write_status(status: str, message: str, error: str | None = None) -> None:
    now = datetime.now(timezone.utc).isoformat()
    prev = {}
    try:
        if STATUS_FILE.exists():
            prev = json.loads(STATUS_FILE.read_text())
    except Exception:
        pass
    sync_count = prev.get("sync_count", 0)
    if status in ("synced", "restored"):
        sync_count += 1
    data = {
        "status": status,
        "message": message,
        "db_status": "ok" if status not in ("error", "skipped", "failed") else "error",
        "last_sync_time": now if status not in ("error", "skipped", "failed") else prev.get("last_sync_time"),
        "last_error": error,
        "sync_count": sync_count,
        "timestamp": now,
    }
    STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATUS_FILE.write_text(json.dumps(data, indent=2))


def cmd_restore() -> bool:
    """Restore SYNC_FILE from HF Dataset."""
    if not SYNC_FILE:
        logger.info("SYNC_FILE not set — nothing to restore")
        return True
    if not HF_TOKEN:
        logger.warning("HF_TOKEN not set — skipping restore")
        return False
    if not HF_DATASET:
        logger.warning("HF_DATASET not set — skipping restore")
        return False

    try:
        hf = _init_hf()
        if not hf:
            return False
        api, dataset_id = hf

        with tempfile.TemporaryDirectory() as temp_dir:
            try:
                downloaded = api.hf_hub_download(
                    repo_id=dataset_id,
                    repo_type="dataset",
                    filename=SNAPSHOT_PATH,
                    local_dir=temp_dir,
                    local_dir_use_symlinks=False,
                )
            except (RepositoryNotFoundError, EntryNotFoundError):
                logger.info(f"No backup found in {dataset_id} — fresh instance")
                _write_status("success", "No backup found — fresh instance")
                return True

            dest = Path(SYNC_FILE)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(Path(downloaded).read_bytes())
            size_mb = dest.stat().st_size / 1024 / 1024
            logger.info(f"Restored {SYNC_FILE} from HF Dataset ({size_mb:.2f} MB)")
            _write_status("restored", f"Restored {SYNC_FILE} ({size_mb:.2f} MB)")
            return True
    except Exception as e:
        logger.error(f"Restore failed: {e}")
        _write_status("error", "Restore failed", error=str(e))
        return False


def cmd_sync() -> bool:
    """Push SYNC_FILE to HF Dataset."""
    if not SYNC_FILE:
        logger.info("SYNC_FILE not set — nothing to sync")
        return True
    if not HF_TOKEN:
        logger.warning("HF_TOKEN not set — skipping sync")
        return False
    if not HF_DATASET:
        logger.warning("HF_DATASET not set — skipping sync")
        return False

    sync_path = Path(SYNC_FILE)
    if not sync_path.exists():
        logger.warning(f"SYNC_FILE {SYNC_FILE} does not exist — nothing to upload")
        _write_status("skipped", f"SYNC_FILE {SYNC_FILE} does not exist")
        return False

    try:
        hf = _init_hf()
        if not hf:
            return False
        api, dataset_id = hf

        # Create repo if it doesn't exist (idempotent)
        api.create_repo(
            repo_id=dataset_id,
            repo_type="dataset",
            private=True,
            exist_ok=True,
        )

        api.upload_file(
            path_or_fileobj=str(sync_path),
            path_in_repo=SNAPSHOT_PATH,
            repo_id=dataset_id,
            repo_type="dataset",
            commit_message=f"Backup at {datetime.now(timezone.utc).isoformat()}",
        )
        size_mb = sync_path.stat().st_size / 1024 / 1024
        logger.info(f"Synced {SYNC_FILE} ({size_mb:.2f} MB) to {dataset_id}")
        _write_status("synced", f"Synced {SYNC_FILE} ({size_mb:.2f} MB) to {dataset_id}")
        return True
    except Exception as e:
        logger.error(f"Sync failed: {e}")
        _write_status("error", "Sync failed", error=str(e))
        return False


def main():
    if not SYNC_FILE:
        logger.info("SYNC_FILE not set — exiting silently")
        sys.exit(0)

    if len(sys.argv) < 2:
        print("Usage: sync.py {sync|restore}")
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == "sync":
        sys.exit(0 if cmd_sync() else 1)
    elif cmd == "restore":
        sys.exit(0 if cmd_restore() else 1)
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
