declare module "terminal-kit" {
  interface Terminal {
    (text: string, ...args: unknown[]): Terminal;

    // Dimensions
    width: number;
    height: number;

    // Cursor control
    clear(): Terminal;
    moveTo(x: number, y: number, text?: string, ...args: unknown[]): Terminal;
    eraseLine(): Terminal;
    hideCursor(): Terminal;
    showCursor(): Terminal;

    // Colors
    red: Terminal;
    green: Terminal;
    yellow: Terminal;
    blue: Terminal;
    cyan: Terminal;
    magenta: Terminal;
    white: Terminal;
    gray: Terminal;
    black: Terminal;
    brightRed: Terminal;
    brightGreen: Terminal;
    brightYellow: Terminal;
    brightBlue: Terminal;
    brightCyan: Terminal;
    brightMagenta: Terminal;
    brightWhite: Terminal;

    // Background colors
    bgRed: Terminal;
    bgGreen: Terminal;
    bgYellow: Terminal;
    bgBlue: Terminal;
    bgCyan: Terminal;
    bgMagenta: Terminal;
    bgWhite: Terminal;
    bgBlack: Terminal;

    // Styles
    bold: Terminal;
    underline: Terminal;
    italic: Terminal;
    dim: Terminal;
    inverse: Terminal;
    strikethrough: Terminal;

    // Input
    grabInput(options: boolean | { mouse?: boolean }): void;
    on(event: "key", callback: (key: string, matches: string[], data: unknown) => void): void;
    on(event: "resize", callback: (width: number, height: number) => void): void;
    on(event: string, callback: (...args: unknown[]) => void): void;
  }

  export const terminal: Terminal;
}
