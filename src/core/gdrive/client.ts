/**
 * @file gdrive/client.ts
 * @description DriveClient — the single choke point for ALL Drive/Sheets I/O.
 *
 * Every call goes: rate-limiter lane -> API call -> typed-error backoff.
 * Interactive lane preempts background (prime directive 8). No other module
 * may construct googleapis clients — this wrapper is where quotas, retries,
 * and error taxonomy live.
 *
 * Testability: the raw drive/sheets API surfaces are constructor-injectable,
 * so unit tests pass mocks and CI never touches the network.
 */

import { google, type drive_v3, type sheets_v4 } from 'googleapis';
import { createAuthClient } from './auth.js';
import { withBackoff, type BackoffOptions } from './backoff.js';
import { TokenBucketLimiter } from './rate-limiter.js';
import type { GdriveConfig, GdriveFileMeta, GdriveLane } from './types.js';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveClientDeps {
  drive?: drive_v3.Drive;
  sheets?: sheets_v4.Sheets;
  limiter?: TokenBucketLimiter;
  backoff?: BackoffOptions;
}

export interface CallOpts {
  lane?: GdriveLane;
}

const FILE_FIELDS = 'id, name, mimeType, parents, modifiedTime, size, trashed';

export class DriveClient {
  private readonly drive: drive_v3.Drive;
  private readonly sheets: sheets_v4.Sheets;
  private readonly limiter: TokenBucketLimiter;
  private readonly backoff: BackoffOptions;

  constructor(config: GdriveConfig, deps: DriveClientDeps = {}) {
    if (deps.drive && deps.sheets) {
      this.drive = deps.drive;
      this.sheets = deps.sheets;
    } else {
      const auth = createAuthClient(config);
      this.drive = deps.drive ?? google.drive({ version: 'v3', auth });
      this.sheets = deps.sheets ?? google.sheets({ version: 'v4', auth });
    }
    this.limiter =
      deps.limiter ??
      new TokenBucketLimiter({
        requestsPerSecond: config.requestsPerSecond,
        burst: config.burst,
      });
    this.backoff = { maxRetries: config.maxRetries, ...deps.backoff };
  }

  /** Telemetry hook for the F4 sync-observability rider. */
  get queueDepth(): { interactive: number; background: number } {
    return this.limiter.queueDepth;
  }

  private async call<T>(lane: GdriveLane | undefined, fn: () => Promise<T>): Promise<T> {
    await this.limiter.acquire(lane ?? 'background');
    return withBackoff(fn, this.backoff);
  }

  // -------------------------------------------------------------------------
  // Files
  // -------------------------------------------------------------------------

  async filesCreate(
    meta: { name: string; parents?: string[]; mimeType?: string },
    media?: { mimeType: string; body: string | NodeJS.ReadableStream },
    opts: CallOpts = {},
  ): Promise<GdriveFileMeta> {
    const res = await this.call(opts.lane, () =>
      this.drive.files.create({
        requestBody: meta,
        media,
        fields: FILE_FIELDS,
      }),
    );
    return res.data as GdriveFileMeta;
  }

  async filesGet(fileId: string, opts: CallOpts = {}): Promise<GdriveFileMeta> {
    const res = await this.call(opts.lane, () =>
      this.drive.files.get({ fileId, fields: FILE_FIELDS }),
    );
    return res.data as GdriveFileMeta;
  }

  /** Download raw file content (alt=media) as a UTF-8 string. */
  async filesDownload(fileId: string, opts: CallOpts = {}): Promise<string> {
    const res = await this.call(opts.lane, () =>
      this.drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' }),
    );
    return Buffer.from(res.data as ArrayBuffer).toString('utf-8');
  }

  async filesList(
    params: { q?: string; pageToken?: string; pageSize?: number; orderBy?: string },
    opts: CallOpts = {},
  ): Promise<{ files: GdriveFileMeta[]; nextPageToken?: string }> {
    const res = await this.call(opts.lane, () =>
      this.drive.files.list({
        ...params,
        fields: `nextPageToken, files(${FILE_FIELDS})`,
        spaces: 'drive',
      }),
    );
    return {
      files: (res.data.files ?? []) as GdriveFileMeta[],
      nextPageToken: res.data.nextPageToken ?? undefined,
    };
  }

  async filesUpdate(
    fileId: string,
    meta: Partial<{ name: string; trashed: boolean; addParents: string; removeParents: string }>,
    media?: { mimeType: string; body: string | NodeJS.ReadableStream },
    opts: CallOpts = {},
  ): Promise<GdriveFileMeta> {
    const { addParents, removeParents, ...requestBody } = meta;
    const res = await this.call(opts.lane, () =>
      this.drive.files.update({
        fileId,
        addParents,
        removeParents,
        requestBody,
        media,
        fields: FILE_FIELDS,
      }),
    );
    return res.data as GdriveFileMeta;
  }

  /** Export a Google-native file (Doc/Sheet) to the given mimeType. */
  async filesExport(fileId: string, mimeType: string, opts: CallOpts = {}): Promise<string> {
    const res = await this.call(opts.lane, () =>
      this.drive.files.export({ fileId, mimeType }, { responseType: 'arraybuffer' }),
    );
    return Buffer.from(res.data as ArrayBuffer).toString('utf-8');
  }

