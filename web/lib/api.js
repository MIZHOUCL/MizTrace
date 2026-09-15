/**
 * 与本地服务通信。token 从 ?t= 取一次后放 sessionStorage，地址栏里立刻抹掉。
 * 这个文件里的 fetch 是整个仓库里前端唯一的网络调用，且只能连本站（CSP connect-src 'self'）。
 */
const params = new URLSearchParams(location.search);
export const TOKEN = params.get('t') || sessionStorage.getItem('dt_token') || '';
if (params.get('t')) {
  sessionStorage.setItem('dt_token', TOKEN);
  history.replaceState(null, '', location.pathname);
}

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-miztrace-token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
