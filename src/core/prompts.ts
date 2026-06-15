import readline from 'node:readline';

export interface PromptQuestion {
  name: string;
  message: string;
  default?: string;
  validate?: (value: string) => true | string;
}

/**
 * Prompt the user for answers via readline. Each question is asked in sequence;
 * if a validator is provided, the prompt repeats until the answer passes.
 *
 * An optional readline.Interface can be injected for testing.
 */
export async function promptUser(
  questions: PromptQuestion[],
  rl?: readline.Interface,
): Promise<Record<string, string>> {
  const interface_ =
    rl ??
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

  const results: Record<string, string> = {};

  try {
    for (const q of questions) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const promptText = q.default ? `${q.message} (${q.default}): ` : `${q.message}: `;
        const answer = await new Promise<string>((resolve) => {
          interface_.question(promptText, (input) => resolve(input.trim()));
        });

        const value = answer || q.default || '';

        if (q.validate) {
          const validation = q.validate(value);
          if (validation !== true) {
            console.log(validation);
            continue;
          }
        }

        results[q.name] = value;
        break;
      }
    }
  } finally {
    interface_.close();
  }
  return results;
}

/**
 * Ask a yes/no question. Returns true for "y" or "yes", false for "n" or "no".
 * Re-prompts on any other input. An optional readline.Interface can be injected
 * for testing.
 */
export async function confirmPrompt(
  message: string,
  defaultYes = false,
  rl?: readline.Interface,
): Promise<boolean> {
  const interface_ =
    rl ??
    readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

  const promptText = `${message} [${defaultYes ? 'Y/n' : 'y/N'}]: `;

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answer = await new Promise<string>((resolve) => {
        interface_.question(promptText, (input) => resolve(input.trim().toLowerCase()));
      });

      if (!answer) return defaultYes;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;

      console.log('Please answer "y" or "n".');
    }
  } finally {
    interface_.close();
  }
}