  // -------------------------------------------------------------------------
  // Changes feed
  // -------------------------------------------------------------------------

  async changesGetStartPageToken(opts: CallOpts = {}): Promise<string> {
    const res = await this.call(opts.lane, () => this.drive.changes.getStartPageToken({}));
    return res.data.startPageToken ?? '';
  }

  async changesList(
    pageToken: string,
    opts: CallOpts = {},
  ): Promise<{
    changes: drive_v3.Schema$Change[];
    newStartPageToken?: string;
    nextPageToken?: string;
  }> {
    const res = await this.call(opts.lane, () =>
      this.drive.changes.list({
        pageToken,
        includeRemoved: true,
        fields: `newStartPageToken, nextPageToken, changes(fileId, removed, time, file(${FILE_FIELDS}))`,
      }),
    );
    return {
      changes: res.data.changes ?? [],
      newStartPageToken: res.data.newStartPageToken ?? undefined,
      nextPageToken: res.data.nextPageToken ?? undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Permissions / comments / revisions (F16 / F6 / F9 substrate)
  // -------------------------------------------------------------------------

  async permissionsList(fileId: string, opts: CallOpts = {}): Promise<drive_v3.Schema$Permission[]> {
    const res = await this.call(opts.lane, () =>
      this.drive.permissions.list({
        fileId,
        fields: 'permissions(id, type, role, emailAddress, domain)',
      }),
    );
    return res.data.permissions ?? [];
  }

  async commentsList(fileId: string, opts: CallOpts = {}): Promise<drive_v3.Schema$Comment[]> {
    const res = await this.call(opts.lane, () =>
      this.drive.comments.list({ fileId, fields: '*', includeDeleted: false }),
    );
    return res.data.comments ?? [];
  }

  async commentsReplies(
    fileId: string,
    commentId: string,
    opts: CallOpts = {},
  ): Promise<drive_v3.Schema$Reply[]> {
    const res = await this.call(opts.lane, () =>
      this.drive.replies.list({ fileId, commentId, fields: '*', includeDeleted: false }),
    );
    return res.data.replies ?? [];
  }

  async revisionsList(fileId: string, opts: CallOpts = {}): Promise<drive_v3.Schema$Revision[]> {
    const res = await this.call(opts.lane, () =>
      this.drive.revisions.list({
        fileId,
        fields: 'revisions(id, modifiedTime, keepForever, md5Checksum, size)',
        pageSize: 200,
      }),
    );
    return res.data.revisions ?? [];
  }

  async revisionsGetContent(fileId: string, revisionId: string, opts: CallOpts = {}): Promise<string> {
    const res = await this.call(opts.lane, () =>
      this.drive.revisions.get({ fileId, revisionId, alt: 'media' }, { responseType: 'arraybuffer' }),
    );
    return Buffer.from(res.data as ArrayBuffer).toString('utf-8');
  }

  /** Pin/unpin a revision (keepForever) — F36 release pinning substrate. */
  async revisionsSetKeepForever(
    fileId: string,
    revisionId: string,
    keepForever: boolean,
    opts: CallOpts = {},
  ): Promise<void> {
    await this.call(opts.lane, () =>
      this.drive.revisions.update({ fileId, revisionId, requestBody: { keepForever } }),
    );
  }

  // -------------------------------------------------------------------------
  // Sheets values (F4 / F7 substrate)
  // -------------------------------------------------------------------------

  async sheetsValuesGet(
    spreadsheetId: string,
    range: string,
    opts: CallOpts = {},
  ): Promise<unknown[][]> {
    const res = await this.call(opts.lane, () =>
      this.sheets.spreadsheets.values.get({ spreadsheetId, range }),
    );
    return (res.data.values ?? []) as unknown[][];
  }

  async sheetsValuesAppend(
    spreadsheetId: string,
    range: string,
    values: unknown[][],
    opts: CallOpts = {},
  ): Promise<void> {
    await this.call(opts.lane, () =>
      this.sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      }),
    );
  }

  async sheetsValuesUpdate(
    spreadsheetId: string,
    range: string,
    values: unknown[][],
    opts: CallOpts = {},
  ): Promise<void> {
    await this.call(opts.lane, () =>
      this.sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: 'RAW',
        requestBody: { values },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Convenience helpers used by bootstrap
  // -------------------------------------------------------------------------

  /** List non-trashed children of a folder. */
  async listChildren(folderId: string, opts: CallOpts = {}): Promise<GdriveFileMeta[]> {
    const out: GdriveFileMeta[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.filesList(
        { q: `'${folderId}' in parents and trashed = false`, pageToken, pageSize: 1000 },
        opts,
      );
      out.push(...page.files);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async createFolder(name: string, parentId: string, opts: CallOpts = {}): Promise<GdriveFileMeta> {
    return this.filesCreate({ name, parents: [parentId], mimeType: FOLDER_MIME }, undefined, opts);
  }
}
