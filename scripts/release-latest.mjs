import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const { newerVersion } = createRequire(import.meta.url)('../desktop/updater.cjs');

export function shouldMarkLatest(tag, publishedTags) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) return false;
  return !publishedTags.some((existing) => /^v\d+\.\d+\.\d+$/.test(existing) && newerVersion(existing, tag));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(shouldMarkLatest(process.env.RELEASE_TAG || '', (process.env.PUBLISHED_TAGS || '').split(/\s+/)));
}
