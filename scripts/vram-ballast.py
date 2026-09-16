"""
vram-ballast.py - make a big card behave like a small one (WORKPLAN 18 P7c step 2f).

Holds TOTAL - CARD_MB of VRAM ON TOP OF what is already in use when it
starts, so the desktop and After Effects keep their real footprint and
whatever comes next (the managed backend) gets exactly what a CARD_MB
card running the same desktop and AE would leave it.

    <managed python> scripts/vram-ballast.py --card-mb 12288 --max-sec 1500

Why a ballast and not ComfyUI's --reserve-vram: --reserve-vram only
changes what ComfyUI's model management BELIEVES is free. Every real
allocation still lands on a 32 GB card, so a job that would spill past a
12 GB card's physical memory - the grind CLAUDE.md forbids shipping
silently - cannot happen and cannot be seen. A ballast takes the memory
away for real: torch.cuda.mem_get_info in the backend reports the small
number, and an allocation beyond it goes where it would on the buyer's
card (the driver's system-memory fallback, or an OOM).

Exits by itself after --max-sec so a pass that dies cannot leave 20 GB
held on the owner's card. Also exits when --stop-file appears.
"""
import argparse
import os
import subprocess
import sys
import time

import torch


def used_mb():
    out = subprocess.check_output(
        ["nvidia-smi", "--query-gpu=memory.used,memory.total",
         "--format=csv,noheader,nounits"], text=True)
    used, total = [int(x) for x in out.strip().splitlines()[0].split(",")]
    return used, total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--card-mb", type=int, required=True)
    ap.add_argument("--max-sec", type=int, default=1500)
    ap.add_argument("--stop-file", default=None)
    a = ap.parse_args()

    before, total = used_mb()
    torch.zeros(1, device="cuda")  # the context counts toward the ballast
    target = before + total - a.card_mb
    held = []
    chunk = 256
    while True:
        used, _ = used_mb()
        missing = target - used
        if missing < 32:
            break
        n = min(chunk, missing)
        # zeros, not empty: a written page is committed on WDDM.
        held.append(torch.zeros(n * 1024 * 1024, dtype=torch.uint8, device="cuda"))
        torch.cuda.synchronize()
    used, _ = used_mb()
    print("ballast ready: %d MiB in use before, %d / %d now; a %d MiB card "
          "with the same desktop has %d left" % (before, used, total,
          a.card_mb, total - used), flush=True)
    start = time.time()
    while time.time() - start < a.max_sec:
        if a.stop_file and os.path.exists(a.stop_file):
            print("stop file seen", flush=True)
            break
        time.sleep(1)
    print("ballast released after %ds" % int(time.time() - start), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
