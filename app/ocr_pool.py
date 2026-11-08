"""Bounded OCR executors with public-API process supervision (Linux/POSIX).

Each slot owns a one-worker ProcessPoolExecutor. Worker initialization creates a
new process group before acknowledging its PID. Tesseract inherits that group:
timeout/close kills the entire group, not just an asyncio future. No executor
private internals, unbounded waiting queue, or user-controlled executable paths.
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ProcessPoolExecutor, TimeoutError as FutureTimeout
from concurrent.futures.process import BrokenProcessPool
import multiprocessing as mp
import os
import queue
import signal
import threading
import time
from dataclasses import dataclass
from typing import Callable


class OCRUnavailable(Exception):
    pass


class OCRBusy(OCRUnavailable):
    pass


class OCRTimeout(OCRUnavailable):
    pass


def _initialize(sender, memory_mb: int) -> None:
    import resource
    os.setsid()
    resource.setrlimit(resource.RLIMIT_AS, (memory_mb * 1024**2,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (120, 120))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024**2,) * 2)
    # A worker only needs its executor IPC descriptors and Tesseract stdio.
    _, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    resource.setrlimit(resource.RLIMIT_NOFILE, (min(128, hard), hard))
    os.environ['OMP_THREAD_LIMIT'] = '1'
    sender.send(os.getpid())
    # Do not execute submitted work until the parent knows which group to kill.
    # Closing the parent pipe / no ACK means timeout during startup: exit, no job.
    try:
        if not sender.poll(5) or sender.recv() is not True:
            os._exit(1)
    except (EOFError, OSError):
        os._exit(1)
    finally:
        sender.close()


def _recognize(raw: bytes) -> tuple[str, float]:
    from app.evidence import ocr_tesseract
    return ocr_tesseract(raw)


@dataclass
class _Slot:
    executor: ProcessPoolExecutor | None = None
    pid: int | None = None
    receiver: object | None = None
    sender: object | None = None
    uses: int = 0


class OCRPool:
    def __init__(self, workers: int = 2, timeout: float = 45, memory_mb: int = 512):
        if os.name != 'posix':
            raise OCRUnavailable('Isolated OCR requires POSIX process groups')
        if not 1 <= workers <= 4 or not 0 < timeout <= 60 or not 256 <= memory_mb <= 1024:
            raise ValueError('Invalid bounded OCR configuration')
        self.timeout, self.memory_mb = timeout, memory_mb
        self._slots = [_Slot() for _ in range(workers)]
        self._available: queue.Queue[_Slot] = queue.Queue(workers)
        for slot in self._slots:
            self._available.put_nowait(slot)
        self._guard = threading.RLock()
        self._closed = False
        self.active = 0

    def _start(self, slot: _Slot) -> None:
        ctx = mp.get_context('spawn')
        slot.receiver, slot.sender = ctx.Pipe(duplex=True)
        slot.executor = ProcessPoolExecutor(max_workers=1, mp_context=ctx,
            initializer=_initialize, initargs=(slot.sender, self.memory_mb))

    def _dispose(self, slot: _Slot) -> None:
        # Call only with _guard held. PID is trusted IPC from initializer, never input.
        if slot.pid:
            try:
                os.killpg(slot.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if slot.executor:
            slot.executor.shutdown(wait=False, cancel_futures=True)
        for conn in (slot.receiver, slot.sender):
            if conn:
                conn.close()
        slot.executor = slot.pid = slot.receiver = slot.sender = None
        slot.uses = 0

    def run(self, raw: bytes, *, operation: Callable = _recognize,
            timeout: float | None = None) -> tuple[str, float]:
        budget = self.timeout if timeout is None else min(60, max(.05, timeout))
        start = time.monotonic()
        with self._guard:
            if self._closed:
                raise OCRUnavailable('OCR pool is closed')
            try:
                slot = self._available.get_nowait()
            except queue.Empty as exc:
                raise OCRBusy('OCR capacity reached') from exc
            self.active += 1
        try:
            with self._guard:
                if self._closed:
                    raise OCRUnavailable('OCR pool is closed')
                if slot.executor is None:
                    self._start(slot)
                future = slot.executor.submit(operation, raw)
                receiver = slot.receiver
                if slot.pid is None:
                    slot.sender.close()
            if slot.pid is None:
                if not receiver.poll(max(.001, budget - (time.monotonic() - start))):
                    raise OCRTimeout('OCR initialization timed out')
                with self._guard:
                    if self._closed:
                        raise OCRUnavailable('OCR pool is closed')
                    slot.pid = receiver.recv()
                    receiver.send(True)
            result = future.result(timeout=max(.001, budget - (time.monotonic() - start)))
            slot.uses += 1
            # Rotate to release native allocations and cumulative CPU budget.
            if slot.uses >= 4:
                with self._guard:
                    self._dispose(slot)
            return result
        except (FutureTimeout, OCRTimeout) as exc:
            with self._guard:
                self._dispose(slot)
            raise OCRTimeout('OCR deadline reached') from exc
        except (BrokenProcessPool, EOFError, OSError, RuntimeError) as exc:
            with self._guard:
                self._dispose(slot)
            raise OCRUnavailable('OCR worker unavailable') from exc
        finally:
            with self._guard:
                self.active -= 1
                if not self._closed:
                    self._available.put_nowait(slot)

    def close(self) -> None:
        with self._guard:
            self._closed = True
            for slot in self._slots:
                self._dispose(slot)


_instance: OCRPool | None = None
_lock = threading.Lock()


def pool() -> OCRPool:
    global _instance
    with _lock:
        if _instance is None:
            _instance = OCRPool(workers=int(os.getenv('OCR_WORKERS', '2')),
                timeout=float(os.getenv('OCR_TIMEOUT_SECONDS', '45')),
                memory_mb=int(os.getenv('OCR_MEMORY_MB', '512')))
        return _instance


async def recognize(raw: bytes) -> tuple[str, float]:
    # Only bounded slots can spawn OCR children. Overload returns immediately.
    return await asyncio.to_thread(pool().run, raw)


def shutdown() -> None:
    global _instance
    with _lock:
        if _instance:
            _instance.close()
            _instance = None
