// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Confirm } = require("enquirer");

export const confirmPrompt = async (
  message: string,
  _options?: object,
): Promise<boolean> => {
  const options = _options ?? {};

  const prompt = new Confirm({
    header: " ",
    name: "confirmation",
    message,
    format() {
      return (
        /^[ty1]/i.test(prompt.input)
          ? prompt.initial
            ? "Y"
            : "y"
          : prompt.initial
          ? "n"
          : "N"
      ).grey;
    },
    ...options,
  });

  const confirmation = await prompt.run().catch((err: any) => {
    return false;
  });

  return confirmation;
};

export const confirmPromptExit = async (
  message: string,
  _options?: object,
): Promise<boolean | undefined> => {
  const options = _options ?? {};

  const prompt = new Confirm({
    header: " ",
    name: "confirmation",
    message,
    format() {
      return (
        /^[ty1]/i.test(prompt.input)
          ? prompt.initial
            ? "Y"
            : "y"
          : prompt.initial
          ? "n"
          : "N"
      ).grey;
    },
    ...options,
  });

  const confirmation = await prompt.run().catch((err: any) => {
    return undefined;
  });

  return confirmation;
};

export const confirmPromptCatchRetry = async (message: string) => {
  const confirm = await confirmPrompt(` `, {
    default: `${message}(press ENTER to continue.)`,
    initial: true,
    format() {
      return " ";
    },
  });
  if (confirm) {
    return true;
  }
  return false;
};

export const confirmPromptCatchMessage = async (message: string) => {
  await confirmPrompt(` `, {
    default: `${message}(press ENTER to continue.)`,
    format() {
      return " ";
    },
    initial: true,
  });

  return false;
};

export const confirmPromptCatch = async (err: any) => {
  return false;
};
