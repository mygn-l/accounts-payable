import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { auditChannel } from "@/lib/audit";
import { today } from "@/lib/dates";
import { NotSetUpError, ValidationError } from "@/lib/errors";
import type { User } from "@/lib/types";
import { serverFor } from "@/server/mcp";

// The chat box in the app: Claude answers the signed-in user with the same MCP tools their agent would get, so it can
// read and do only what their role allows, and what it does is marked "agent" in the audit log.
const MODEL = "claude-haiku-5-5";
const MAX_STEPS = 20;

let anthropic: Anthropic | null = null;
const client = () => {
  if (!process.env.ANTHROPIC_API_KEY) throw new NotSetUpError("The assistant is not set up: ANTHROPIC_API_KEY is missing on the server.");
  return (anthropic ??= new Anthropic());
};

// One turn: the conversation so far (as the API takes it) with the user's new message last; tools run until Claude answers.
export async function converse(user: User, messages: Anthropic.MessageParam[]) {
  if (!user.organization_id) throw new ValidationError("The assistant works for organization users.");
  if (!messages.length || messages.at(-1)!.role !== "user") throw new ValidationError("Send the conversation with the new message last.");

  const server = serverFor(user);
  const mcp = new Client({ name: "brim-ap-chat", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await mcp.connect(b);
  try {
    const { tools } = await mcp.listTools();
    const defs: Anthropic.Tool[] = tools.map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema as Anthropic.Tool.InputSchema }));
    const system = `You are the assistant inside Brim AP, the accounts payable app. You work for ${user.full_name} (${user.role.replace(/_/g, " ")}). Today is ${today()}. Use the tools to look things up and to act; they allow only what this person's role may do. Before an action that changes something (approving, rejecting, releasing, deleting, failing, closing), say what you will do and ask for a yes, unless the person already asked for exactly that. Answer briefly in plain text with no markdown (no asterisks, no headings), naming records by their ids.`;
    const convo = [...messages];
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await client().messages.create({ model: MODEL, max_tokens: 16000, system, tools: defs, messages: convo });
      convo.push({ role: "assistant", content: res.content });
      if (res.stop_reason !== "tool_use") {
        const text = res.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n").trim();
        const reply = text || (res.stop_reason === "refusal" ? "Claude declined to answer this." : res.stop_reason === "max_tokens" ? "The answer was too long and was cut off." : "");
        return { messages: convo, reply };
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of res.content) {
        if (use.type !== "tool_use") continue;
        const out = await auditChannel.run("agent", () => mcp.callTool({ name: use.name, arguments: use.input as Record<string, unknown> }));
        const text = (out.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
        results.push({ type: "tool_result", tool_use_id: use.id, content: text, is_error: Boolean(out.isError) });
      }
      convo.push({ role: "user", content: results });
    }
    return { messages: convo, reply: "This took too many steps; ask again more narrowly." };
  } finally {
    await mcp.close();
    await server.close();
  }
}
