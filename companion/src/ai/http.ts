import { AiError, errorFromNetwork, errorFromStatus } from "./provider";

export type FetchLike = typeof fetch;

/** POST JSON and return parsed JSON, translating every failure into an AiError. */
export async function postJson(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<any> {
  let response: Response;
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    throw errorFromNetwork(provider, error, timeoutMs);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw errorFromNetwork(provider, error, timeoutMs);
  }
  if (!response.ok) throw errorFromStatus(provider, response.status, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError("server", `${provider} returned a non-JSON HTTP response.`, true, response.status);
  }
}
