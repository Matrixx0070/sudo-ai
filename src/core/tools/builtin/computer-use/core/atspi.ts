/**
 * @file core/atspi.ts
 * @description AT-SPI2 accessibility-tree extraction for Linux perception.
 *
 * The Python AT-SPI bindings (gi/Atspi) are the only robust way to read the
 * Linux a11y tree, so we shell to a small inlined Python program via
 * `python3 -c`. Inlining (rather than a sibling .py) means there is no
 * build-time file-copy step — it works identically under tsx and the esbuild
 * bundle.
 *
 * AT-SPI is SESSION-global (not per-display): every app registered on the
 * session a11y bus is visible regardless of which X display it draws on. The
 * caller (PerceptionService) is responsible for intersecting element bounds
 * with the target display's windows when isolation matters.
 *
 * Fail-soft: any environment without bindings / bus prints "[]" and the channel
 * is simply empty — the executor then relies on coordinate/vision grounding.
 */

import { execFile } from 'node:child_process';
import { createLogger } from '../../../../shared/logger.js';
import type { UIElement } from './types.js';

const log = createLogger('computer:atspi');

/** Inlined Python AT-SPI dumper. Emits a JSON array of flattened elements. */
export const ATSPI_DUMP_SCRIPT = String.raw`
import json, os, sys
def main():
    os.environ.setdefault("GTK_MODULES", "gail:atk-bridge")
    os.environ.setdefault("QT_ACCESSIBILITY", "1")
    os.environ.setdefault("ACCESSIBILITY_ENABLED", "1")
    try:
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
    except Exception:
        print("[]"); return 0
    max_elems = int(os.environ.get("CU_ATSPI_MAX", "400"))
    out = []
    def visit(acc, app_name, depth):
        if acc is None or len(out) >= max_elems or depth > 40:
            return
        try: role = acc.get_role_name()
        except Exception: role = "unknown"
        try: name = acc.get_name() or ""
        except Exception: name = ""
        try:
            st = acc.get_state_set(); states = []
            for s in ("visible","showing","enabled","focusable","focused","selected","checked"):
                flag = getattr(Atspi.StateType, s.upper(), None)
                if flag is not None and st.contains(flag): states.append(s)
        except Exception: states = []
        x=y=w=h=-1
        try:
            ext = acc.get_extents(Atspi.CoordType.SCREEN)
            x,y,w,h = int(ext.x),int(ext.y),int(ext.width),int(ext.height)
        except Exception: pass
        interactable = role in ("push button","button","toggle button","check box","radio button",
            "menu item","text","entry","password text","combo box","list item","link","tab","slider",
            "spin button","page tab","icon","label","menu","check menu item","radio menu item")
        if (name or interactable) and w>0 and h>0:
            out.append({"i":len(out),"role":role,"name":name[:120],"states":states,
                        "x":x,"y":y,"w":w,"h":h,"app":app_name})
        try: n = acc.get_child_count()
        except Exception: n = 0
        for k in range(min(n,200)):
            try: child = acc.get_child_at_index(k)
            except Exception: child = None
            visit(child, app_name, depth+1)
    try:
        desktop = Atspi.get_desktop(0); napps = desktop.get_child_count()
    except Exception:
        print("[]"); return 0
    for a in range(napps):
        try:
            app = desktop.get_child_at_index(a); app_name = app.get_name() if app else ""
        except Exception: app, app_name = None, ""
        visit(app, app_name, 0)
        if len(out) >= max_elems: break
    print(json.dumps(out)); return 0
sys.exit(main())
`;

/**
 * Inlined Python that INVOKES an element's accessibility action (structured
 * action, no pixel click). Matches the first actionable element by app + name
 * (+ optional role), then performs its default action (Action iface index 0, or
 * grab_focus for text entries). Prints "OK" / "FAIL:<reason>".
 */
