import { request as httpsRequest } from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

/** Create a fetch-compatible request function for Jev's HTTPS endpoint. */
export function createProxyFetch(proxyUrl: string): typeof fetch {
  const proxy = new URL(proxyUrl);
  const agent = proxy.protocol === "socks5:" || proxy.protocol === "socks5h:"
    ? new SocksProxyAgent(proxy.protocol === "socks5:" ? proxyUrl.replace(/^socks5:/i, "socks5h:") : proxyUrl)
    : new HttpsProxyAgent(proxy);

  return (input, init) => new Promise<Response>((resolve, reject) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    headers["accept-encoding"] ??= "identity";

    const request = httpsRequest(new URL(requestUrl), {
      method: init?.method,
      headers,
      agent,
      signal: init?.signal ?? undefined,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;
          for (const item of Array.isArray(value) ? value : [value]) {
            responseHeaders.append(name, String(item));
          }
        }

        const status = response.statusCode ?? 500;
        const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
        resolve(new Response(body, {
          status,
          statusText: response.statusMessage,
          headers: responseHeaders,
        }));
      });
    });
    request.on("error", reject);
    request.end(typeof init?.body === "string" ? init.body : undefined);
  });
}
