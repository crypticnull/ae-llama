"""Harvest raw INPUT_TYPES for named node classes from a local ComfyUI install.

The panel's bundled ComfyUI templates are authored in the UI ("workflow")
format, but /prompt only accepts the API format. Converting between them
needs each node class's ordered input list -- the ComfyUI frontend has it
from /object_info, an offline script does not. This produces that data as
a checked-in file (scripts/comfy-node-defs.json) so the converter, its
test, and CI never need a ComfyUI install.

It imports ComfyUI in-process (no server, no port, no models, --cpu) and
calls INPUT_TYPES() on the classes asked for. Custom-node packs are loaded
so pack-defined classes resolve too.

Usage (from the repo root, on a machine with ComfyUI):

    python scripts/harvest-comfy-node-defs.py \
        --comfy-code  "<...>/ComfyUI-Installs/ComfyUI/ComfyUI" \
        --comfy-base  "%USERPROFILE%/Documents/ComfyUI" \
        --classes-from extension/workflows/AE_LLAMA_H3_I2V_V1.json \
        --out scripts/comfy-node-defs.json

--classes-from may be repeated; each is a UI-format workflow whose node
types are harvested. Node types the install does not define are reported
and written to "missing" rather than silently skipped.
"""

import argparse
import asyncio
import json
import os
import sys


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--comfy-code", required=True,
                   help="directory holding ComfyUI's main.py / nodes.py")
    p.add_argument("--comfy-base", required=True,
                   help="ComfyUI base directory (models, custom_nodes, user)")
    p.add_argument("--extra-model-paths", default=None,
                   help="optional extra_model_paths.yaml")
    p.add_argument("--classes-from", action="append", default=[],
                   help="UI-format workflow JSON to take node types from")
    p.add_argument("--classes", default="",
                   help="extra node types, pipe-separated")
    p.add_argument("--out", required=True)
    return p.parse_args()


def wanted_classes(a):
    names = []
    for f in a.classes_from:
        with open(f, "r", encoding="utf-8") as fh:
            graph = json.load(fh)
        for node in graph.get("nodes", []):
            t = node.get("type")
            if t and t not in names:
                names.append(t)
    for t in a.classes.split("|"):
        if t and t not in names:
            names.append(t)
    return names


def boot(a):
    """Import ComfyUI far enough that NODE_CLASS_MAPPINGS is populated."""
    # chdir FIRST and keep it that way: at least one installed custom-node
    # pack writes its web assets to a path relative to the working directory
    # at import time, and it dumped them into this repo the first time this
    # ran from the repo root. Every path this script touches is absolute by
    # then (see main()), so moving is free.
    os.chdir(a.comfy_code)
    sys.path.insert(0, a.comfy_code)
    sys.argv = [
        "main.py",
        "--base-directory", a.comfy_base,
        "--user-directory", os.path.join(a.comfy_base, "user"),
        "--input-directory", os.path.join(a.comfy_base, "input"),
        "--output-directory", os.path.join(a.comfy_base, "output"),
        "--cpu",
    ]
    if a.extra_model_paths:
        sys.argv += ["--extra-model-paths-config", a.extra_model_paths]

    import comfy.options
    comfy.options.enable_args_parsing()
    from comfy.cli_args import args  # noqa: F401  (parses sys.argv)
    import utils.extra_config
    import folder_paths  # noqa: F401
    if a.extra_model_paths:
        try:
            utils.extra_config.load_extra_path_config(a.extra_model_paths)
        except Exception as e:      # a missing yaml must not sink the run
            print("extra model paths: %s" % e, file=sys.stderr)

    import server
    import nodes
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    server.PromptServer(loop)       # custom nodes expect the instance to exist
    loop.run_until_complete(
        nodes.init_extra_nodes(init_custom_nodes=True, init_api_nodes=False))
    return nodes


def jsonable(o):
    """INPUT_TYPES may hold callables/enums; keep the shape, stringify the rest."""
    try:
        json.dumps(o)
        return o
    except (TypeError, ValueError):
        if isinstance(o, dict):
            return dict((str(k), jsonable(v)) for k, v in o.items())
        if isinstance(o, (list, tuple)):
            return [jsonable(x) for x in o]
        return str(o)


def main():
    a = parse_args()
    a.out = os.path.abspath(a.out)
    a.classes_from = [os.path.abspath(f) for f in a.classes_from]
    if a.extra_model_paths:
        a.extra_model_paths = os.path.abspath(a.extra_model_paths)
    names = wanted_classes(a)
    nodes = boot(a)

    defs = {}
    missing = []
    for name in names:
        cls = nodes.NODE_CLASS_MAPPINGS.get(name)
        if cls is None:
            missing.append(name)
            continue
        try:
            it = cls.INPUT_TYPES()
        except Exception as e:
            missing.append("%s (INPUT_TYPES raised: %s)" % (name, e))
            continue
        defs[name] = {
            "input_types": jsonable(it),
            "output_node": bool(getattr(cls, "OUTPUT_NODE", False)),
        }

    import comfyui_version
    out = {
        "_comment": ("Raw INPUT_TYPES harvested from a real ComfyUI install by "
                     "scripts/harvest-comfy-node-defs.py. Input ORDER is what "
                     "scripts/adapt-workflow.js needs: the UI format stores "
                     "widget values positionally and only names the ones that "
                     "are linked."),
        "comfyui_version": comfyui_version.__version__,
        "class_count": len(nodes.NODE_CLASS_MAPPINGS),
        "missing": missing,
        "defs": defs,
    }
    with open(a.out, "w", encoding="utf-8") as fh:
        # NEVER sort_keys here: input DECLARATION ORDER is the whole payload.
        # Sorting it silently mis-assigns every positional widget value.
        json.dump(out, fh, indent=1)
        fh.write("\n")
    print("wrote %s (%d classes, %d missing)" % (a.out, len(defs), len(missing)))
    if missing:
        print("missing: %s" % ", ".join(missing))


if __name__ == "__main__":
    main()
