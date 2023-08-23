import { isDefined } from "@railgun-community/shared-models";

type Status = { message: string; duration: number; timestamp: number };

const currentStatus: {
  current: Optional<Status>;
  queue: Status[];
} = {
  current: undefined,
  queue: [],
};

export const getStatusText = () => {
  if (isDefined(currentStatus.current)) {
    const { timestamp, duration } = currentStatus.current;
    if (isDefined(timestamp)) {
      const difference = Date.now() - timestamp;
      if (difference > duration) {
        currentStatus.current = currentStatus.queue.shift();
        if (isDefined(currentStatus.current)) {
          currentStatus.current.timestamp = Date.now();
        }
      } else {
        return currentStatus.current.message;
      }
    }
  } else {
    currentStatus.current = currentStatus.queue.shift();
    if (isDefined(currentStatus.current)) {
      currentStatus.current.timestamp = Date.now();
      return currentStatus.current.message;
    }
  }
  return "";
};

export const setStatusText = (status: string, duration: number = 15000) => {
  currentStatus.queue.push({
    message: status,
    duration,
    timestamp: 0,
  });
};

export const testStatus = () => {
  let count = 0;
  const intervalID = setInterval(() => {
    count++;
    setStatusText(`the count is ${count}`);
  }, 5 * 1000);

  setTimeout(() => {
    clearInterval(intervalID);
  }, 60 * 1000);
};
