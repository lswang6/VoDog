import {z} from 'zod';

/**
 * S28 opt-in offset pagination, shared by `/calls`, `/reports/calls` and `/blocklist/interceptions`.
 *
 * `page` is the switch, not `pageSize`: while it is absent a list route answers exactly what it
 * answered before — the legacy `limit`/`before`/`beforeId` cursor, one SELECT, no COUNT (the web
 * dashboard polls `/calls` every 1–2 s and must not pay for a count it never reads). Only when
 * `page` is present does the route run the count and return the `{items,page,pageSize,total,
 * totalPages}` envelope. `page` and a cursor are mutually exclusive: mixing them cannot be given a
 * single honest meaning, so it is a 400 rather than a silently-preferred one.
 *
 * `pageSize` is a closed set so no caller can widen an offset scan into an unbounded one, and it
 * defaults instead of being required so `?page=2` alone is a valid request.
 */
export const PAGE_SIZES = [50, 100, 200] as const;

export const pageQueryShape = {
  page: z.coerce.number().int().min(1).max(100000).optional(),
  pageSize: z.coerce
    .number()
    .int()
    .refine((value) => (PAGE_SIZES as readonly number[]).includes(value), 'pageSize must be 50, 100, or 200')
    .default(50),
};

/** An empty page past the end still reports the true totals, so a client can walk back. */
export function pageEnvelope(page: number, pageSize: number, total: number) {
  return {page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize))};
}

export const pageOffset = (page: number, pageSize: number) => (page - 1) * pageSize;
