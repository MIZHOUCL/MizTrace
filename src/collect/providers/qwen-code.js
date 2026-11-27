/** Qwen Code 是 Gemini CLI 的分支，目录换成 ~/.qwen，格式相同。 */
import * as gemini from './gemini-cli.js';

export const id = 'qwen-code';
export const detect = gemini.detect;
export function collect(dirs, range, cutoffHour, opts = {}) {
  return gemini.collect(dirs, range, cutoffHour, { ...opts, providerId: id });
}
