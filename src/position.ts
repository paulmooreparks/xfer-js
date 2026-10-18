import type { Position } from "./types";
import { utf8Length } from "./unicode";

export const ORIGIN: Position = Object.freeze({ offset: 0, line: 1, column: 1 });

/**
 * The position of a UTF-16 index in a string whose line endings are already LF: the UTF-8 byte
 * offset, and the line and column (in scalar values) counted from 1. This walks the text from
 * the start, so it is for rare diagnostics; the lexer tracks its position as it advances.
 */
export function positionAt(text: string, index: number): Position {
  let offset = 0;
  let line = 1;
  let column = 1;
  let i = 0;
  while (i < index) {
    const cp = text.codePointAt(i) ?? 0;
    i += cp > 0xffff ? 2 : 1;
    offset += utf8Length(cp);
    if (cp === 0x0a) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { offset, line, column };
}
