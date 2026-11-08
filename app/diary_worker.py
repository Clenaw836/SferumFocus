"""Server-side connector daemon. Runs embedded OR as python -m app.diary_worker.

No open phone/browser is required. Durable fair queue, cross-process leases,
portal concurrency limits, fencing, graceful cancellation, bounded backoff.
SQLite deployment is single-host on a shared LOCAL volume, not multi-node.
"""

from __future__ import annotations
import asyncio, logging, os, secrets, time
import random
import sqlite3
from app.connector_store import ConnectorQueue
from app.diary_providers import NetSchoolRegionalAdapter, UnsupportedPortal
from app.diary_vault import EncryptedDiaryVault
from app.grade_watcher import GradeWatcher

logger = logging.getLogger("sferumfocus.diary_worker")


class ConnectorService:
    def __init__(
        self,
        repo,
        *,
        adapter_factory=None,
        notifier=None,
        concurrency=4,
        interval=300,
        catalog=True,
    ):
        if not 1 <= concurrency <= 16:
            raise ValueError("Invalid concurrency")
        self.repo = repo
        self.queue = ConnectorQueue(repo)
        self.vault = EncryptedDiaryVault(repo)
        self.watcher = GradeWatcher(repo, self.vault)
        self.adapter_factory = adapter_factory or self.adapter
        self.notifier = notifier
        self.concurrency = concurrency
        self.interval = min(480, max(60, interval))
        self.catalog = catalog
        self.worker_id = secrets.token_urlsafe(16)

    def adapter(self, conn):
        session = conn["session"]
        if session.get("protocol") == "netschool-native-v1":
            from app.sgo_client import NativeDiaryAdapter
            from app.sgo_directory import Directory

            return NativeDiaryAdapter(Directory(self.repo), session["host_id"])
        return NetSchoolRegionalAdapter(conn["portal"])

    async def poll(self, job):
        uid = job["uid"]
        token = job["lease_token"]
        self.queue.begin(uid, token)
        fence = lambda db: self.queue.valid(db, uid, token)
        try:
            conn = self.vault.get(uid)
            if not conn or not conn["session"]:
                result = {"status": conn["status"] if conn else "revoked"}
            else:
                async with asyncio.timeout(120):
                    result = await self.watcher.sync(
                        uid, self.adapter_factory(conn), fence=fence
                    )
            self.queue.finish(uid, token, result["status"], self.interval)
        except asyncio.CancelledError:
            self.queue.release(uid, token)
            raise
        except UnsupportedPortal:
            conn = self.vault.get(uid)
            if conn and conn["session"]:
                self.vault.set_status(
                    uid,
                    "unsupported_manual",
                    conn["session"]["connection_id"],
                    fence=fence,
                )
            self.queue.finish(uid, token, "unsupported_manual", self.interval)
        except Exception:
            # Exception text/tracebacks may contain secrets or student payloads.
            logger.warning("Connector synchronization failed; safe retry scheduled")
            self.queue.finish(uid, token, "error", self.interval)

    async def cycle(self):
        self.queue.heartbeat(self.worker_id)
        self.queue.reconcile()
        with self.repo.tx() as db:
            db.execute("DELETE FROM diary_handoffs WHERE expires<=?", (time.time(),))
        jobs = self.queue.claim(self.concurrency)
        await asyncio.gather(*(self.poll(job) for job in jobs))
        if self.notifier is not None:
            lock = self.queue.lock("telegram-outbox")
            if lock:
                try:
                    self.watcher.recover_interrupted()
                    async with asyncio.timeout(90):
                        await self.watcher.drain(self.notifier)
                except TimeoutError:
                    logger.warning(
                        "Connector delivery deadline reached; uncertain sends will not be retried blindly"
                    )
                finally:
                    self.queue.unlock("telegram-outbox", lock)
        return len(jobs)

    async def _repeat(self, operation, interval):
        """Daemon scheduling, not a request retry or authentication fallback.

        Retry only SQLite BUSY/LOCKED with a capped delay; programming/schema
        errors remain visible. Each attempt keeps existing durable leases and
        fences. Cancellation interrupts the wait immediately.
        """
        delay = 1.0
        while True:
            try:
                result = await operation()
            except sqlite3.OperationalError as exc:
                code = getattr(exc, "sqlite_errorcode", None)
                transient = code is not None and code & 0xFF in (
                    sqlite3.SQLITE_BUSY,
                    sqlite3.SQLITE_LOCKED,
                )
                # Older SQLite/Python may omit the numeric error code.
                if code is None:
                    transient = str(exc) in {
                        "database is locked",
                        "database table is locked",
                    }
                if not transient:
                    raise
                logger.warning("Connector storage busy; bounded backoff scheduled")
                await asyncio.sleep(delay + random.uniform(0, delay * 0.2))
                delay = min(30.0, delay * 2)
            else:
                delay = 1.0
                await asyncio.sleep(
                    interval(result) if callable(interval) else interval
                )

    async def refresh_catalog(self):
        from app.sgo_resolver import SchoolResolver

        async def refresh_once():
            job = self.queue.catalog_claim()
            if not job:
                return False
            ok = False
            try:
                async with asyncio.timeout(35):
                    out = await SchoolResolver(self.repo).discover(
                        job["host_id"], "", flat_only=True
                    )
                ok = out.get("host_status") == "online"
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("Catalog refresh failed; safe retry scheduled")
            finally:
                self.queue.catalog_finish(job["host_id"], job["token"], ok)
            return True

        await self._repeat(refresh_once, lambda found: 5 if found else 60)

    async def heartbeat(self):
        async def beat_once():
            self.queue.heartbeat(self.worker_id)

        await self._repeat(beat_once, 10)

    async def run(self):
        beat = asyncio.create_task(self.heartbeat())
        catalog = asyncio.create_task(self.refresh_catalog()) if self.catalog else None
        try:
            await self._repeat(self.cycle, 3)
        finally:
            for task in (beat, catalog):
                if task:
                    task.cancel()
            await asyncio.gather(
                *(task for task in (beat, catalog) if task), return_exceptions=True
            )
            self.queue.stop(self.worker_id)


async def run():
    from app.platform_auth import store
    from app.telegram_bot import TelegramNotifier

    try:
        notifier = TelegramNotifier()
    except ValueError:
        notifier = None
    service = ConnectorService(
        store(),
        notifier=notifier,
        interval=int(os.getenv("DIARY_POLL_SECONDS", "300")),
        concurrency=int(os.getenv("CONNECTOR_CONCURRENCY", "4")),
        catalog=os.getenv("CONNECTOR_REFRESH_CATALOG", "1").lower() in {"1", "true"},
    )
    await service.run()


def main():
    from app import config
    from app.deployment import DeploymentPolicy
    from app.platform_auth import enabled
    import signal

    if not enabled():
        raise SystemExit("PLATFORM_AUTH_ENABLED=1 required")
    errors = DeploymentPolicy().errors()
    if errors:
        raise SystemExit("Connector configuration not ready: " + ",".join(errors))

    async def supervised():
        task = asyncio.create_task(run())
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, task.cancel)
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(supervised())


if __name__ == "__main__":
    main()
