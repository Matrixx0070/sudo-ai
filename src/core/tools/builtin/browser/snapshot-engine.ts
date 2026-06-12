/**
 * @file snapshot-engine.ts
 * @description 3-mode snapshot engine for SUDO-AI v4.
 *
 * Inspired by OpenClaw's 3 snapshot styles for browser state representation.
 * Provides three formats for capturing and describing interactive page elements,
 * each optimized for a different consumption model:
 *   1. Numeric — compact numbered refs, ideal for LLM action targeting
 *   2. Role    — grouped by ARIA role, good for structural overview
 *   3. ARIA    — full accessibility tree, faithful to the DOM hierarchy
 *
 * Queries the page via CDP Accessibility protocol, normalizes into SnapshotElement
 * nodes, then renders them in the requested style.
 */
import { CDPManager } from './cdp-manager.js';
import { createLogger } from '../../../shared/logger.js';
import type { Page } from 'playwright-core';

const log = createLogger('snapshot-engine');

// Element roles come from the runtime accessibility tree as plain strings;
// this names Playwright's ARIA role union so getByRole calls can assert it.
type AriaRole = Parameters<Page['getByRole']>[0];

// -- Exported types ------------------------------------------------------------

/** The three snapshot rendering styles. */
export type SnapshotStyle = 'numeric' | 'role' | 'aria';

/** A single interactive / informational element extracted from the page. */
export interface SnapshotElement {
  /** Numeric reference used by numeric-style snapshots and element actions. */
  ref: number;
  /** ARIA role string (button, link, textbox, heading, navigation, etc.). */
  role: string;
  /** Accessible name (from aria-label, aria-labelledby, text content, etc.). */
  name: string;
  /** Current value for inputs / textareas. */
  value?: string;
  /** Optional accessible description. */
  description?: string;
  /** Bounding rectangle in CSS pixels relative to the viewport. */
  bounds?: { x: number; y: number; width: number; height: number };
  /** Nested child elements (used in ARIA tree rendering). */
  children?: SnapshotElement[];
}

/** The complete result of a snapshot capture. */
export interface SnapshotResult {
  style: SnapshotStyle;
  /** Human / LLM-readable snapshot text in the requested format. */
  content: string;
  /** Flat list of all extracted elements (tree children also present here). */
  elements: SnapshotElement[];
  elementCount: number;
  url: string;
  title: string;
  /** ISO-8601 timestamp of when the capture was taken. */
  capturedAt: string;
}

// -- Constants -----------------------------------------------------------------

/** ARIA roles considered interactive — always shown even in numeric mode. */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox',
  'checkbox', 'radio', 'slider', 'spinbutton', 'switch', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'option',
  'scrollbar', 'progressbar', 'meter', 'gridcell',
]);

/** Structural roles included in role-based and ARIA-tree modes. */
const STRUCTURAL_ROLES = new Set([
  'navigation', 'main', 'form', 'heading', 'paragraph', 'list',
  'listitem', 'table', 'row', 'cell', 'banner', 'contentinfo',
  'complementary', 'region', 'dialog', 'alert', 'alertdialog',
  'toolbar', 'menu', 'menubar', 'tabpanel', 'group',
]);

/** All roles worth capturing (union of interactive + structural + document). */
const CAPTURED_ROLES = new Set([...INTERACTIVE_ROLES, ...STRUCTURAL_ROLES, 'document']);

// -- Internal types (not exported) --------------------------------------------

/** Raw CDP Accessibility node shape returned by the protocol. */
interface RawCDPAXNode {
  nodeId: string;
  parentId?: string;
  role: { type: string; value: string };
  name: { type: string; value: string };
  value?: { type: string; value: string };
  description?: { type: string; value: string };
  properties?: Array<{ name: string; value: unknown }>;
}

/** Normalized internal node during tree construction. */
interface RawAXNode {
  role: string; name: string;
  value?: string; description?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  children: RawAXNode[]; rawId: string; parentId?: string;
}

/** Internal stats tracker for snapshot captures. */
interface CaptureStats {
  totalCaptures: number;
  byStyle: Record<SnapshotStyle, number>;
  totalElements: number; totalTimeMs: number;
}

// -- SnapshotEngine ------------------------------------------------------------

