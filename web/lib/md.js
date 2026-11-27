import { lang } from './i18n.js';
import { markdownToHtml } from './markdown.js';
export { esc } from './markdown.js';
export const renderMd = (markdown) => markdownToHtml(markdown, lang.value);
