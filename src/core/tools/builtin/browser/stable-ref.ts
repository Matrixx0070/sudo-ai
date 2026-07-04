/**
 * @file stable-ref.ts
 * @description Stable element references for autonomous browser control.
 *
 * The problem this solves: Sudo's browser tools historically targeted elements by
 * CSS/text selector or by re-resolving `getByRole(role, {name}).first()` at action
 * time. On pages with duplicate accessible names ("Edit", "Open", "Add to cart")
 * that clicks the WRONG element, and selectors the model guesses from an ARIA tree
 * are brittle. Playwright MCP solves this with stable `aria-ref` handles; Playwright
 * 1.58's public API does not expose that engine, so we implement an equivalent that
 * is deterministic and version-proof.
 *
 * Approach: on snapshot, stamp a `data-sudo-ref="N"` attribute onto every actionable
 * element (across all frames) in one `page.evaluate`, and hand the model a compact
 * `[N] role "name"` listing. Actions then resolve a ref to a Locator via the attribute
 * — an exact, unambiguous handle to the specific node, immune to duplicate names.
 *
 * The attributes persist in the live DOM until the next navigation/re-render, so ref
 * resolution is stateless: we simply scan frames for `[data-sudo-ref="N"]`.
 */

import type { Page, Locator } from 'playwright-core';

/** DOM attribute used to pin a stable ref onto an element. */
export const REF_ATTR = 'data-sudo-ref';

/** A single actionable element captured by a stable-ref snapshot. */
export interface StableRef {
  /** Sequential 1-based ref, unique within the snapshot. */
  ref: number;
  /** Lowercase tag name (a, button, input, …). */
  tag: string;
  /** ARIA role (explicit role attr, else inferred from tag/type). */
  role: string;
  /** Best-effort accessible name (aria-label, label, text, placeholder, …). */
  name: string;
  /** Current value for form controls. */
  value?: string;
  /** True when the control is disabled. */
  disabled?: boolean;
  /** input `type` attribute, when relevant. */
  inputType?: string;
}

/** Result of a stable-ref capture. */
export interface StableRefSnapshot {
  /** All actionable elements, in document order across frames. */
  refs: StableRef[];
  /** Compact `[N] role "name"` listing for LLM targeting. */
  render: string;
}

/**
 * Browser-side stamping routine, serialized into the page via `evaluate`.
 * MUST be self-contained (no closure references) — it runs in the page context.
 *
 * Assigns refs starting at `startAt`, stamps `attr` onto each actionable element,
 * and returns lightweight descriptors. Returns the next free ref via `nextRef` so
 * multiple frames share one monotonic sequence.
 */
/** Result shape returned by the in-page stamping routine. */
interface StampResult {
  items: Array<Omit<StableRef, 'ref'> & { ref: number }>;
  nextRef: number;
}

/**
 * The in-page stamping logic, kept as a plain-JS SOURCE STRING (not a passed
 * function). This is deliberate and load-bearing:
 *
 * Passing a function to frame.evaluate makes Playwright serialize it via
 * `fn.toString()`. Under the prod runtime (`node --import tsx` → esbuild with
 * keepNames), every named function/arrow is wrapped with `__name(...)`; the
 * serialized body then references `__name`, which does NOT exist in the browser
 * page context → the in-page function throws → every frame yields 0 refs. vitest's
 * transform doesn't add that wrapper, so tests passed while prod returned nothing
 * (the "vitest masks prod" ESM/bundler landmine). A string literal's contents are
 * never transformed by the bundler, so evaluating a string is immune.
 *
 * `attr` and `startAt` are interpolated by buildStampSource (Playwright does not
 * pass an arg when the page function is a string), so this stays self-contained.
 */
