/** Extend the existing first metadata page only far enough for the requested window. */
export async function readThreadCatalogWindow(firstPage, { limit, readPage, include = () => true }) {
  const rows = (Array.isArray(firstPage?.data) ? firstPage.data : []).filter(include);
  let cursor = firstPage?.nextCursor;
  const cursors = new Set();
  const ids = new Set(rows.map(row => row.id));
  while (rows.length < limit && cursor && !cursors.has(cursor)) {
    cursors.add(cursor);
    const page = await readPage({ cursor, limit: Math.min(50, limit - rows.length) });
    for (const row of Array.isArray(page?.data) ? page.data : []) {
      if (include(row) && !ids.has(row.id)) { rows.push(row); ids.add(row.id); }
    }
    cursor = page?.nextCursor;
  }
  return rows.slice(0, limit);
}
