import { Scorer } from "./base.js";

/**
 * A simple scorer that compares numbers by computing the percentage difference of the smaller number
 * from the larger one.
 */
export const NumericDiff: Scorer<number, {}> = (args) => {
  const { output, expected } = args;

  if (expected === undefined) {
    throw new Error("NumericDifference requires an expected value");
  }

  const score =
    output === 0 && expected === 0
      ? 1
      : 1 -
        Math.abs(expected - output) /
          Math.max(Math.abs(expected), Math.abs(output));

  return {
    name: "NumericDiff",
    score,
  };
};
