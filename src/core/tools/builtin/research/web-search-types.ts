/**
 * Web Search type definitions with image support.
 *
 * Extends plain text search results with optional image metadata so agents
 * can reason about both textual snippets and associated imagery in one pass.
 */

import { createLogger } from '../../../shared/logger.js';

const log = createLogger('tool:web-search-types');

// ---------------------------------------------------------------------------
// Result type discriminant
// ---------------------------------------------------------------------------

/** Discriminant describing what kind of content a result contains. */
export type WebSearchResultType = 'text' | 'image' | 'text_and_image';

// ---------------------------------------------------------------------------
// Core result types
// ---------------------------------------------------------------------------

/** A single image found alongside a search result. */
export interface WebSearchImage {
  /** Absolute URL of the image resource. */
  url: string;
  /** Alt text describing the image. */
  alt: string;
  /** Image width in pixels, when available. */
  width?: number;
  /** Image height in pixels, when available. */
  height?: number;
}

/** A single search result entry, optionally enriched with images. */
export interface WebSearchResult {
  /** Page title from the search engine. */
  title: string;
  /** Source URL for the result. */
  url: string;
  /** Short text extract shown by the search engine. */
  snippet: string;
  /** Content type discriminant. */
  type: WebSearchResultType;
  /** Images associated with this result (populated by enrichWithImages). */
  images?: WebSearchImage[];
}

// ---------------------------------------------------------------------------
// Options / request shape
// ---------------------------------------------------------------------------

/** Options accepted by web search tool implementations. */
export interface WebSearchOptions {
  /** The search query string. */
  query: string;
  /** Filter results to a specific content type. Defaults to "text". */
  resultType?: WebSearchResultType;
  /** Maximum number of results to return. Defaults to provider limit. */
  maxResults?: number;
  /** When true, attempt to fetch associated images for each result. */
  includeImages?: boolean;
}

// ---------------------------------------------------------------------------
// Enrichment helper
// ---------------------------------------------------------------------------

/**
 * Merge a flat list of images into a result set, distributing two images
 * per result in order. Results with no images assigned keep type "text".
 *
 * @param results - Base search results to enrich.
 * @param images  - Flat list of images to distribute across results.
 * @returns New result array with image fields populated.
 */
export function enrichWithImages(
  results: WebSearchResult[],
  images: WebSearchImage[],
): WebSearchResult[] {
  if (!Array.isArray(results)) {
    log.warn('enrichWithImages: results must be an array — returning empty list');
    return [];
  }
  if (!Array.isArray(images)) {
    log.warn('enrichWithImages: images must be an array — returning results unchanged');
    return results;
  }

  const IMAGES_PER_RESULT = 2;

  return results.map((r, i) => {
    const slice = images.slice(i * IMAGES_PER_RESULT, (i + 1) * IMAGES_PER_RESULT);
    const hasImages = slice.length > 0;
    return {
      ...r,
      type: hasImages ? ('text_and_image' as const) : ('text' as const),
      images: hasImages ? slice : undefined,
    };
  });
}
