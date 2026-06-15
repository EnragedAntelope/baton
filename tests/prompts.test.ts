import { describe, expect, it } from 'vitest';
import readline from 'node:readline';
import { promptUser, confirmPrompt, PromptQuestion } from '../src/core/prompts.js';

/** Build a mock readline.Interface backed by a scripted input array. */
function makeRL(lines: string[]): readline.Interface {
  let index = 0;
  const rl = {
    question: (_prompt: string, callback: (answer: string) => void) => {
      callback(lines[index++] || '');
    },
    close: () => {},
    on: () => rl,
    once: () => rl,
    emit: () => false,
    [Symbol.dispose]: () => {},
  } as unknown as readline.Interface;
  return rl;
}

describe('promptUser', () => {
  it('accepts input and returns it keyed by question name', async () => {
    const rl = makeRL(['hello']);
    const questions: PromptQuestion[] = [
      { name: 'greeting', message: 'Say something' },
    ];
    const result = await promptUser(questions, rl);
    expect(result).toEqual({ greeting: 'hello' });
  });

  it('uses the default value when user presses Enter', async () => {
    const rl = makeRL(['']); // empty input → use default
    const questions: PromptQuestion[] = [
      { name: 'name', message: 'Your name', default: 'Alice' },
    ];
    const result = await promptUser(questions, rl);
    expect(result).toEqual({ name: 'Alice' });
  });

  it('re-prompts when validation fails, then accepts valid input', async () => {
    // First input is invalid ("abc"), second is valid ("42")
    const rl = makeRL(['abc', '42']);
    const questions: PromptQuestion[] = [
      {
        name: 'port',
        message: 'Port number',
        validate: (v: string) => (/^\d+$/.test(v) ? true : 'Must be a number'),
      },
    ];
    const result = await promptUser(questions, rl);
    expect(result).toEqual({ port: '42' });
  });

  it('asks multiple questions in sequence', async () => {
    const rl = makeRL(['first', 'second']);
    const questions: PromptQuestion[] = [
      { name: 'a', message: 'First' },
      { name: 'b', message: 'Second' },
    ];
    const result = await promptUser(questions, rl);
    expect(result).toEqual({ a: 'first', b: 'second' });
  });
});

describe('confirmPrompt', () => {
  it('returns true for "y" input', async () => {
    const rl = makeRL(['y']);
    const result = await confirmPrompt('Continue?', true, rl);
    expect(result).toBe(true);
  });

  it('returns false for "n" input', async () => {
    const rl = makeRL(['n']);
    const result = await confirmPrompt('Continue?', true, rl);
    expect(result).toBe(false);
  });

  it('returns defaultYes=true when user presses Enter', async () => {
    const rl = makeRL(['']);
    const result = await confirmPrompt('Continue?', true, rl);
    expect(result).toBe(true);
  });

  it('returns defaultYes=false when user presses Enter', async () => {
    const rl = makeRL(['']);
    const result = await confirmPrompt('Continue?', false, rl);
    expect(result).toBe(false);
  });

  it('re-prompts on invalid input before accepting y/n', async () => {
    const rl = makeRL(['maybe', 'yes']);
    const result = await confirmPrompt('Continue?', true, rl);
    expect(result).toBe(true);
  });
});
