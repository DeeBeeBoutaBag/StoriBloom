import { openai, OPENAI_MODEL } from './openaiClient.js';

// Example inside an Express route
app.post('/ai/example', async (req, res) => {
  const { userPrompt } = req.body || {};
  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.6,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: userPrompt || 'Hello!' },
      ],
    });
    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.error('[openaiClient] error:', err);
    res.status(500).json({ error: 'openai_error' });
  }
});
