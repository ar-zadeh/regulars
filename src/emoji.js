// Emoji can include modifiers, joiners, flags and keycaps (Unicode UTS #51):
// https://www.unicode.org/reports/tr51/
// Match keycaps as sequences so ordinary numbers, # and * remain text.
const emojiParts = /(?:[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier})/gu;
const emojiFormatting = /^[\s\uFE0E\uFE0F\u200D\u{E0020}-\u{E007F}]*$/u;

export function isEmojiOnly(text) {
  const value = String(text ?? '').trim();
  const remainder = value.replace(emojiParts, '');
  return remainder !== value && emojiFormatting.test(remainder);
}
