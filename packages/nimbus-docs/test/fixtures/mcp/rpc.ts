// A minimal MCP client for tests: one JSON-RPC request per POST, the
// response read as JSON or as the first `data:` frame of an SSE stream.
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

export function rpcRequest(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  id: number | string = 1,
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

export async function readRpcResponse(response: Response): Promise<JsonRpcResponse> {
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (type.startsWith("application/json")) return JSON.parse(text) as JsonRpcResponse;
  if (type.startsWith("text/event-stream")) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim());
    if (data.length === 0) throw new Error(`SSE response without data frames (${response.status}): ${text}`);
    return JSON.parse(data[data.length - 1]!) as JsonRpcResponse;
  }
  throw new Error(`Unexpected ${response.status} ${type}: ${text}`);
}

export const INITIALIZE_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "nimbus-test", version: "0.0.0" },
};

/** The parsed `text` content of a tools/call result. */
export function toolText(message: JsonRpcResponse): unknown {
  const content = (message.result as { content?: Array<{ type: string; text: string }> } | undefined)?.content;
  const text = content?.find((block) => block.type === "text")?.text;
  if (text === undefined) throw new Error(`No text content in ${JSON.stringify(message)}`);
  return JSON.parse(text);
}