/**
 * 3-mode snapshot engine that captures browser page state in different text
 * representations. Each style is tailored for a specific use case:
 * - numeric: compact [N] refs — ideal for "click [3]" agent interactions
 * - role: grouped by ARIA role — useful for structural scanning
 * - aria: full hierarchical tree — faithful to DOM, best for deep understanding
 */
export class SnapshotEngine {
  private cdp: CDPManager;
  /** Flat index of elements by ref, populated after each capture. */
  private elementIndex = new Map<number, SnapshotElement>();
  private stats: CaptureStats = {
    totalCaptures: 0, byStyle: { numeric: 0, role: 0, aria: 0 },
    totalElements: 0, totalTimeMs: 0,
  };

  constructor(cdpManager: CDPManager) {
    this.cdp = cdpManager;
    log.info('SnapshotEngine initialized');
  }

  // -- Public API ---------------------------------------------------------------

  /** Capture a page snapshot in the specified style (defaults to numeric). */
  async capture(style: SnapshotStyle = 'numeric'): Promise<SnapshotResult> {
    const start = Date.now();
    const pageData = await this.fetchPageMeta();
    const rawElements = await this.fetchAccessibilityTree();

    // Assign sequential refs and build flat + tree representations
    const { flat, tree } = this.buildElements(rawElements);

    // Populate the ref-based index for findElement / click / type
    this.elementIndex.clear();
    for (const el of flat) this.elementIndex.set(el.ref, el);

    // Render the snapshot content in the chosen style
    const content = this.render(flat, tree, style, pageData.title);

    // Update running stats
    const elapsed = Date.now() - start;
    this.stats.totalCaptures++;
    this.stats.byStyle[style]++;
    this.stats.totalElements += flat.length;
    this.stats.totalTimeMs += elapsed;
    log.info({ style, elementCount: flat.length, elapsedMs: elapsed, url: pageData.url }, 'Snapshot captured');

    return {
      style, content, elements: flat, elementCount: flat.length,
      url: pageData.url, title: pageData.title, capturedAt: new Date().toISOString(),
    };
  }

  /** Convenience: capture in numeric style. */
  async captureNumeric(): Promise<SnapshotResult> { return this.capture('numeric'); }

  /** Convenience: capture in role-based style. */
  async captureRole(): Promise<SnapshotResult> { return this.capture('role'); }

  /** Convenience: capture in full ARIA-tree style. */
  async captureAria(): Promise<SnapshotResult> { return this.capture('aria'); }

  /**
   * Look up an element by its numeric ref.
   * Returns undefined if not found in the most recent capture.
   */
  findElement(ref: number): SnapshotElement | undefined {
    return this.elementIndex.get(ref);
  }

  /** Click the element identified by `ref` via Playwright role locator. */
  async clickElement(ref: number): Promise<void> {
    const el = this.requireElement(ref);
    const page = await this.resolveActivePage();
    await page.getByRole(el.role as AriaRole, { name: el.name }).first().click();
    log.info({ ref, role: el.role, name: el.name }, 'Clicked element');
  }

  /**
   * Type text into the element identified by `ref`.
   * Clears existing content first, then fills with the provided text.
   */
  async typeIntoElement(ref: number, text: string): Promise<void> {
    const el = this.requireElement(ref);
    const page = await this.resolveActivePage();
    const locator = page.getByRole(el.role as AriaRole, { name: el.name }).first();
    await locator.fill(''); // clear existing value
    await locator.fill(text);
    log.info({ ref, role: el.role, name: el.name, textLength: text.length }, 'Typed into element');
  }

  /** Return aggregate capture statistics. */
  getStats(): {
    totalCaptures: number;
    byStyle: Record<SnapshotStyle, number>;
    avgElements: number;
    avgCaptureTimeMs: number;
  } {
    const n = this.stats.totalCaptures || 1;
    return {
      totalCaptures: this.stats.totalCaptures,
      byStyle: { ...this.stats.byStyle },
      avgElements: Math.round(this.stats.totalElements / n),
      avgCaptureTimeMs: Math.round(this.stats.totalTimeMs / n),
    };
  }

  // -- Private: page data retrieval --------------------------------------------

  /** Fetch page URL and title via the active CDP session. */
  private async fetchPageMeta(): Promise<{ url: string; title: string }> {
    try {
      const page = await this.resolveActivePage();
      return { url: page.url(), title: await page.title() };
    } catch {
      return { url: 'about:blank', title: '' };
    }
  }

