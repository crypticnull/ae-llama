"""
ram-ballast.py - make a big-RAM machine behave like a small one (WORKPLAN 18 P7c step 2g, NEXT UP 5a-4b).

The host twin of scripts/vram-ballast.py. Holds TOTAL - BOX_MB of
PHYSICAL RAM, locked, so everything else on the machine (After Effects,
the desktop, the managed backend and its pinned staging) has to live in
what a BOX_MB machine has. Unlike the VRAM ballast it does NOT sit on top
of what is already in use: a 16 GB user's AE and desktop live inside
their 16 GB too, so whatever does not fit gets paged, exactly as there.

    python scripts/ram-ballast.py --box-mb 16384 --max-sec 1500 --stop-file local/ram.stop

Why LOCKED and not just touched: a touched page is pageable, and under
pressure Windows would page the BALLAST out first and hand its RAM back
to the job being measured, so the constraint would silently evaporate.
VirtualLock pins it; the working-set minimum is raised chunk by chunk so
the lock is allowed. The script reports how much it really locked - a
short lock is printed, never passed off as the requested box.

What it CANNOT fake (write this next to any reading it produced):
- the TOTAL a process reads. psutil/GlobalMemoryStatusEx still report
  the real machine, so anything sized from total RAM (ComfyUI's pinned
  budget is 40 percent of it on Windows) must be told separately;
- the WDDM shared-GPU-memory cap, which Windows sets to half of physical
  RAM at boot.

Exits by itself after --max-sec, and on --stop-file; the OS frees the
locked pages when the process ends however it ends.
"""
import argparse
import ctypes
import ctypes.wintypes as wt
import os
import sys
import time

MB = 1024 * 1024
MEM_COMMIT = 0x1000
MEM_RESERVE = 0x2000
PAGE_READWRITE = 0x04

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.VirtualAlloc.restype = ctypes.c_void_p
k32.VirtualAlloc.argtypes = [ctypes.c_void_p, ctypes.c_size_t, wt.DWORD, wt.DWORD]
k32.VirtualLock.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
k32.GetCurrentProcess.restype = wt.HANDLE
k32.SetProcessWorkingSetSizeEx.argtypes = [wt.HANDLE, ctypes.c_size_t, ctypes.c_size_t, wt.DWORD]
k32.GetProcessWorkingSetSizeEx.argtypes = [wt.HANDLE, ctypes.POINTER(ctypes.c_size_t),
                                           ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(wt.DWORD)]


class MEMSTAT(ctypes.Structure):
    _fields_ = [("dwLength", wt.DWORD), ("dwMemoryLoad", wt.DWORD),
                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]


def memstat():
    m = MEMSTAT()
    m.dwLength = ctypes.sizeof(MEMSTAT)
    k32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--box-mb", type=int, required=True)
    ap.add_argument("--chunk-mb", type=int, default=512)
    ap.add_argument("--max-sec", type=int, default=1500)
    ap.add_argument("--stop-file", default=None)
    a = ap.parse_args()

    m = memstat()
    total_mb = m.ullTotalPhys // MB
    target_mb = total_mb - a.box_mb
    print("host: %d MiB physical, %d available; holding %d MiB for a %d MiB box"
          % (total_mb, m.ullAvailPhys // MB, target_mb, a.box_mb), flush=True)
    if target_mb <= 0:
        print("nothing to hold", flush=True)
        return 0

    proc = k32.GetCurrentProcess()
    mn, mx, fl = ctypes.c_size_t(), ctypes.c_size_t(), wt.DWORD()
    k32.GetProcessWorkingSetSizeEx(proc, ctypes.byref(mn), ctypes.byref(mx), ctypes.byref(fl))
    base_min = mn.value
    locked_mb = 0
    failures = 0
    t0 = time.time()
    while locked_mb < target_mb:
        n = min(a.chunk_mb, target_mb - locked_mb)
        want = base_min + (locked_mb + n) * MB + 64 * MB
        # Soft limits (flags 0): only the minimum matters for VirtualLock.
        if not k32.SetProcessWorkingSetSizeEx(proc, want, want + 256 * MB, 0):
            err = ctypes.get_last_error()
            failures += 1
            if failures > 20:
                print("working-set raise failed (err %d) at %d MiB locked; stopping short"
                      % (err, locked_mb), flush=True)
                break
            time.sleep(0.5)  # let the memory manager trim others, then retry
            continue
        p = k32.VirtualAlloc(None, n * MB, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE)
        if not p:
            print("VirtualAlloc failed (err %d) at %d MiB" % (ctypes.get_last_error(), locked_mb), flush=True)
            break
        ctypes.memset(p, 0xA5, n * MB)  # touch every page
        if not k32.VirtualLock(p, n * MB):
            err = ctypes.get_last_error()
            failures += 1
            print("VirtualLock failed (err %d) at %d MiB" % (err, locked_mb), flush=True)
            if failures > 20:
                break
            time.sleep(0.5)
            continue
        locked_mb += n
        failures = 0
    m = memstat()
    short = target_mb - locked_mb
    print("ram ballast ready: locked %d MiB in %.0fs (%s); %d MiB physical available now"
          % (locked_mb, time.time() - t0,
             "as asked" if short <= 0 else ("SHORT by %d MiB" % short),
             m.ullAvailPhys // MB), flush=True)
    start = time.time()
    while time.time() - start < a.max_sec:
        if a.stop_file and os.path.exists(a.stop_file):
            print("stop file seen", flush=True)
            break
        time.sleep(1)
    print("ram ballast released after %ds" % int(time.time() - start), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
