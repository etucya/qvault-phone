// A fake Google Drive behind a fake `fetch`, for the drive and sync tests. It understands
// just the requests app/drive.js makes: files.list with an "in parents" or a name query,
// paged by `pageSize` (forced small here so pagination is exercised), and alt=media.

const FOLDER = 'application/vnd.google-apps.folder';

export function fakeDrive({ pageSize = 2 } = {}) {
  const files = new Map(); // id -> {id, name, mimeType, parents, md5Checksum, modifiedTime, trashed, content}
  const calls = [];
  let nextId = 1;
  let status = null; // when set, every request answers with this status

  const drive = {
    calls,
    files,
    folder(name, parent = 'root', extra = {}) {
      const id = extra.id ?? `f${nextId++}`;
      files.set(id, { id, name, mimeType: FOLDER, parents: [parent], trashed: false, ...extra });
      return id;
    },
    file(name, parent, content, extra = {}) {
      const id = extra.id ?? `f${nextId++}`;
      files.set(id, {
        id,
        name,
        mimeType: extra.mimeType ?? 'application/octet-stream',
        parents: [parent],
        md5Checksum: extra.md5Checksum ?? `md5-${id}-${String(content).length}`,
        modifiedTime: '2026-10-12T12:00:00.000Z',
        trashed: false,
        content,
        ...extra,
      });
      return id;
    },
    setContent(id, content, md5) {
      const f = files.get(id);
      f.content = content;
      f.md5Checksum = md5;
    },
    remove(id) {
      files.delete(id);
    },
    failWith(code) {
      status = code;
    },
    downloads: () => calls.filter((c) => c.url.searchParams.get('alt') === 'media').length,
    async fetch(input, init = {}) {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (status !== null) return new Response('{"error":{}}', { status });
      if (!init.headers?.Authorization?.startsWith('Bearer ')) return new Response('', { status: 401 });

      const media = url.pathname.match(/\/drive\/v3\/files\/([^/]+)$/);
      if (media && url.searchParams.get('alt') === 'media') {
        const f = files.get(decodeURIComponent(media[1]));
        if (!f) return new Response('not found', { status: 404 });
        return new Response(typeof f.content === 'string' ? new TextEncoder().encode(f.content) : f.content);
      }
      if (url.pathname !== '/drive/v3/files') return new Response('', { status: 404 });

      const q = url.searchParams.get('q') ?? '';
      const parent = q.match(/'((?:[^'\\]|\\.)*)' in parents/)?.[1];
      const name = q.match(/name = '((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\(.)/g, '$1');
      const onlyFolders = q.includes(`mimeType = '${FOLDER}'`);
      const hideTrashed = q.includes('trashed = false');
      let matches = [...files.values()].filter((f) =>
        (parent === undefined || f.parents.includes(parent))
        && (name === undefined || f.name === name)
        && (!onlyFolders || f.mimeType === FOLDER)
        && (!hideTrashed || !f.trashed));
      const start = Number(url.searchParams.get('pageToken') ?? 0);
      const page = matches.slice(start, start + pageSize);
      const body = {
        files: page.map(({ content, trashed, ...meta }) => meta),
      };
      if (start + pageSize < matches.length) body.nextPageToken = String(start + pageSize);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
  return drive;
}