  /**
   * Fetch the accessibility tree via CDP session.
   * Tries Accessibility.getFullAXTree first; falls back to Accessibility.queryAXTree.
   */
  private async fetchAccessibilityTree(): Promise<RawAXNode[]> {
    const page = await this.resolveActivePage();
    const cdpSession = await page.context().newCDPSession(page);
    try {
      const { nodes } = await cdpSession.send('Accessibility.getFullAXTree') as { nodes: RawCDPAXNode[] };
      return this.normalizeAXNodes(nodes);
    } catch (err) {
      log.warn({ err }, 'Full AX tree failed — falling back to Accessibility.queryAXTree');
      // The previous fallback sent 'Accessibility.query', which is not a CDP
      // method, so it always threw and the fallback never worked. With empty
      // params queryAXTree is an unscoped full-tree query, same breadth as
      // getFullAXTree above.
      const { nodes } = await cdpSession.send('Accessibility.queryAXTree', {}) as { nodes: RawCDPAXNode[] };
      return this.normalizeAXNodes(nodes);
    } finally {
      await cdpSession.detach().catch(() => {});
    }
  }

  // -- Private: element construction -------------------------------------------

  /** Build flat and tree element lists from raw AX nodes. Assigns sequential numeric refs. */
  private buildElements(raw: RawAXNode[]): { flat: SnapshotElement[]; tree: SnapshotElement[] } {
    const flat: SnapshotElement[] = [];
    let nextRef = 1;

    // Recursive builder: constructs the tree and pushes every element into flat
    const build = (nodes: RawAXNode[]): SnapshotElement[] => {
      const result: SnapshotElement[] = [];
      for (const node of nodes) {
        if (!CAPTURED_ROLES.has(node.role)) continue;
        const el: SnapshotElement = {
          ref: nextRef++, role: node.role, name: node.name || '',
          value: node.value || undefined, description: node.description || undefined,
          bounds: node.bounds || undefined, children: build(node.children || []),
        };
        flat.push(el);
        result.push(el);
      }
      return result;
    };

    return { flat, tree: build(raw) };
  }

  // -- Private: rendering ------------------------------------------------------

  /** Dispatch to the correct renderer based on style. */
  private render(flat: SnapshotElement[], tree: SnapshotElement[], style: SnapshotStyle, pageTitle: string): string {
    switch (style) {
      case 'numeric': return this.renderNumeric(flat);
      case 'role':    return this.renderRole(tree);
      case 'aria':    return this.renderAria(tree, pageTitle);
    }
  }

  /**
   * Numeric style: one element per line with a [N] ref.
   * Only renders interactive elements + headings for compactness.
   * Format: [1] link "Home" href=/  |  [2] button "Sign In"  |  [3] textbox "Email" value=""
   */
  private renderNumeric(flat: SnapshotElement[]): string {
    const lines: string[] = [];
    for (const el of flat) {
      if (!INTERACTIVE_ROLES.has(el.role) && el.role !== 'heading') continue;
      const parts: string[] = [`[${el.ref}]`, el.role, JSON.stringify(el.name)];
      if (el.value !== undefined) parts.push(`value=${JSON.stringify(el.value)}`);
      if (el.role === 'link' && el.description) parts.push(`href=${el.description}`);
      lines.push(parts.join(' '));
    }
    return lines.join('\n');
  }

  /**
   * Role-based style: elements grouped under their parent's ARIA role.
   * Indentation conveys nesting; roles are the primary grouping mechanism.
   * Format: navigation: "Main Menu" / link: "Home" / form: "Login" / textbox: "Email"
   */
  private renderRole(tree: SnapshotElement[], indent = 0): string {
    const lines: string[] = [];
    const prefix = '  '.repeat(indent);
    for (const el of tree) {
      const namePart = el.name ? ` ${JSON.stringify(el.name)}` : '';
      const valuePart = el.value !== undefined ? ` value=${JSON.stringify(el.value)}` : '';
      lines.push(`${prefix}${el.role}:${namePart}${valuePart}`);
      if (el.children?.length) lines.push(this.renderRole(el.children, indent + 1));
    }
    return lines.join('\n');
  }

