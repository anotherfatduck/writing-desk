// tests/conductor/test-chat-persona.mjs — the persona module: prompt assembly,
// seeds, and the prompt invariants (identity line, rewritten workflow, no
// submit tool, universal conduct). chat-agent-config.
let failed = 0;
const assert = (cond, msg) => { if (cond) console.log(`  ok: ${msg}`); else { failed++; console.error(`  FAIL: ${msg}`); } };

const mod = await import('../../dist/shared/chat-persona.js');
const { buildChatSystemPrompt, CHAT_PERSONA_DEFAULT, CHAT_PERSONA_SEEDS } = mod;

// 1. Default assembly: skeleton invariants present, persona interpolated first.
{
  const prompt = buildChatSystemPrompt(null);
  assert(prompt.startsWith(`You are Quill, ${CHAT_PERSONA_DEFAULT}`), 'default prompt opens with the persona role phrase');
  assert(prompt.includes('Your name is Quill everywhere and always; never ask the writer to name you.'), 'identity line present (fixed skeleton)');
  assert(prompt.includes('Workflow:') && /1\. read_document/.test(prompt) && /2\. read_workspace/.test(prompt) && /3\. Deliver work with propose_edits/.test(prompt), 'workflow steps 1-3 present');
  assert(/4\. When the work is complete, say so/.test(prompt), 'workflow step 4 rewritten (agent delivers, never submits)');
  assert(prompt.includes('the writer reviews and submits from the Review screen'), 'step 4 points the writer at the Review screen');
  assert(prompt.includes("Submission is never the agent's call: there is no submit tool"), 'step 4 states submission is never the agent\'s call');
  assert(prompt.includes('Universal conduct (binding):') && prompt.includes('Never invent metrics, statistics, or sources') && prompt.includes('Never promise outcomes.'), 'universal conduct present (fixed skeleton)');
  assert(prompt.includes('Style: match the writer\'s language. Concise plain prose.'), 'style lines present (fixed skeleton)');
  assert(!prompt.includes('submit_for_review'), 'no assembled prompt mentions the submit tool');
}

// 2. A store persona rides verbatim; whitespace-only falls back to default.
{
  const custom = buildChatSystemPrompt('a swashbuckling line editor who distrusts adjectives');
  assert(custom.startsWith('You are Quill, a swashbuckling line editor who distrusts adjectives'), 'custom persona interpolated verbatim after "You are Quill, "');
  assert(custom.includes('Your name is Quill everywhere and always'), 'identity line survives a custom persona');
  assert(custom.includes('Universal conduct (binding):'), 'universal conduct survives a custom persona');
  const blank = buildChatSystemPrompt('   ');
  assert(blank === buildChatSystemPrompt(null), 'whitespace-only persona falls back to the default');
}

// 3. Seeds: four presets, all carrying the no-moralize voice line;
//    site-agnostic except medical — today's Writing Desk persona, verbatim.
{
  assert(CHAT_PERSONA_SEEDS.length === 4, 'four seeds shipped');
  assert(JSON.stringify(CHAT_PERSONA_SEEDS.map((s) => s.key)) === JSON.stringify(['neutral', 'medical', 'tech', 'food']), 'seed keys in order');
  for (const seed of CHAT_PERSONA_SEEDS) {
    assert(seed.label.length > 0, `${seed.key}: has a label`);
    assert(seed.persona.includes('never moralize'), `${seed.key}: carries the no-moralize voice line`);
    const assembled = buildChatSystemPrompt(seed.persona);
    assert(assembled.startsWith('You are Quill, '), `${seed.key}: assembles after the identity opener`);
    assert(!assembled.includes('submit_for_review'), `${seed.key}: assembled prompt never mentions the submit tool`);
  }
  assert(CHAT_PERSONA_SEEDS[0].persona === CHAT_PERSONA_DEFAULT, 'neutral seed is the module default');
}

// 4. Provenance: the prompt version moved here with the m4 change.
assert(mod.CHAT_PROMPT_VERSION === 'm4-v1', 'prompt version records m4-v1');

console.log(failed ? `chat-persona: ${failed} FAIL(s)` : 'chat-persona: PASS');
process.exit(failed ? 1 : 0);
