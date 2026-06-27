#!/usr/bin/env python3
"""
ptc-python-harness.py — Programmatic Tool Calling sandbox (Python variant).

The Python sibling of ptc-worker.cjs. Driven by the Node parent (meta.ptc-python)
over a line-delimited JSON protocol on stdin/stdout:

  - Parent writes ONE init line to our stdin:
        {"type":"init","script":"<python source>"}
  - The script may call tool(name, args) — a SYNCHRONOUS bridge that writes
        {"type":"tool-call","id":N,"name":...,"args":...}
    to our (real) stdout and blocks reading the matching reply line from stdin:
        {"type":"tool-result","id":N,"result":...} | {"id":N,"error":"..."}
  - print(...) is captured (its target sys.stdout is swapped to a buffer), so
    it never pollutes the protocol channel; the script's stdin is emptied so
    input() can't consume protocol replies.
  - On completion we emit ONE final line:
        {"type":"done","stdout":...,"value":<`result` global>,"callLog":[...],"error":null|"..."}

NOT a sealed sandbox — the script has full Python. The Node tool gates this
behind SUDO_PTC_PYTHON + requiresConfirmation and runs us with a scrubbed env /
workspace cwd; bwrap confinement is a documented follow-up. tool() is the
*intended* escape to host capabilities (it goes through the host registry's
normal permission/approval gates).
"""
import sys
import json
import io
import traceback

# Save the REAL protocol channels before the script can rebind sys.stdin/out.
_pin = sys.stdin
_pout = sys.stdout

_call_id = 0
_call_log = []


def _send(obj):
    _pout.write(json.dumps(obj) + "\n")
    _pout.flush()


def _read_line():
    line = _pin.readline()
    if not line:
        raise EOFError("ptc-python: protocol stdin closed")
    return json.loads(line)


def _tool(name, args=None):
    """Synchronous host-tool bridge: one request line, one reply line."""
    global _call_id
    if not isinstance(name, str) or not name:
        raise ValueError("tool(): name must be a non-empty string")
    safe_args = args if isinstance(args, dict) else {}
    cid = _call_id
    _call_id += 1
    _call_log.append({"name": name, "args": safe_args})
    _send({"type": "tool-call", "id": cid, "name": name, "args": safe_args})
    reply = _read_line()
    if reply.get("error"):
        raise RuntimeError(str(reply["error"]))
    return reply.get("result")


def main():
    # 1) read the init line carrying the user script
    init = _read_line()
    script = init.get("script", "") if isinstance(init, dict) else ""

    # 2) isolate the script's stdio: capture its stdout, empty its stdin
    captured = io.StringIO()
    sys.stdout = captured
    sys.stdin = io.StringIO("")

    g = {"tool": _tool, "__name__": "__ptc__"}
    err = None
    value = None
    try:
        exec(script, g)  # noqa: S102 — running model-authored, user-approved code is the feature
        value = g.get("result")
    except BaseException as e:  # noqa: BLE001 — surface ANY script failure to the host
        err = "".join(traceback.format_exception_only(type(e), e)).strip()
    finally:
        sys.stdout = _pout  # restore the protocol channel

    # 3) make the return value JSON-safe (parent must not get arbitrary objects)
    try:
        json.dumps(value)
    except (TypeError, ValueError):
        value = repr(value)

    _send({
        "type": "done",
        "stdout": captured.getvalue(),
        "value": value,
        "callLog": _call_log,
        "error": err,
    })


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # harness/protocol-level failure
        try:
            _send({"type": "done", "stdout": "", "value": None,
                   "callLog": _call_log, "error": "ptc-python harness error: " + str(e)})
        except Exception:
            sys.stderr.write("ptc-python harness fatal: " + str(e) + "\n")
            sys.exit(1)
