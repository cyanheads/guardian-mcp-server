/**
 * @fileoverview Raw API response types (close to wire shape) and normalized domain types for
 * The Guardian Open Platform API.
 * @module services/guardian/types
 */

// ---------------------------------------------------------------------------
// Raw wire types — field names match the Guardian API response exactly
// ---------------------------------------------------------------------------

/** Raw show-fields sub-object nested under each result item. */
export interface RawFields {
  body?: string;
  byline?: string;
  headline?: string;
  standfirst?: string;
  thumbnail?: string;
  wordcount?: string; // API returns as string integer
}

/** Raw tag object (used for contributors). */
export interface RawTag {
  apiUrl?: string;
  id: string;
  type: string;
  webTitle: string;
  webUrl: string;
}

/** Raw content item from search / section browse results. */
export interface RawContentItem {
  apiUrl: string;
  fields?: RawFields;
  id: string;
  pillarId?: string;
  pillarName?: string;
  sectionId: string;
  sectionName: string;
  tags?: RawTag[];
  type: string;
  webPublicationDate: string;
  webUrl: string;
}

/** Raw single-content response (single-item endpoint returns response.content, not response.results[]). */
export interface RawSingleContent extends RawContentItem {}

/** Raw search / section response envelope. */
export interface RawSearchResponse {
  response: {
    status: string;
    total: number;
    startIndex: number;
    pageSize: number;
    currentPage: number;
    pages: number;
    orderBy?: string;
    results: RawContentItem[];
  };
}

/** Raw single-item response envelope. */
export interface RawSingleResponse {
  response: {
    status: string;
    content: RawSingleContent;
  };
}

/** Raw section item. */
export interface RawSection {
  apiUrl: string;
  id: string;
  webTitle: string;
  webUrl: string;
}

/** Raw sections list response envelope. */
export interface RawSectionsResponse {
  response: {
    status: string;
    total: number;
    results: RawSection[];
  };
}

/** Raw tag response envelope. */
export interface RawTagsResponse {
  response: {
    status: string;
    total: number;
    startIndex: number;
    pageSize: number;
    currentPage: number;
    pages: number;
    results: RawTag[];
  };
}

// ---------------------------------------------------------------------------
// Normalized domain types — snake_case, HTML stripped, parsed numbers
// ---------------------------------------------------------------------------

export interface Contributor {
  id: string;
  name: string;
}

/** Normalized article, shared across search and browse results. */
export interface NormalizedArticle {
  body?: string;
  byline?: string;
  contributors: Contributor[];
  headline: string;
  id: string;
  pillar_id?: string;
  pillar_name?: string;
  published_date: string;
  section_id: string;
  section_name: string;
  standfirst?: string;
  thumbnail?: string;
  truncated: boolean;
  type: string;
  web_url: string;
  word_count?: number;
}

export interface NormalizedSection {
  id: string;
  name: string;
  web_url: string;
}

export interface NormalizedTag {
  id: string;
  name: string;
  section_id?: string;
  section_name?: string;
  type: string;
  web_url: string;
}

export interface NormalizedSearchResult {
  order_by: string;
  page: number;
  page_size: number;
  pages: number;
  results: NormalizedArticle[];
  total: number;
}

export interface NormalizedSectionsResult {
  sections: NormalizedSection[];
  total: number;
}

export interface NormalizedTagsResult {
  page: number;
  pages: number;
  tags: NormalizedTag[];
  total: number;
}
