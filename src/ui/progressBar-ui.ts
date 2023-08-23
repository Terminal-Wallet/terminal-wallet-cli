import { delay } from "@railgun-community/shared-models";

export const printLn = (singleLineDisplay: string) => {
  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(singleLineDisplay);
};
export class ProgressBar {
  currentText;
  currentCount = 0;
  running = false;
  constructor(initialText: string) {
    this.currentText = initialText;
    console.log(initialText);
  }

  complete = () => {
    this.running = false;
    this.currentCount = 0;
    console.log("");
  };

  runProgress = async (runLoop = true) => {
    if (!this.running) {
      return;
    }
    const bufferCount = (this.currentCount % 3) + 1;
    const bufferEnd = "".padEnd(bufferCount, ".");
    const newDisplay = this.currentText + bufferEnd;
    printLn(newDisplay);
    if (runLoop) {
      this.currentCount++;
      await delay(1000);
      this.runProgress();
    }
  };

  updateProgress = (message: string, progress: number): void => {
    this.currentText = `${message}  |  [${progress.toFixed(2)}%]`;
    if (!this.running) {
      this.running = true;
      this.runProgress();
    } else {
      this.runProgress(false);
    }
  };
}
