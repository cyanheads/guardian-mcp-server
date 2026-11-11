/**
 * @fileoverview Raw API response types (close to wire shape) and normalized domain types for
 * The Guardian Open Platform API.
 * @module services/guardian/types
 */

import { z } from '@cyanheads/mcp-ts-core';

// ---------------------------------------------------------------------------
// Raw wire types — field names match the Guardian API response exactly
// ---------------------------------------------------------------------------

/** Raw tag object (used for contributors and tag search results). */
export interface RawTag {
  apiUrl?: string;
  id: string;
  sectionId?: string | null;
  sectionName?: string | null;
  type: string;
  webTitle: string;
  webUrl: string;
}

/** Article fields consumed by normalization. Discovery uses its own wire types. */
const RawContentItemSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  sectionId: z.string(),
  sectionName: z.string(),
  webPublicationDate: z.string(),
  webUrl: z.string(),
  pillarId: z.string().optional(),
  pillarName: z.string().optional(),
  fields: z
    .object({
      body: z.string().optional(),
      byline: z.string().optional(),
      headline: z.string().optional(),
      standfirst: z.string().optional(),
      thumbnail: z.string().optional(),
      wordcount: z.string().optional(),
      firstPublicationDate: z.string().nullish(),
      lastModified: z.string().nullish(),
    })
    .optional(),
  tags: z.array(z.object({ id: z.string(), type: z.string(), webTitle: z.string() })).optional(),
});

export type RawContentItem = z.infer<typeof RawContentItemSchema>;

/** The Guardian single-item endpoint can serve either an article or a collection. */
export const RawSingleResponseSchema = z.object({
  response: z.object({ status: z.literal('ok'), content: RawContentItemSchema }),
});

const CollectionMarkerSchema = z.object({ id: z.string().min(1) });

/** A collection has its own marker and an article array, even on an empty page. */
export const RawSectionContentResponseSchema = z.object({
  response: z
    .object({
      status: z.literal('ok'),
      total: z.number().int().nonnegative(),
      currentPage: z.number().int().positive(),
      pages: z.number().int().nonnegative(),
      results: z.array(RawContentItemSchema),
      section: CollectionMarkerSchema.optional(),
      edition: CollectionMarkerSchema.optional(),
      tag: CollectionMarkerSchema.optional(),
    })
    .refine(({ section, edition, tag }) => section || edition || tag),
});

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

/** Topic and editorial tags returned by article detail. */
export const ArticleTagTypeSchema = z.enum(['keyword', 'series', 'tone']);

export interface NormalizedArticleDetail extends NormalizedArticle {
  first_published_date?: string;
  last_modified?: string;
  tags: Array<Contributor & { type: z.infer<typeof ArticleTagTypeSchema> }>;
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
