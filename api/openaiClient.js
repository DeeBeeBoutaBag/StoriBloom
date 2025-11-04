import OpenAI from 'openai';
import 'dotenv/config';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
