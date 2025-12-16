// Random subdomain generator

const ADJECTIVES = [
  "brave",
  "calm",
  "eager",
  "fancy",
  "gentle",
  "happy",
  "jolly",
  "kind",
  "lively",
  "merry",
  "nice",
  "proud",
  "quick",
  "sharp",
  "swift",
  "warm",
  "wise",
  "bold",
  "cool",
  "fresh",
];

const NOUNS = [
  "fox",
  "owl",
  "bear",
  "wolf",
  "hawk",
  "deer",
  "lynx",
  "seal",
  "crow",
  "dove",
  "frog",
  "goat",
  "hare",
  "lion",
  "mole",
  "moth",
  "newt",
  "pike",
  "slug",
  "swan",
];

function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomHex(length: number): string {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export function generateSubdomain(): string {
  const adjective = randomElement(ADJECTIVES);
  const noun = randomElement(NOUNS);
  const suffix = randomHex(4);
  return `${adjective}-${noun}-${suffix}`;
}