export const ATSPI_ACTION_SCRIPT = String.raw`
import os, sys
def main():
    os.environ.setdefault("GTK_MODULES","gail:atk-bridge"); os.environ.setdefault("QT_ACCESSIBILITY","1")
    try:
        import gi; gi.require_version("Atspi","2.0"); from gi.repository import Atspi
    except Exception as e:
        print("FAIL:no-bindings"); return 0
    want_name=(os.environ.get("CU_MATCH_NAME","") or "").lower()
    want_role=(os.environ.get("CU_MATCH_ROLE","") or "").lower()
    want_app=(os.environ.get("CU_MATCH_APP","") or "").lower()
    hit={"done":False}
    def visit(acc, app_name, depth):
        if acc is None or hit["done"] or depth>40: return
        try: role=acc.get_role_name()
        except Exception: role=""
        try: name=acc.get_name() or ""
        except Exception: name=""
        if want_name and want_name in name.lower() and (not want_role or want_role==role.lower()):
            try:
                act=acc.get_action_iface() if hasattr(acc,"get_action_iface") else acc
                n=act.get_n_actions() if hasattr(act,"get_n_actions") else 0
                if n>0:
                    act.do_action(0); print("OK:action"); hit["done"]=True; return
            except Exception: pass
            try:
                acc.grab_focus(); print("OK:focus"); hit["done"]=True; return
            except Exception: pass
        try: c=acc.get_child_count()
        except Exception: c=0
        for k in range(min(c,200)):
            try: ch=acc.get_child_at_index(k)
            except Exception: ch=None
            visit(ch, app_name, depth+1)
            if hit["done"]: return
    try:
        desk=Atspi.get_desktop(0); na=desk.get_child_count()
    except Exception:
        print("FAIL:no-bus"); return 0
    for a in range(na):
        try: app=desk.get_child_at_index(a); an=app.get_name() if app else ""
        except Exception: app,an=None,""
        if want_app and want_app not in (an or "").lower(): continue
        visit(app, an, 0)
        if hit["done"]: break
    if not hit["done"]: print("FAIL:no-match")
    return 0
sys.exit(main())
`;

export interface InvokeAxActionOptions {
  display: string;
  name: string;
  role?: string;
  app?: string;
  timeoutMs?: number;
  pythonBin?: string;
}

/**
 * Invoke an element's accessibility action directly (structured, no pixel
 * click). Returns true when the AX action/focus succeeded. Fail-soft: false on
 * any error so the caller falls back to coordinate injection.
 */
export function invokeAxAction(opts: InvokeAxActionOptions): Promise<boolean> {
  const { display, name, role, app, timeoutMs = 6000, pythonBin = 'python3' } = opts;
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      DISPLAY: display,
      CU_MATCH_NAME: name,
      CU_MATCH_ROLE: role ?? '',
      CU_MATCH_APP: app ?? '',
    };
    execFile(pythonBin, ['-c', ATSPI_ACTION_SCRIPT], { env, timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(String(stdout || '').startsWith('OK'));
    });
  });
}

export interface DumpAxOptions {
  display: string;
  maxElements?: number;
  timeoutMs?: number;
  pythonBin?: string;
}

/**
 * Dump the AT-SPI tree as flattened {@link UIElement}s. Returns [] on any
 * failure (no bindings, no bus, timeout) — AX is an optional channel.
 */
export function dumpAxTree(opts: DumpAxOptions): Promise<UIElement[]> {
  const { display, maxElements = 400, timeoutMs = 8000, pythonBin = 'python3' } = opts;
  return new Promise((resolve) => {
    const env = { ...process.env, DISPLAY: display, CU_ATSPI_MAX: String(maxElements) };
    execFile(
      pythonBin,
      ['-c', ATSPI_DUMP_SCRIPT],
      { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          log.debug({ err: err.message, display }, 'AX dump failed — treating channel as empty');
          return resolve([]);
        }
        try {
          const parsed = JSON.parse(String(stdout || '[]').trim());
          resolve(Array.isArray(parsed) ? (parsed as UIElement[]) : []);
        } catch (e) {
          log.debug({ err: String(e), display }, 'AX dump parse error — empty');
          resolve([]);
        }
      },
    );
  });
}
