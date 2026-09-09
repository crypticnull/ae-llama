"""Run an API-format workflow through ComfyUI's OWN validate_prompt().

Every pass that touches a bundled template has written this by hand and
thrown it away (see WORKPLAN-LOG 2026-08-26, -27, -28), so here it is once.
It answers "is this graph well-formed and does every value exist" -- input
names, types, links, and combo values checked against the real installed
models -- WITHOUT loading a model or rendering a frame. It says nothing
about whether the result looks right; only a real run does that.

It reuses harvest-comfy-node-defs.py's boot(), so the two agree about how
ComfyUI is started (in-process, no server, no port, --cpu).

Usage (from the repo root, on a machine with ComfyUI):

    python scripts/validate-api-workflow.py \
        --comfy-code "<...>/ComfyUI-Installs/ComfyUI/ComfyUI" \
        --comfy-base "%USERPROFILE%/Documents/ComfyUI" \
        --extra-model-paths "%APPDATA%/ComfyUI/extra_models_config.yaml" \
        extension/comfy-workflows/AE_LLAMA_H3_T2V_V1.json

Exit 0 when valid; 1 when not, with every node error printed.
"""

import argparse
import asyncio
import importlib.util
import json
import os
import sys


def load_harvester():
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location(
        "harvest_comfy_node_defs",
        os.path.join(here, "harvest-comfy-node-defs.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--comfy-code", required=True)
    p.add_argument("--comfy-base", required=True)
    p.add_argument("--extra-model-paths", default=None)
    p.add_argument("workflow", help="API-format workflow JSON")
    return p.parse_args()


def main():
    a = parse_args()
    a.workflow = os.path.abspath(a.workflow)
    if a.extra_model_paths:
        a.extra_model_paths = os.path.abspath(a.extra_model_paths)
    with open(a.workflow, "r", encoding="utf-8") as fh:
        prompt = json.load(fh)

    load_harvester().boot(a)      # chdirs into the ComfyUI code directory

    import execution
    result = asyncio.new_event_loop().run_until_complete(
        execution.validate_prompt("adapt-workflow-check", prompt, None))

    valid = result[0]
    print("valid: %s" % valid)
    print("good outputs: %s" % (result[2],))
    if result[1]:
        print("error: %s" % json.dumps(result[1], indent=1, default=str))
    for node_id, err in (result[3] or {}).items():
        print("node %s: %s" % (node_id, json.dumps(err, indent=1, default=str)))
    sys.exit(0 if valid else 1)


if __name__ == "__main__":
    main()