  /**
   * ARIA tree style: full accessibility tree preserving DOM hierarchy.
   * Wraps the root in a document node; includes attributes like heading level.
   * Format: document "Login Page" / navigation "Main Menu" / heading "Welcome" level=1
   */
  private renderAria(tree: SnapshotElement[], pageTitle: string, indent = 0): string {
    const lines: string[] = [];
    const prefix = '  '.repeat(indent);

    // Root level: wrap everything in a document node
    if (indent === 0 && tree.length > 0) {
      lines.push(`document ${JSON.stringify(pageTitle)}`);
      lines.push(this.renderAria(tree, pageTitle, 1));
      return lines.join('\n');
    }

    for (const el of tree) {
      const namePart = el.name ? ` ${JSON.stringify(el.name)}` : '';
      const extraParts: string[] = [];
      if (el.role === 'heading') extraParts.push('level=1'); // simplified; full impl reads from AX tree
      if (el.value !== undefined) extraParts.push(`value=${JSON.stringify(el.value)}`);
      const extra = extraParts.length ? ` ${extraParts.join(' ')}` : '';
      lines.push(`${prefix}${el.role}${namePart}${extra}`);
      if (el.children?.length) lines.push(this.renderAria(el.children, pageTitle, indent + 1));
    }
    return lines.join('\n');
  }

  // -- Private: helpers --------------------------------------------------------

  /** Throw if the element ref is not found in the current snapshot. */
  private requireElement(ref: number): SnapshotElement {
    const el = this.elementIndex.get(ref);
    if (!el) throw new Error(`Element ref [${ref}] not found — capture a snapshot first`);
    return el;
  }

  /** Get the active Playwright Page from the CDPManager. */
  private async resolveActivePage() {
    const session = this.cdp.getActiveSession();
    if (!session) throw new Error('No active CDP session');
    const browser = this.cdp.getCDPClient();
    if (!browser) throw new Error('CDPManager not connected');
    const contexts = browser.contexts();
    if (contexts.length === 0) throw new Error('No browser contexts available');
    const pages = contexts[0]!.pages();
    if (pages.length === 0) throw new Error('No pages available');
    return pages[pages.length - 1]!;
  }

  /**
   * Normalize raw CDP AX nodes into our internal representation.
   * Filters to captured roles and wires up parent-child relationships.
   */
  private normalizeAXNodes(nodes: RawCDPAXNode[]): RawAXNode[] {
    const nodeMap = new Map<string, RawAXNode>();
    const childMap = new Map<string, string[]>();

    // First pass: create RawAXNode objects for roles we care about
    for (const raw of nodes) {
      const role = raw.role?.value ?? '';
      if (!CAPTURED_ROLES.has(role)) continue;
      const node: RawAXNode = {
        role, name: raw.name?.value ?? '', value: raw.value?.value ?? '',
        description: raw.description?.value ?? '',
        bounds: this.extractBounds(raw.properties),
        children: [], rawId: raw.nodeId, parentId: raw.parentId ?? undefined,
      };
      nodeMap.set(raw.nodeId, node);
      if (raw.parentId) {
        const siblings = childMap.get(raw.parentId) ?? [];
        siblings.push(raw.nodeId);
        childMap.set(raw.parentId, siblings);
      }
    }

    // Second pass: wire children to parents
    for (const [parentId, childIds] of childMap) {
      const parent = nodeMap.get(parentId);
      if (parent) {
        parent.children = childIds
          .map((id) => nodeMap.get(id))
          .filter((n): n is RawAXNode => n !== undefined);
      }
    }

    // Return root nodes (those without a parent in the filtered set)
    return Array.from(nodeMap.values())
      .filter((n) => !n.parentId || !nodeMap.has(n.parentId));
  }

  /** Extract bounding box from the CDP AX node's properties array. */
  private extractBounds(
    properties?: Array<{ name: string; value: unknown }>,
  ): { x: number; y: number; width: number; height: number } | undefined {
    const boundsProp = properties?.find((p) => p.name === 'bounds');
    if (!boundsProp) return undefined;
    const v = boundsProp.value as Record<string, unknown> | null;
    if (v && typeof v.x === 'number' && typeof v.y === 'number' &&
        typeof v.width === 'number' && typeof v.height === 'number') {
      return { x: v.x, y: v.y, width: v.width, height: v.height };
    }
    return undefined;
  }
}