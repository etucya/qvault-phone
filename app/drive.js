// Read-only Google Drive access over the REST v3 API. `fetch` and `getToken` are injected so
// the tests can run against a fake Drive. Nothing here ever writes to Drive.

const API = 'https://www.googleapis.com/drive/v3/files';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'files(id,name,md5Checksum,modifiedTime,mimeType,parents),nextPageToken';
const MEDIA = '.media';
const BANK_EXTENSION = '.quiz';

/** Quotes a value for a Drive `q` string: backslashes and single quotes are escaped. */
const quote = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function failure(status, what) {
  const unauthorized = status === 401 || status === 403;
  const error = new Error(`Drive ${what} failed with status ${status}${unauthorized ? ' (unauthorized)' : ''}`);
  error.status = status;
  error.unauthorized = unauthorized;
  return error;
}

export function createDrive({ fetch, getToken }) {
  async function get(url, what) {
    const token = await getToken();
    if (!token) {
      const error = new Error(`Drive ${what} failed: unauthorized (not signed in)`);
      error.status = 401;
      error.unauthorized = true;
      throw error;
    }
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw failure(response.status, what);
    return response;
  }

  /** Every file matching `q`, following nextPageToken until the last page. */
  async function list(q) {
    const out = [];
    let pageToken = null;
    do {
      const params = new URLSearchParams({ q, fields: FIELDS, pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const body = await (await get(`${API}?${params}`, 'listing')).json();
      out.push(...(body.files ?? []).filter((f) => f.trashed !== true));
      pageToken = body.nextPageToken ?? null;
    } while (pageToken);
    return out;
  }

  const children = (folderId) => list(`${quote(folderId)} in parents and trashed = false`);

  return {
    async findFolder(name, parentId = 'root') {
      const found = await list(
        `name = ${quote(name)} and ${quote(parentId)} in parents and mimeType = '${FOLDER}' and trashed = false`,
      );
      return found[0]?.id ?? null;
    },

    /**
     * Every `.quiz` under the folder, breadth-first, with paths relative to it, and an index
     * of the pictures directly inside its `.media` folder. Folders and files whose names start
     * with "." are skipped, apart from that root `.media`.
     */
    async listTree(folderId) {
      const banks = [];
      const mediaIndex = new Map();
      const pending = [{ id: folderId, prefix: '', root: true }];
      while (pending.length > 0) {
        const { id, prefix, root } = pending.shift();
        for (const file of await children(id)) {
          const isFolder = file.mimeType === FOLDER;
          if (root && isFolder && file.name === MEDIA) {
            for (const picture of await children(file.id)) {
              if (picture.mimeType !== FOLDER) mediaIndex.set(picture.name, picture.id);
            }
            continue;
          }
          if (file.name.startsWith('.')) continue;
          if (isFolder) {
            pending.push({ id: file.id, prefix: `${prefix}${file.name}/`, root: false });
          } else if (file.name.endsWith(BANK_EXTENSION)) {
            banks.push({
              id: file.id,
              path: `${prefix}${file.name}`,
              name: file.name.slice(0, -BANK_EXTENSION.length),
              md5Checksum: file.md5Checksum,
              modifiedTime: file.modifiedTime,
            });
          }
        }
      }
      return { banks, mediaIndex };
    },

    /** The file's bytes. */
    async download(fileId) {
      const response = await get(`${API}/${encodeURIComponent(fileId)}?alt=media`, 'download');
      return response.arrayBuffer();
    },
  };
}
