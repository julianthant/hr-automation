import pc from "picocolors";

export const log = {
  step: (msg: string): void => {
    console.log(pc.blue("->") + " " + msg);
  },
  success: (msg: string): void => {
    console.log(pc.green("\u2713") + " " + msg);
  },
  waiting: (msg: string): void => {
    console.log(pc.yellow("\u231B") + " " + msg);
  },
  error: (msg: string): void => {
    console.error(pc.red("\u2717") + " " + msg);
  },
};
