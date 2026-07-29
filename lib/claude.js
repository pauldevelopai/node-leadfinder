// claude.js — the Node's single LLM call. Anthropic-only (Claude Sonnet), the same
// model the KnowHow Claims Verifier used. Reads ANTHROPIC_API_KEY from the environment:
//   • hosted → the shared server key (set by deploy-node.sh in the box .env)
//   • local  → the user's own key, saved through the in-app "API key" screen (postSetup)
// One retry on a 429. Errors bubble up; callers already guard each call.
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.MODEL || 'claude-sonnet-4-6';

// Built lazily so a missing key at boot doesn't crash the Node — it only matters when
// a verify run actually calls the model, and the key can be added at runtime (local).
let client = null;
function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured. Add your AI key in the app.');
  if (!client || client.__key !== apiKey) {
    client = new Anthropic({ apiKey });
    client.__key = apiKey;
  }
  return client;
}

export async function callClaude({ system, userContent, maxTokens = 2000, messages = null, temperature = undefined }) {
  const params = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: messages || [{ role: 'user', content: userContent }],
  };
  if (temperature !== undefined) params.temperature = temperature;

  const c = getClient();
  try {
    const message = await c.messages.create(params);
    return message.content[0].text;
  } catch (err) {
    if (err.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      const message = await c.messages.create(params);
      return message.content[0].text;
    }
    console.error('Claude API error:', err.message || err);
    throw new Error(`AI service error: ${err.message || 'Unknown error'}`);
  }
}