const STAMP_BODY = `
  var INTERACTIVE_ROLES = new Set(['button','link','textbox','searchbox','combobox','listbox','checkbox','radio','switch','slider','spinbutton','tab','menuitem','menuitemcheckbox','menuitemradio','option','treeitem']);
  function roleForTag(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().toLowerCase();
    var tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'input') {
      var t = (el.type || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
      if (t === 'range') return 'slider';
      if (t === 'hidden') return 'hidden';
      return 'textbox';
    }
    return 'generic';
  }
  function isVisible(el) {
    if (typeof el.checkVisibility === 'function') {
      try { return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch (e) {}
    }
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    var rect = el.getBoundingClientRect();
    return rect.width >= 1 && rect.height >= 1;
  }
  function clip(s) { return s.replace(/\\s+/g, ' ').trim().slice(0, 120); }
  function accessibleName(el) {
    var aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clip(aria);
    var labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      var parts = labelledby.split(/\\s+/).map(function (id) { var n = el.ownerDocument.getElementById(id); return n ? (n.textContent || '') : ''; }).join(' ');
      if (parts.trim()) return clip(parts);
    }
    var id = el.getAttribute('id');
    if (id) {
      var lbl = el.ownerDocument.querySelector('label[for="' + CSS.escape(id) + '"]');
      if (lbl && lbl.textContent && lbl.textContent.trim()) return clip(lbl.textContent);
    }
    var closestLabel = el.closest('label');
    if (closestLabel && closestLabel.textContent && closestLabel.textContent.trim()) return clip(closestLabel.textContent);
    var text = el.textContent;
    if (text && text.trim()) return clip(text);
    var attrs = ['placeholder','alt','title','value','name'];
    for (var k = 0; k < attrs.length; k++) { var v = el.getAttribute(attrs[k]); if (v && v.trim()) return clip(v); }
    return '';
  }
  var SELECTOR = ['a[href]','button','input','select','textarea','summary','[role]','[contenteditable=""]','[contenteditable="true"]','[tabindex]:not([tabindex="-1"])','[onclick]'].join(',');
  var items = [];
  var seen = new Set();
  var els = document.querySelectorAll(SELECTOR);
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (seen.has(el)) continue;
    seen.add(el);
    var role = roleForTag(el);
    if (role === 'hidden' || role === 'generic') continue;
    var tag = el.tagName.toLowerCase();
    var isFormOrLink = tag === 'a' || tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'summary';
    if (!isFormOrLink && !INTERACTIVE_ROLES.has(role) && !el.hasAttribute('onclick') && el.getAttribute('contenteditable') === null) continue;
    if (!isVisible(el)) continue;
    var item = { ref: ref++, tag: tag, role: role, name: accessibleName(el) };
    if (typeof el.value === 'string' && el.value) item.value = el.value.slice(0, 120);
    if (el.disabled) item.disabled = true;
    if (tag === 'input' && el.type) item.inputType = el.type.toLowerCase();
    el.setAttribute(attr, String(item.ref));
    items.push(item);
  }
  return { items: items, nextRef: ref };
`;

/** Build a self-contained, arg-baked IIFE source string for frame.evaluate. */
function buildStampSource(attr: string, startAt: number): string {
  return `(function(){ var attr = ${JSON.stringify(attr)}; var ref = ${startAt}; ${STAMP_BODY} })()`;
}

/**
 * Capture a stable-ref snapshot of the page, stamping `data-sudo-ref` onto every
 * actionable element across all frames. Returns the refs plus a compact rendering.
 *
 * Cross-origin frames are handled: Playwright can `evaluate` inside each `Frame`
 * regardless of origin, so refs cover the whole page, not just the main document.
 */
export async function captureStableRefs(page: Page): Promise<StableRefSnapshot> {
  const refs: StableRef[] = [];
  let next = 1;

  for (const frame of page.frames()) {
    try {
      // Evaluate a SOURCE STRING (not a passed function) — see STAMP_BODY: this
      // is what makes stamping survive the tsx/esbuild prod runtime.
      const { items, nextRef } = await frame.evaluate(buildStampSource(REF_ATTR, next)) as StampResult;
      next = nextRef;
      for (const it of items) refs.push(it as StableRef);
    } catch {
      // A frame may be detached/navigating mid-capture — skip it, keep the rest.
    }
  }

  return { refs, render: renderStableRefs(refs) };
}

/** Render refs as compact `[N] role "name" [value=…]` lines for the model. */
export function renderStableRefs(refs: StableRef[]): string {
  if (refs.length === 0) return '(no actionable elements found)';
  return refs
    .map((r) => {
      const parts = [`[${r.ref}]`, r.role, JSON.stringify(r.name)];
      if (r.inputType && r.inputType !== 'text') parts.push(`type=${r.inputType}`);
      if (r.value !== undefined) parts.push(`value=${JSON.stringify(r.value)}`);
      if (r.disabled) parts.push('disabled');
      return parts.join(' ');
    })
    .join('\n');
}

/**
 * Resolve a stable ref to a Playwright Locator by scanning all frames for the
 * stamped attribute. Stateless — relies on the persisted DOM attribute, so it
 * works across tool calls as long as the page has not re-rendered that element away.
 *
 * @returns the Locator, or null if no element currently carries that ref.
 */
export async function resolveStableRef(page: Page, ref: number): Promise<Locator | null> {
  const sel = `[${REF_ATTR}="${ref}"]`;
  for (const frame of page.frames()) {
    try {
      const loc: Locator = frame.locator(sel);
      if (await loc.count() > 0) return loc.first();
    } catch {
      // detached frame — keep scanning
    }
  }
  return null;
}

/** Type guard: parse a `ref` tool param that may arrive as number or numeric string. */
export function parseRefParam(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = Number(raw.trim());
    return n > 0 ? n : null;
  }
  return null;
}
