/**
 * MSF / CMSF catalog fields in one grouped order for display. JSON member
 * order carries no meaning; fields not listed follow in arrival order.
 */

const ROOT_ORDER: readonly string[] = [
  'version', 'generatedAt', 'isComplete', 'deltaUpdate',
  'tracks', 'publishTracks', 'initDataList',
];

const TRACK_ORDER: readonly string[] = [
  // identity
  'namespace', 'name', 'parentNamespace', 'parentName',
  // packaging and delivery
  'packaging', 'locmafVersion', 'initRef', 'maxGrpSapStartingType', 'maxObjSapStartingType',
  'eventType', 'isLive', 'trackDuration', 'targetLatency', 'buffers',
  // selection
  'role', 'label', 'lang', 'accessibility',
  'renderGroup', 'altGroup', 'depends', 'temporalId', 'spatialId',
  // media
  'codec', 'mimeType',
  'width', 'height', 'displayWidth', 'displayHeight', 'framerate',
  'samplerate', 'channelConfig',
  'bitrate', 'avgBitrate', 'timescale', 'maxGopDuration', 'maxGroupDuration',
  'authInfo',
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Built with fromEntries so a remote `__proto__` key stays a plain field. */
function ordered(obj: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const keys = Object.keys(obj);
  const present = new Set(keys);
  const first = order.filter((k) => present.has(k));
  const listed = new Set(first);
  return Object.fromEntries([...first, ...keys.filter((k) => !listed.has(k))].map((k) => [k, obj[k]]));
}

/** The catalog with root and track fields in display order. */
export function orderCatalogForDisplay(catalog: unknown): unknown {
  if (!isRecord(catalog)) return catalog;
  const root = ordered(catalog, ROOT_ORDER);
  for (const key of ['tracks', 'publishTracks']) {
    const list = root[key];
    if (Array.isArray(list)) root[key] = list.map((t) => (isRecord(t) ? ordered(t, TRACK_ORDER) : t));
  }
  return root;
}
